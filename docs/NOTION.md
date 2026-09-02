# Notion integration — design

**Goal:** the moment a syllabus is uploaded, the student gets a finished Notion
page for that class — course info, grading, every deadline, study sessions, and
policies — without building any of it by hand. Re-uploading or re-syncing keeps
it current without trampling their own notes.

This document is the spec the implementation is built from. Where it makes a
judgment call, the reasoning is written down so it can be revisited.

## What gets created in the user's workspace

Notion pages cannot be created at the workspace root through the API — every
page needs a parent. So the user shares one page with us during OAuth, and we
build a self-contained hub underneath it:

```
<page the user shared>
└── 📚 Syllabus AI                       hub page, created once
    ├── Courses          (database)     one row per class — the "class page"
    ├── Assignments      (database)     one row per deadline, related to Courses
    └── Study Sessions   (database)     one row per planned block, related to both
```

### Why three related databases rather than one page per class with its own tables

A per-class database is the obvious first idea and it is the wrong one. It
gives a tidy page per class and nothing across classes — no "what is due this
week across all five courses", which is the exact question this product exists
to answer. Central databases with a `Course` relation give both: filter by
course for the class view, filter by date for the semester view. This is also
just how Notion is meant to be used; it is what a Notion power user would build
by hand.

### The "class page" is a Courses row

In Notion a database row *is* a page, so the Courses row for MATH 221 has
properties (code, instructor, term, meeting times) **and** a full page body.
The body is the deliverable — what the student would otherwise spend an evening
making:

```
💡 Synced from Syllabus AI on Sep 2. Properties stay current on re-sync;
   everything below the divider is yours and is never touched.

## Course info
Instructor · Dr. Elena Vasquez · e.vasquez@northbridge.edu
Meets      · MWF 10:00–10:50, Hayes Hall 210 · Thu 9:00–9:50, Hayes Hall 104
Term       · Fall 2026 · Aug 24 – Dec 18

## Grading
┌────────────────────────────┬──────┐
│ Problem Sets (7)           │ 24%  │
│ Midterm Exam 1             │ 18%  │
│ …                          │      │
└────────────────────────────┴──────┘

## Schedule
• Sep 4   Problem Set 1                 → mention link to the Assignments row
• Oct 7   Midterm Exam 1  · 18%         → …
• …

## Policies
▸ Late work     (toggle — collapsed, the text is long)
▸ Attendance
▸ Academic integrity

──────────────────────────────────────

## Your notes
(empty — this is the student's space)
```

Schedule entries are `mention` links to the real Assignments rows, so the list
on the class page is a table of contents into live data, not a second copy of
it. Status ("Done") lives in exactly one place — the Assignments row.

### Database schemas

**Courses**

| Property | Type | Notes |
|---|---|---|
| Name | title | `MATH 221 — Multivariable Calculus` |
| Code | rich_text | `MATH 221` |
| Instructor | rich_text | |
| Term | rich_text | `Fall 2026` |
| Dates | date (range) | term start → end |
| Meets | rich_text | `MWF 10:00–10:50 · Hayes 210` |
| Syllabus AI ID | rich_text | our course id — recovery key if links are lost |

**Assignments**

| Property | Type | Notes |
|---|---|---|
| Name | title | |
| Course | relation → Courses | |
| Type | select | Assignment · Exam · Quiz · Project · Reading · Lab · Presentation · Other |
| Due | date | includes time when the syllabus gave one |
| Weight | number (percent) | from the grading-table join |
| Status | select | Not started · In progress · Done — set to "Not started" on create |
| Est. hours | number | the planner's estimate, so the row explains its own cost |
| Needs review | checkbox | true when extraction confidence < 0.6 |
| Syllabus AI ID | rich_text | |

**Study Sessions**

| Property | Type | Notes |
|---|---|---|
| Name | title | `Review 2/4 — MATH 221 Midterm Exam 1` |
| Course | relation → Courses | |
| Assignment | relation → Assignments | |
| When | date (start + end datetime) | |
| Why | rich_text | the planner's rationale, verbatim |
| Done | checkbox | |
| Syllabus AI ID | rich_text | |

### The calendar

The API cannot create or modify database **views** — only properties and rows.
So we cannot ship a Calendar view pre-made. What we can do is make it a
one-click addition: every dated row has a proper `date` property, so in the
Assignments or Study Sessions database the student clicks **+ Add view →
Calendar** and gets a working semester calendar immediately. The hub page says
this in one line. It is the one manual step in the whole flow, and it is
Notion's limitation, not ours.

(The Google Calendar sync remains the "real" calendar; Notion's is the planning
surface.)

## Authentication

Notion public-integration OAuth 2.0:

1. `GET /api/notion/auth` → redirect to `https://api.notion.com/v1/oauth/authorize`
   with `owner=user`, `response_type=code`, a CSRF `state` cookie (same pattern
   as Google).
2. The consent screen is where the user **picks which pages to share**. We ask
   for one — the page the hub should live under.
3. `GET /api/notion/callback` exchanges the code at `POST /v1/oauth/token`
   using HTTP Basic auth (`client_id:client_secret`). The response carries
   `access_token`, `workspace_id`, `workspace_name`, `bot_id`.
