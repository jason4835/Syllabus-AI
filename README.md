# Syllabus AI

**Upload your syllabus. Let AI organize your semester in 60 seconds.**

Upload your syllabi, AI builds your semester plan, syncs your calendar, and
creates a living study system.

Built for college and grad students who use Google Calendar and feel overloaded
every semester.

## What it does

1. **Sign in with Google** — one consent screen covers identity and calendar write access.
2. **Upload a syllabus PDF** — AI extracts courses, assignments, exams, due dates, grading weights, and key policies.
3. **Check what it found** — anything extracted with low confidence is flagged; one click confirms it, and every item can be edited (title, type, date, time, weight) right in the list. Fixes flow into the plan and the next calendar or Notion sync.
4. **Get a semester roadmap** — week-by-week workload with recommended study blocks.
5. **Sync to Google Calendar** — deadlines and study sessions land on a dedicated "Syllabus AI" calendar, not your primary one.
6. **Get a Notion page per class** — connect Notion and every upload also produces a finished class page (course info, grading, schedule, policies) plus Assignments and Study Sessions databases you can view as a calendar. Nobody builds a Notion setup by hand again.

### The parts that aren't just a PDF-to-calendar pipe

- **Workload heatmap** — every week scored by estimated hours, not deadline count, so a 30%-weight final outranks three quizzes. Crunch weeks get flagged before you walk into them.
- **Spaced study blocks** — exams get back-scheduled sessions at D-10, D-6, D-3, D-1 instead of one doomed cram block, worked around your class meeting times and a daily study cap.
- **Smart re-planning** — when a date moves, the plan rebuilds and tells you what shifted and why.
- **Natural-language chat** — "When should I start studying for Calc midterm?", grounded in your actual extracted dates.

## Run it

```bash
npm install && npm run dev
```

Open http://localhost:3000 and click **Try the demo**. It works with **zero
configuration** — three bundled sample syllabi, heuristic parsing, local JSON
storage in `.data/`, and a dry-run calendar sync that reports exactly what it
*would* create. The sample courses deliberately collide in mid-October, so the
heatmap has a real crunch week to warn you about.

To reset the demo back to a clean state, delete `.data/` and reload.

## Going live

Copy `.env.example` to `.env.local` and fill in what you want:

| Set this | To unlock |
|---|---|
| `OPENAI_API_KEY` | Real AI extraction instead of the heuristic fallback |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google sign-in and real calendar writes |
| `NOTION_CLIENT_ID` / `NOTION_CLIENT_SECRET` | Notion class pages. Create a *public* integration at notion.so/my-integrations and add `<origin>/api/notion/callback` as its redirect URI |
| `SESSION_SECRET` | Signed sessions (`openssl rand -hex 32`). **Required in production** — without it the app refuses to serve requests, because the dev fallback is a published constant |
| `DATA_DIR` | Durable storage on a mounted volume — the JSON store writes to `$DATA_DIR/db.json`. Single instance only |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Postgres instead of local JSON — run `supabase/schema.sql` first. Needed once you run more than one instance |

For Google: create a **Web application** OAuth client, enable the **Google
Calendar API**, and add `http://localhost:3000/api/auth/callback` as an
authorized redirect URI.

Each capability degrades independently — an OpenAI key with no Google
credentials gives you real extraction and a dry-run sync.

