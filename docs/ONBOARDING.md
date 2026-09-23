# Onboarding

Read this first, then `README.md` for what the product does and `docs/API.md`
for the route table. Budget an hour; you will be able to ship a small change at
the end of it.

The other docs are reference — you read them when you touch that area:

| Doc | When |
|---|---|
| `README.md` | What the product is, and the honest list of what it can't do |
| `docs/API.md` | The contract for every route |
| `docs/DEPLOY.md` | Deploying, Google OAuth, Stripe, cost control, `/admin`, analytics and A/B tests |
| `docs/TERM-PASS.md` | The paywall's product rules and where each one is enforced |
| `docs/NOTION.md` | How the Notion hub and its databases are built and synced |

---

## Get it running

```bash
npm install && npm run dev
```

Open http://localhost:3000 and click **Try the demo**. It works with **zero
configuration** — no API keys, no database, no Google account. Three bundled
syllabi in `fixtures/` are parsed through the real pipeline (with the heuristic
parser, never the model), stored in `.data/db.json`, and the calendar sync runs
as a dry run that reports what it *would* create.

Delete `.data/` and reload to get a clean demo back.

The four commands you will actually use:

```bash
npm run dev        # the app
npm run typecheck  # tsc --noEmit — run this before every commit
npm test           # vitest, ~120 tests, under a second
npm run build      # what the deploy runs
```

There is no key you need on day one. Copy `.env.example` to `.env.local` and
fill in only what you are working on — every capability degrades independently,
so an `OPENAI_API_KEY` with no Google credentials gives you real AI extraction
and a dry-run calendar sync.

---

## The one thing to understand first

**`src/lib/types.ts` is the contract.** Parsing, storage, planning, calendar
sync, Notion sync and the UI all speak those types and nothing else. A `Course`
that came out of a PDF is the same shape as a `Course` that came out of
Postgres, which is why the pieces were buildable — and are changeable —
independently.

Two consequences worth internalising:

- **Changing a type in `types.ts` is a change to five layers.** `tsc` will show
  you all of them. That is the point; treat a red typecheck there as the design
  review, not as an obstacle.
- **Dates are `string`, not `Date`.** A syllabus says "2025-10-14" with no
  timezone. Round-tripping that through a `Date` invents an offset the source
  never stated, and a student's 11:59pm deadline lands at 7pm. Dates are
  `YYYY-MM-DD` and times are `HH:MM`, all the way down to the database columns.

---

## How a request flows

Every API route follows the same five steps. Read
[`src/app/api/courses/route.ts`](../src/app/api/courses/route.ts) — it is the
whole pattern in under 30 lines.

1. **`export const dynamic = "force-dynamic"`.** Every route reads a cookie.
2. **Identity.** `resolveVisitor()` for a route a demo visitor may use (it mints
   a sandbox account and its `users` row); `requireUserId()` for one that needs
   a real sign-in. Never read the cookie directly.
3. **Guards.** `crossSiteDenied(req)` on anything state-changing,
   `checkLimit(...)` on anything that spends money.
4. **Work,** through `store` and the pure libraries. Never `createClient()` in a
   route.
5. **Answer** with `ok(data)` / `fail(msg, status, detail)`, and log the failure
   with `logApiError` — the student gets a polite sentence, the log drain gets
   the cause.

Everything answers in one envelope, `ApiResult<T>`: `{ ok: true, data }` or
`{ ok: false, error, detail? }`, and a non-2xx response still uses that shape.
The client (`src/components/api-client.ts`) therefore has exactly one thing to
branch on, and a half-deployed API degrades into a rendered error state instead
of an unhandled rejection.

---

## The map

```
src/
  app/
    page.tsx              Landing
    dashboard/            The product. dashboard-shell.tsx owns the state;
                          every panel under components/dashboard is a child
    admin/                Operator metrics (docs/DEPLOY.md section 10)
    api/                  Route handlers — see docs/API.md
  components/
    dashboard/            One file per panel. Client components
    ui/                   Panel, Button, Badge, Skeleton, states
    api-client.ts         The only place the browser calls the API
  lib/
    types.ts              THE CONTRACT. Start here
    store/                index.ts is the facade + interface;
                          supabase.ts and local.ts are the two drivers
    session.ts            Signed HMAC cookie. Hard-fails in prod without a secret
    demo.ts               Per-visitor sandbox: mint, seed, and the identity a
                          route is allowed to act as
    api.ts                ok / fail / crossSiteDenied / publicOrigin
    validation.ts         Field rules shared by every route a person types into
    log.ts                Structured logging with credential redaction
    ratelimit.ts          In-memory per-user caps on the routes that cost money
    health.ts             What GET /api/health reports
    metrics.ts            What /admin reports
    alerts.ts             Emails the failures nobody would otherwise see
    analytics.ts          track() -> a log line AND a PostHog event
    analytics-client.ts   The browser half + client crash reporting
    experiments.ts        A/B assignment: a pure hash, decided on the server
    terms.ts              Term Pass rules: validity, premium access, free courses
    entitlement.ts        Those rules with a store behind them (the 402 paywall)
    pricing.ts            Display price. The Stripe price id comes from env
    stripe.ts             Checkout Sessions + webhook verification
    weights.ts            Joins the grading table onto individual assessments
    parse/                PDF -> text -> AI extraction, heuristic fallback
    plan/                 Workload model, spaced study scheduling, chat
    calendar/             Event shapes and the ICS feed
    google/               OAuth and idempotent Calendar sync
    notion/               OAuth, hub + databases, idempotent page sync
supabase/schema.sql       Postgres DDL with RLS, heavily commented
fixtures/                 Three sample syllabi used by demo mode
```