4. **Notion access tokens do not expire** and there is no refresh token. They
   die only when the user revokes the integration, which surfaces as a 401 —
   we mark the connection broken and prompt a reconnect.

The token is a bearer secret with the same sensitivity as the Google refresh
token: stored on the connection record, never logged (`log.ts` redacts
`*token*` keys), never sent to the browser.

### Choosing the parent page

After the token exchange we `POST /v1/search` for pages the integration can
see. Three cases:

- **exactly one** → create the hub under it immediately. This is the common
  path; the consent screen nudges people toward picking one page.
- **several** → `GET /api/notion/status` returns `needsParent: true` with the
  candidates; the dashboard shows a picker; `POST /api/notion/parent` creates
  the hub under the choice.
- **none** → the user shared nothing usable. Status says so and explains how to
  share a page with the integration from inside Notion.

## Sync semantics

`syncToNotion(userId, { courses, assessments, studyBlocks, dryRun })` mirrors
`syncToCalendar` exactly, on purpose — the same shape, the same `dryRun`
contract, the same result envelope. Anyone who understands one understands
the other.

**Idempotent by construction.** A `notion_links` table maps every one of our
entities (`course` / `assessment` / `session` + id) to its Notion page id.
Existing link → `PATCH` the page's properties. No link → `POST` a page and
record it. A 404 on `PATCH` (the user deleted the page) → create fresh and
re-link. Syncing twice never duplicates.

**Re-sync updates properties, not page bodies.** The class page body is written
when the Courses row is created and then left alone. Rewriting it would mean
deleting and re-appending blocks around whatever the student has added, which
is exactly the kind of destructive cleverness that loses someone's notes. The
data that actually moves — due dates, weights, titles — lives in Assignments
properties, which *are* updated, and the body's schedule list links to those
rows. So the class page stays a correct table of contents even when a date
shifts. Documented as a known limit; revisit if users ask for it.

**Auto-sync on upload.** `POST /api/upload` already returns the parsed course;
when Notion is connected it now also syncs that course (page + assignments +
study sessions) before responding, and reports the page URL in the response.
Roughly 40 requests at Notion's ~3 req/s is ~13 seconds — inside the route's
budget. Notion failing must never fail the upload: it is reported in a
`notion` field on the response, not thrown.

**Rate limiting.** Notion allows an average of 3 requests/second per
integration. The client throttles to that, honours `Retry-After` on 429, and
retries 5xx with backoff. Per-user, `/api/notion/sync` gets its own rule in
`ratelimit.ts` so a mashed button cannot burn the whole integration's quota.

**Dry run.** Without `NOTION_CLIENT_ID`/`SECRET` the integration is
unconfigured and sync reports exactly what it *would* create, computed by the
same planning code as the real path — the demo tells the truth, consistent with
calendar.

## Storage additions

```ts
interface NotionConnection {
  userId: string;
  accessToken: string;          // bearer secret; never leaves the server
  workspaceId: string;
  workspaceName: string | null;
  botId: string | null;
  parentPageId: string | null;  // what the user shared; null until chosen
  hubPageId: string | null;     // null until the hub is built
  hubUrl: string | null;
  coursesDbId: string | null;
  assignmentsDbId: string | null;
  sessionsDbId: string | null;
  status: "connected" | "needs_parent" | "revoked";
  connectedAt: string;
}

type NotionLinkKind = "course" | "assessment" | "session";
```

Store methods: `getNotionConnection`, `setNotionConnection`,
`deleteNotionConnection`, `getNotionLink(kind, id)`, `setNotionLink(kind, id,
pageId)`, `listNotionLinks(userId)`. Schema: `notion_connections` (PK user_id),
`notion_links` (PK kind + entity_id, cascade from the owning row).

## API

| Route | Method | Purpose |
|---|---|---|
| `/api/notion/auth` | GET | redirect to Notion consent |
| `/api/notion/callback` | GET | token exchange → `/dashboard?notion=connected` |
| `/api/notion/status` | GET | `{ configured, connected, status, workspaceName, hubUrl, needsParent, candidates[] }` |
| `/api/notion/parent` | POST | `{ pageId }` → builds the hub |
| `/api/notion/sync` | POST | `{ courseId? }` → `NotionSyncResult` |
| `/api/notion/disconnect` | POST | drops the connection (does not delete anything in Notion) |

Env: `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET`,
`NOTION_REDIRECT_URI` (default `http://localhost:3000/api/notion/callback`).

## Dashboard

A **Notion** panel beside Calendar sync: connect / pick a parent page / "Open
in Notion" once the hub exists / sync button with the created-updated-skipped
result / disconnect. Each course in the roadmap gets an "Open in Notion" link
when its page exists. The upload result shows "Created your Notion page →" on
success and a quiet, non-blocking note if Notion failed.

## What this deliberately does not do (yet)

- **Rewrite class-page bodies on re-sync** — see above.
- **Create Calendar views** — API limitation; one click for the user.
- **Two-way sync.** Marking something Done in Notion does not flow back. The
  app is the source of truth for dates; Notion is the source of truth for
  status. Pulling status back is the obvious next step and the `Syllabus AI ID`
  property on every row is what makes it possible.
- **Delete Notion pages when a course is deleted here.** Disconnect and course
  deletion leave Notion untouched — deleting someone's notes is not a decision
  software should make for them.