**Deploying it for other people to use? Read [docs/DEPLOY.md](docs/DEPLOY.md)**,
which covers the Google OAuth verification traps, why Supabase is mandatory on
serverless, and cost control. `GET /api/health` tells you whether a running
deploy is actually wired up correctly (`degraded` when it isn't).

## Architecture

```
src/
  app/
    page.tsx           Landing page
    dashboard/         Upload, upcoming, heatmap, roadmap, sync, chat
    api/               Route handlers (see docs/API.md)
  lib/
    types.ts           Frozen domain contract — every layer speaks these types
    session.ts         Signed HMAC cookie sessions; hard-fails in production
                       without a real SESSION_SECRET
    ratelimit.ts       Per-user + global caps on the LLM and sync routes
    log.ts             Structured logging with credential redaction
    health.ts          What GET /api/health reports
    weights.ts         Joins the grading table onto individual assessments
    store/             Supabase driver + local JSON driver, chosen by env
    parse/             PDF -> text -> AI structured extraction, with a
                       deterministic heuristic fallback
    plan/              Workload model, spaced study scheduling, chat
    google/            OAuth and idempotent calendar sync
    notion/            OAuth, hub + databases, idempotent page sync
                       (design: docs/NOTION.md)
supabase/schema.sql    Postgres DDL with RLS
fixtures/              Three sample syllabi used by demo mode
docs/API.md            API contract
docs/DEPLOY.md         Deploying it for real users
```

Two design choices worth naming:

- **`src/lib/types.ts` is the contract.** Parsing, storage, planning, calendar
  sync, and UI all speak those types and nothing else. It's why the pieces were
  buildable independently.
- **The planner is pure.** No DB, no network (except the optional chat call) —
  data in, plan out. That's what makes the workload model testable.

## Known scope limits

- Scanned/image-only PDFs are rejected with a clear message rather than silently
  producing an empty plan — there's no OCR pass yet.
- The heuristic fallback parser (demo mode, or when OpenAI is unreachable) reads
  at most one dated item per line, taking the title from before the first date
  and the due date from the last. A schedule row listing two deliverables will
  lose one. The AI extractor handles those correctly, so this only bites without
  an `OPENAI_API_KEY` — but keep it in mind if you edit the bundled fixtures.
- Notion sync is one-way and updates row *properties* on re-sync, never a
  class page's body — so your notes on that page are safe, but a schedule
  entry written into the body will not move if a date later changes (the
  Assignments row it links to does). Notion's API cannot create Calendar
  views; adding one is a single click in the Assignments database. Deleting a
  course here never deletes anything in Notion. See docs/NOTION.md.
- Sessions are a signed cookie, not a full auth provider. That is sound for this
  scale — it fails closed on a tampered cookie and refuses to run in production
  without a real `SESSION_SECRET` — but swap in Clerk or Auth.js if you need
  org accounts, MFA, or account recovery.
- The volume-backed JSON store assumes a **single instance**: one file guarded
  by an in-process lock. Two replicas sharing a volume would overwrite each
  other's writes. Move to Supabase before scaling out.
- Rate limits are held in memory, so on serverless they are per-instance and
  reset on a cold start. They make casual abuse annoying rather than free; the
  real spend ceiling is the hard limit you set on your OpenAI account.
- Account deletion is total and immediate (courses, deadlines, plan, calendar
  and Notion links, the account itself). It never deletes Notion pages, and
  removes the Google "Syllabus AI" calendar only if the user ticks that box.
- When a syllabus states no term dates, week numbering is *inferred* from its
  term label ("Fall 2026" → late August start) and the heatmap says so. With
  neither dates nor a label, weeks are anchored to the first deadline.
- Calendar events use each user's browser-reported timezone, captured on first
  dashboard load. A user who signs in and never opens the dashboard before
  syncing would get the server's zone.

## License

Copyright © 2026 Jason Paz. Licensed under the
[GNU Affero General Public License v3.0](LICENSE).

In plain terms:

- **You may** read it, fork it, modify it, run it yourself, and contribute back.
- **You must** release your source under the same license if you distribute a
  modified version **or run one as a network service**. That network clause is
  the difference between AGPL and GPL, and it is the point: this is a hosted
  app, so "I only run it, I don't ship it" would otherwise be a way around the
  license entirely.
- **The idea is not covered.** Copyright protects this code, not the concept of
  turning a syllabus into a calendar. Build your own — just don't take this one
  closed-source.

If you deploy a modified copy, AGPL section 13 requires that your users can get
your source. The footer's "Source" link is how this deployment satisfies that —
if you fork it, point that link at *your* repository.

Want to use it under different terms? The copyright is mine alone, so I can dual
license it. Open an issue.