### Two boundaries you must not cross

**Routes never touch a database.** They talk to `store`, which is an interface
with two implementations — Supabase and a local JSON file — chosen by env at
first use. A route written against one works unchanged against the other, and
the demo path exists because of it. Adding a query means adding a method to
`Store` and implementing it in *both* drivers.

**The planner is pure.** `src/lib/plan/` is data in, plan out — no store, no
network (the chat call is the one exception, and it is injected). That is what
makes the workload model testable and `replan` able to honestly diff two runs
and say what moved.

Anything marked *"Server-only"* in its header comment reads a secret. Importing
it from a client component ships that secret to a browser.

---

## Make your first change

A good shape to copy, end to end:

1. **Type first.** Add or change the field in `src/lib/types.ts`.
2. **Store.** Add the method to the `Store` interface in
   `src/lib/store/index.ts`, implement it in `local.ts` *and* `supabase.ts`, and
   add the column to `supabase/schema.sql`. Read the top of that file before you
   touch it — it is idempotent but **not a migration tool**, and the difference
   has bitten people.
3. **Logic,** in a pure module under `lib/`, with the rules in one place.
4. **Route,** following the five steps above.
5. **UI,** a panel under `components/dashboard/`, called through `api-client.ts`.
6. **Test** the pure part.

`npm run typecheck` after each step; it is the fastest reviewer in the repo.

---

## Testing

`npm test` — Vitest, node environment, `src/**/*.test.ts`. Around 120 tests in
well under a second, so there is no excuse for not running them.

What is tested is deliberate rather than uniform: **the rules, not the
plumbing.** Money and correctness logic (`terms.test.ts`, `pricing.test.ts`,
`metrics.test.ts`, `term-backfill.test.ts`), plus the routes where being wrong
costs a real person real money — the Stripe webhook's idempotency and its
refusal to grant premium on somebody else's term (`webhook.test.ts`,
`checkout.test.ts`, `terms.test.ts`).

So: if your change has a branch, a loop, a parser, or touches money or auth,
leave one test behind. If it is glue, don't.

---

## What will bite you

Each of these cost somebody an afternoon already.

- **The local JSON store assumes one process.** One file, one in-process lock.
  Two replicas sharing a volume overwrite each other. Fine locally and for a
  single-instance deploy; move to Supabase before scaling out.
- **`supabase/schema.sql` is idempotent, not a migration tool.**
  `create table if not exists` will not *alter* a table that already exists. New
  columns are added with explicit `alter table ... add column if not exists`
  lines. Follow that pattern or a re-run will succeed silently and change
  nothing.
- **Rate limits are in memory.** Per-instance on serverless, reset by a cold
  start. They make casual abuse annoying, not impossible. The real spend ceiling
  is the hard limit on the OpenAI account.
- **Demo accounts are real rows.** Each visitor gets a `demo_…` user with a
  `users` row, courses, and a term. Anything that counts or lists users has to
  decide what to do about them — `src/lib/metrics.ts` excludes them, and says so.
- **`SESSION_SECRET` is required in production** and the app throws per-request
  without it. That is deliberate: the dev fallback is a published constant, so
  serving with it would let anyone forge a session for any account.
- **Google OAuth scopes must match the Cloud Console exactly.** A scope in
  `src/lib/google/oauth.ts` that is not on the approved list puts the
  "unverified app" warning in front of every new user, whatever the verification
  status says. `docs/DEPLOY.md` section 3d is the full story; `/admin` prints the
  live list.
- **The demo sandbox re-seeds itself.** Deleting every course from a demo
  account restores the three fixture courses on the next request, so you cannot
  reach an empty dashboard that way.
- **A demo account is free to mint, so per-user rate limits do not bind one.**
  Drop the cookie and the server hands out a fresh sandbox with a fresh upload
  allowance. Every route that spends money therefore ALSO checks `demoSpendVerdict`,
  which meters by IP — the one thing a new cookie does not change. If you add a
  route that calls a paid API, it needs that check too.
- **Never rename a live experiment key.** The key is half the hash input, so a
  rename rebuckets everyone — and on `term_pass_price` that means quoting a
  returning customer a different price. Change the variants, never the key.
- **Analytics config and the privacy policy are one change.** Autocapture and
  session replay are off in `analytics-client.ts` deliberately, and
  `src/app/privacy/page.tsx` is written against exactly that. Turning either on
  without editing the policy makes the policy false, which is the one kind of
  documentation bug with legal consequences.
