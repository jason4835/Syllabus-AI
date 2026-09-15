# API contract

Every route returns `ApiResult<T>` from `src/lib/types.ts`:
`{ ok: true, data: T }` or `{ ok: false, error: string, detail?: string }`.
Non-2xx responses still use this shape.

| Route | Method | Body / Query | `data` on success |
|---|---|---|---|
| `/api/auth/google` | GET | — | redirect to Google consent (not JSON) |
| `/api/auth/callback` | GET | `code`, `state` | redirect to `/dashboard` (not JSON) |
| `/api/auth/logout` | POST | — | `{ ok: true }` |
| `/api/me` | GET | — | `User \| null` |
| `/api/me/timezone` | POST | `{ timezone: string }` (IANA zone) | `User` |
| `/api/me/calendar-prefs` | PATCH | `Partial<CalendarPrefs>` | `CalendarPrefs` — what the Google sync and the feed include; persisted per user. Unknown keys **422**. |
| `/api/me/feed` | GET | — | `{ url: string \| null; webcal: string \| null }` — the user's private calendar-feed URL as https and as webcal, or nulls if none yet |
| `/api/me/feed` | POST | `{ reset?: true }` | `{ url: string; webcal: string }` — creates the feed token, or with `reset` replaces it (old URL stops working immediately) |
| `/api/feed/[token].ics` | GET | — | `text/calendar` — **unauthenticated by design**; the token is the credential. Deadlines, study sessions, and class meetings for the whole term. 404 for an unknown token. Rate limited per token. |
| `/api/me` | DELETE | `{ confirm: "DELETE"; removeGoogleCalendar?: boolean }` | `{ deleted: true; googleCalendarRemoved: boolean }` — erases the account and every course, assessment, link and connection; clears the session. Notion pages are never touched. **400** unless `confirm` is exactly `"DELETE"`; **403** for the shared demo account. |
| `/api/health` | GET | — | `{ status; version; commit; uptimeSeconds; time; capabilities; storage; warnings }` |
| `/api/config` | GET | — | `{ demoMode: boolean; googleReady: boolean; openaiReady: boolean; billing: { ready: boolean; termPass: { name: string; amountCents: number; currency: string; display: string; oneTime: true } } }` — `billing.ready` is `true` only when `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_TERM_PASS_PRICE_ID` are all set; `termPass` is the display copy for the paywall (amount and currency read back from Stripe-adjacent config, never hardcoded) regardless of `ready`, so the UI can show a disabled "not configured" version of the same copy. |
| `/api/upload` | POST | `multipart/form-data`, field `file` (PDF); optional fields `replace` (course id), `allowDuplicate` (`1`), `termId` (file the parsed course under an existing term) or `newTerm` (`{ name; termType; startDate; endDate }` to create one first) | `{ courseId: string; course: Course; assessments: Assessment[]; warnings: string[]; replaced: string \| null }` — **409** `{ duplicateOf: { id; code; title; term } }` when the parsed course matches an existing one by code (case/space-insensitive) and term, unless `replace=<thatId>` (the old course and its assessments are deleted after the new one is saved; `replaced` carries the old id) or `allowDuplicate=1`. If neither `termId` nor `newTerm` is given, the server infers or creates a term itself (see `docs/TERM-PASS.md`). **402** — see "The Term Pass paywall" below — when the resolved term already holds its free course and is not premium; the parse still happened and the term is still created/resolved, so retrying with the same term after purchase does not re-spend a parse. |
| `/api/courses` | GET | — | `{ courses: Course[]; assessments: Assessment[] }` — each `Course` now carries `termId: string | null`; the legacy `term` text field stays as a display fallback for a course with no term row. |
| `/api/courses/[id]` | PATCH | `{ code?; title?; instructor?; term?; termId?; startDate?; endDate?; sections?: string[]; meetingTimes?: MeetingTime[] }` | `Course` — edit course details, including the term window the heatmap numbers weeks from. Dates `YYYY-MM-DD` or null; `endDate` must not precede `startDate`; **422** names the field; **404** if not the caller's. `termId` moves the course to that term (must be the caller's); **402** — see below — when the target term already holds its free course and is not premium. `sections` is the set of section labels the student is in — at most one per question the syllabus asks (a course with two lectures and three labs asks two), reconciled server-side against the labels the syllabus actually names. The legacy singular `section` is still accepted as a one-element array. A `meetingTimes` row may carry `startTime` and `endTime` **both blank** (`""`), which is how a meeting the syllabus gave days but no time for is stored — one blank and one set is **422**. Setting `startDate` also dates this course's undated week-numbered items ("End of Week 10"), at `confidence: 0.6` and with a note saying the placement was inferred; the response is still the `Course`, so refetch the items. |
| `/api/courses/[id]` | DELETE | — | `{ deleted: true; calendarEventsRemoved: number }` — also deletes the Google events this course created, so nothing is orphaned. |
| `/api/courses/[id]/assessments/[assessmentId]/expand` | POST | `{ weekday: 0..6; time?: "HH:MM" \| null }` | `{ created: number; deleted: string }` — turns one undated weekly rule ("due each Sunday at 11:59PM") into one dated item per week of the term on the chosen weekday, then deletes the placeholder and its calendar/Notion links. `weekday` is 0 = Sunday; `time` overrides the item's own `dueTime`, and omitting it (or null) keeps whatever the syllabus stated. Weeks wholly inside a no-class period are skipped. **422** when the course has no term start and end (nothing to count weeks from) or when the term window is longer than 80 weeks; **404** when the course or the item is not the caller's. |
| `/api/courses/[id]/assessments` | POST | `{ title; kind; dueDate?; dueTime?; endTime?; weightPercent?; notes? }` | `Assessment` — add an item the extractor missed. Created with `confidence: 1` and `reviewedAt` set (a person typed it). Same field rules as PATCH assessments; `title` and `kind` required. |
| `/api/assessments/[id]` | DELETE | — | `{ deleted: true }` — removes the item and its calendar/Notion links. **404** if not the caller's. |
| `/api/assessments/[id]` | PATCH | `{ title?; kind?; dueDate?; dueTime?; endTime?; weightPercent?; notes?; reviewed?: true }` | `Assessment` — confirm and edit share this route. Any accepted change (including `reviewed: true` alone) sets `reviewedAt`, which clears the review flag. **422** with a field-level `detail` on invalid input; **404** when the item is not the caller's. Dates `YYYY-MM-DD` or null, times `HH:MM` or null (`endTime` requires `dueTime` and must be later), weight 0–100 or null. |
| `/api/terms` | GET | — | `{ terms: (AcademicTerm & { courseCount: number; access: "free" \| "premium" \| "expired" })[] }` — every term the caller owns. `access` is `"premium"` while the term's grace period (14 days past its end date) hasn't run out, `"expired"` for a term that was premium and now is past that, `"free"` otherwise. |
| `/api/terms` | POST | `{ name; termType; startDate; endDate }` | `AcademicTerm` — creates a term. `termType` is one of `semester`, `quarter`, `trimester`, `summer`, `winter`, `j_term`, `custom` (a label only; it sets no dates itself). Validated server-side: dates `YYYY-MM-DD`, `endDate` after `startDate`, span at most 183 days. **422** names the invalid field. |
| `/api/terms/[id]` | PATCH | `{ name?; termType?; startDate?; endDate?; confirmed?: true }` | `AcademicTerm` — edits name/type/dates, or confirms a term the server inferred from a syllabus (sets `confirmedAt`). On a term that is already premium, a new `endDate` may not push the term past 183 days total or push the resulting `premiumExpiresAt` more than 30 days beyond what was already paid for (`paidEndDate + 14 + 30`); shortening the term is always allowed and moves the expiry earlier. `startDate` edits cannot move the end. **422** names the field; **404** if not the caller's. |
| `/api/terms/[id]` | DELETE | — | `{ deleted: true }` — only when the term holds no courses. **409** if it still does; **404** if not the caller's. |
| `/api/terms/[id]/checkout` | POST | — | `{ url: string }` — creates a Stripe Checkout Session (`mode: "payment"`, one line item of `STRIPE_TERM_PASS_PRICE_ID`, `client_reference_id` and `metadata` set to the term and user) and returns its URL; the client redirects the browser there. Requires the caller to own the term, the term to be confirmed, and the term not already premium. **403** for the shared demo account — checkout needs a real Stripe customer, so the UI offers Google sign-in instead. **409** if already premium or not yet confirmed; **404** if not the caller's. |
| `/api/stripe/webhook` | POST | raw request body, `Stripe-Signature` header | `{ received: true }` — verifies the signature with `STRIPE_WEBHOOK_SECRET` (`stripe.webhooks.constructEvent`); a bad or missing signature is **400**. Records the event id in `stripe_events` for idempotency — a duplicate id is a no-op and still answers 200. On `checkout.session.completed` or `checkout.session.async_payment_succeeded` with `payment_status: "paid"`, grants premium to the term named in the session's own `metadata` (never trusted from anywhere else): sets `premium`, `premiumStartedAt`, `premiumExpiresAt = endDate + 14 days`, `paidEndDate`, and the Stripe ids. `checkout.session.expired` logs `analytics.term_checkout_abandoned` and grants nothing. Unrecognized event types are acknowledged and ignored. See `docs/DEPLOY.md` section 9 for the endpoint and signing-secret setup. |
| `/api/analytics` | POST | `{ event: string; fields?: Record<string, unknown> }` | `{ ok: true }` — logs one structured line (`analytics.<event>`) via `src/lib/analytics.ts`. `event` must be on the server's allow-list of funnel names; anything else is **422**. |
| `/api/plan` | GET | — | `SemesterPlan` |
| `/api/sync` | POST | `{ courseId?: string; dryRun?: boolean }` | `CalendarSyncResult` — honours `calendarPrefs`; removes events whose source was deleted or deselected; `needsSection` lists courses with at least one section question still unanswered (only that question's meetings are skipped, never guessed — an answered lecture still syncs while the lab question is open) |
| `/api/chat` | POST | `{ message: string; history?: {role,content}[] }` | `{ reply: string }` |
| `/api/notion/auth` | GET | — | redirect to Notion consent (not JSON) |
| `/api/notion/callback` | GET | `code`, `state` | redirect to `/dashboard?notion=connected` (not JSON) |
| `/api/notion/status` | GET | — | `NotionStatus` (below) |
| `/api/notion/parent` | POST | `{ pageId: string }` | `NotionStatus` — builds the hub under that page |
| `/api/notion/sync` | POST | `{ courseId?: string }` | `NotionSyncResult & { dryRun: boolean }` |
| `/api/notion/disconnect` | POST | — | `{ disconnected: true }` |

`POST /api/upload` additionally returns `notion: { pageUrl: string | null; hubUrl: string | null; error: string | null } | null`
— `null` when Notion is not connected; `error` set (and `pageUrl` null) when the
upload succeeded but the Notion page could not be created. Notion failing never
fails the upload.

```ts
interface NotionStatus {
  configured: boolean;            // NOTION_CLIENT_ID + SECRET present on the server
  connected: boolean;             // a connection record exists and is not revoked
  status: "connected" | "needs_parent" | "revoked" | null;
  workspaceName: string | null;
  hubUrl: string | null;          // the "Syllabus Center" hub page, once built
  needsParent: boolean;           // true => show the picker below
  candidates: { id: string; title: string; url: string }[];   // pages the user shared
  coursePages: Record<string, string>;   // courseId -> Notion page URL
}
```

## The Term Pass paywall

`POST /api/upload` and `PATCH /api/courses/[id]` both answer **402** with

```ts
{ ok: false, error: string, paywall: { term: AcademicTerm; courseCount: number } }
```

when the course's target term already holds its free course and the term is
not premium. `paywall.term` is the full term object (so the client can show
its name and dates in the paywall) and `paywall.courseCount` is how many
courses it already has. This is the server-side enforcement; the dashboard
also checks the same condition client-side before it lets an upload start, so
hitting the 402 in practice should be rare — the client check is a courtesy,
this is the rule. See `docs/TERM-PASS.md` for how a term becomes premium and
how long premium lasts.

## Session, demo, and Origin requirements

Every route in the table above requires the session cookie except the four
marked "not JSON" (`/api/auth/*`, `/api/notion/auth`, `/api/notion/callback`)
and `/api/feed/[token].ics`, which is unauthenticated by design (the token is
the credential). `POST /api/terms/[id]/checkout` additionally requires a real
Google account — the shared demo account gets **403**, since a Stripe
Checkout Session needs a real customer to bill.

All state-changing routes sit behind the app's cross-site check
(`crossSiteDenied`) except `POST /api/stripe/webhook`, which is exempt: Stripe
calls it directly with no Origin header a browser would set, and the route
verifies the request a different way — the raw-body signature check above —
so the Origin check would only ever reject Stripe's own deliveries.

## Rate limits

`/api/upload`, `/api/chat` and `/api/sync` are rate limited per user. A denied
request returns **429** with the standard envelope and a `Retry-After` header.
Limits are in-memory, so they reset on a serverless cold start -- they raise the
cost of casual abuse and are not a security boundary.

## Demo mode

Demo is **per visitor**, not a server setting. A request with no session cookie is
given an ephemeral account (`demo_<random>`) seeded with the bundled fixtures, so
the demo works on a deployment where Google sign-in is also configured. Signing in
with Google creates a real account; the demo sandbox is abandoned, not merged.
`GET /api/config` reports `demoMode` for **the caller**, and `googleReady`
independently.

### Legacy notes

When `OPENAI_API_KEY` / Google credentials are absent the app runs in **demo
mode**: `/api/me` returns a seeded demo user, upload uses the deterministic
fixture parser, and `/api/sync` reports what *would* be created without calling
Google. `GET /api/config` returns `{ demoMode: boolean; googleReady: boolean; openaiReady: boolean }`
so the UI can show an honest banner.