- **A strict CSP and `next dev` do not mix.** Next's dev bundler uses `eval`, so
  without `'unsafe-eval'` in development React never hydrates: the page paints
  from the server HTML and then nothing is interactive, no effect runs and no
  fetch fires. It reads as "stuck on Loading…", not as a security header.
  `next.config.ts` adds it in development only; production bundles contain no
  `eval` and the deployed policy stays strict. If you tighten the CSP, check the
  dev dashboard still fetches before you commit.
- **A route's `try` block opens AFTER it resolves the caller.** So a store
  outage throws in `resolveVisitor()`, outside the route's own error handling,
  and never reaches `logApiError`. `src/instrumentation.ts` is what catches
  those; don't remove it, and don't assume a `catch` in a route covers the whole
  handler.
- **Alert emails are throttled to one per event name per hour.** If you are
  testing alerting and only see the first one, that is working as designed —
  everything suppressed is still in the log drain.
- **A refused upload is kept, not dropped.** The 402 stashes the parse in
  `pending_uploads`; the upload panel replays it (`pendingId`, no file) the
  moment the term reads premium — once per stash id. If a purchase seems not to
  "add" the course, look for the stash on the term (`GET /api/terms` →
  `pendingUpload`) before assuming the parse was lost.
- **An undated, unlabelled syllabus goes into the active paid term.** That is
  `suggestTerm`'s last rule, and it is what stops paying students meeting the
  paywall. Dated syllabi still follow their dates.
- **Heatmap tiers are relative as well as absolute.** A week over 2× the
  student's median is a crunch for them even at 10h. `relativeIntensity` can
  only raise a tier, never lower one — a 20h week stays a crunch.
- **The calendar sync streams.** `/api/sync` with `Accept: application/x-ndjson`
  returns progress lines then the envelope. The HTTP status is 200 even on
  failure; the failure is in the last line. Don't add a status check there.
- **`src/lib/schools.data.ts` is generated — don't hand-edit it.** It's the US
  subset of the open `university-domains-list` dataset (~2,300 names); the
  regeneration command is in its header. Abbreviations students type ("nyu",
  "ucla") live in `ALIASES` in `schools.ts`, keyed by the dataset's exact
  spelling — a test fails if an alias points at a spelling the dataset lacks,
  because that would create two rows for one school.
- **Nothing in an analytics event may name a student.** Ids, counts, variants and
  enum labels only — no course titles, no syllabus text, no Google data, no
  email. This is a Google Limited Use obligation, not a preference.

---

## House style

The code in this repo is commented unusually heavily, and on purpose: the
comments explain **why**, not what. `session.ts` says why production throws
rather than warns; `schema.sql` says why dates are `text`; `local.ts` says why
one writer is enough. Match that when you add code — a header comment on every
new module saying what it is for and what it refuses to do.

Two rules that follow from it:

- **Delete a comment that has stopped being true** in the same commit as the
  code that made it untrue. A confidently wrong comment is worse than none.
- **Write the constraint down where it is enforced,** not in a doc. `terms.ts`
  holds the 183-day cap and the 14-day grace, once; `docs/TERM-PASS.md`
  describes them and points at the code.

Naming: domain types are singular (`Course`, `Assessment`, `AcademicTerm`); a
function that reaches the network or a store is `async` and says so in its name
where it is not obvious (`ensureCalendarFeedToken`, `resolveVisitor`).

---

## Where to look when something is wrong

| Symptom | First stop |
|---|---|
| Anything in a deployed environment | `GET /api/health` — it reports `degraded` with a plain-language warning per cause |
| Upload produced nothing useful | `src/lib/parse/index.ts` header — it documents exactly when the parser throws vs warns |
| Calendar events duplicated or orphaned | `src/lib/google/calendar.ts` — sync is idempotent through `calendar_links`; the bug is usually a key that changed shape |
| Paywall shown or not shown wrongly | `src/lib/entitlement.ts`, then `src/lib/terms.ts`. One implementation, called by every route that can create a course |
| Premium granted and then lost | Only the verified Stripe webhook grants it. The success redirect grants nothing, by design (`docs/TERM-PASS.md`) |
| "Google hasn't verified this app" | `docs/DEPLOY.md` section 3d |
| An experiment looks lopsided | `src/lib/experiments.test.ts` — the fairness regression tests, and the `fmix32` note explaining why they exist |
| A funnel number looks too low | Ad blockers and opt-outs. `/admin` is the exact count; PostHog under-reports by design |
| The dashboard paints but nothing works | React did not hydrate. Check the console for a CSP `EvalError` — see the CSP note above |
| A student reports a white screen | PostHog → Error tracking. Client crashes are reported from `reportError`, with the React component stack |
| A 500 nobody was told about | It threw outside the route's `try`. `src/instrumentation.ts` catches those as `server.unhandled` |
| Sign-in works, sync fails a week later | Testing-status OAuth expires refresh tokens after 7 days (`docs/DEPLOY.md` 3c) |
