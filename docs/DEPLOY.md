# Deploying Syllabus AI

A checklist for the first real deploy — the one where other people sign in with
their own Google accounts and upload their own syllabi.

Work through it in order. Steps 1–4 are setup, 5 is cost control, 6 is the smoke
test that tells you whether it actually works, 7 is what to send your testers,
8 is what to tell them it can't do.

Budget an hour. Most of it is Google Cloud.

> Two claims in this guide are time-sensitive because they are other people's
> policies, not our code: Google's OAuth publishing rules (step 3) and Vercel's
> function limits (step 4). Both are cited with the page to re-check. Do that
> rather than trusting the numbers here.
>
> For the parsing limits — OCR, the heuristic fallback, document length — see
> **Known scope limits** in `README.md`. This document covers the operational
> ones.

---

## 0. Before you start

You need:

- A Google Cloud project you own.
- A Supabase project (free tier is fine).
- An OpenAI API key on an account with a payment method — and a spend cap on it
  (step 5).
- A Vercel account.

Confirm the app builds clean before you deploy anything:

```bash
npm run typecheck && npm run build
```

A green build does **not** mean the deploy is configured. `next build` runs with
`NODE_ENV=production` but no request ever executes, so a missing
`SESSION_SECRET` cannot surface there — by design, so a misconfigured
environment breaks the deploy rather than the build. Step 6 is what catches it.

---

## 1. Environment variables

Nine variables are read anywhere in `src/`. `NODE_ENV` is set by the platform;
the rest are yours.

| Variable | Required in prod | What breaks without it |
|---|---|---|
| `SESSION_SECRET` | **Yes — app refuses to serve** | In production, every request throws. See below. |
| `GOOGLE_CLIENT_ID` | **Yes** | `/api/auth/google` returns 503. The app decides it is in demo mode and hands every anonymous visitor the shared `demo-user` account. |
| `GOOGLE_CLIENT_SECRET` | **Yes** | Same as above — `isDemoMode()` in `src/lib/session.ts` checks both. |
| `GOOGLE_REDIRECT_URI` | **Yes** | Falls back to `http://localhost:3000/api/auth/callback`, so Google redirects your users to their own laptops. Sign-in cannot work. |
| `SUPABASE_URL` | **Yes** | Storage falls back to `.data/db.json` on local disk, which does not survive on serverless. `/api/health` reports `degraded`. See step 4. |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | Same — the store only picks the Supabase driver when *both* are set. |
| `OPENAI_API_KEY` | Recommended | Uploads fall back to the heuristic parser and chat answers from a deterministic matcher. Nothing errors; quality drops and a warning is attached to the parse. |
| `OPENAI_MODEL` | No — advanced | Optional override, deliberately **not** in `.env.example`. See the hazard below. |
| `NODE_ENV` | Set by platform | Vercel sets `production`. It gates the session hard-fail, and the `secure` flag on the session cookie. |

Optional, read only by `/api/health` to label the deploy — never required:
`APP_VERSION` / `NEXT_PUBLIC_APP_VERSION` / `npm_package_version` (first
non-empty wins) for `version`; `VERCEL_GIT_COMMIT_SHA` / `GIT_COMMIT_SHA` /
`COMMIT_SHA` for `commit`; `VERCEL_ENV` (else `NODE_ENV`) for `environment`. On
Vercel the commit SHA is populated for you.

### `SESSION_SECRET` — the one that actually matters

`src/lib/session.ts` signs an HMAC-SHA256 cookie (`sylb_session`, 30-day max
age) whose payload is the user id. The cookie is `userId.HMAC(userId)`, so
anyone who knows the signing key can mint a valid session for **any** user id —
read their syllabi, delete their courses, write to their Google Calendar.

Outside production, a missing secret falls back to a constant that is checked
into this repo (`syllabus-ai-dev-only-insecure-session-secret`) and logs one
warning. That constant is public; a session signed with it is not weakly
protected, it is unprotected.

**In production, `getSecret()` throws.** It throws when `SESSION_SECRET` is
absent, and also when it is shorter than **32 characters** — enough to reject
`changeme` and `secret123`, not enough to trip anything legitimately generated.

Know the exact failure shape, because it is not a boot failure:

- `next build` **succeeds**. The throw is per-request, not at module load,
  precisely so a build does not break on it.
- The deployment goes live and serves static assets.
- Every API route — they are all `force-dynamic` and all read the session —
  throws on the first real request. The app looks up and is completely unusable.
- `GET /api/health` returns `status: "degraded"` with a warning naming
  `SESSION_SECRET`, which is how you find out in ten seconds instead of an hour.

Generate one:

```bash
openssl rand -hex 32
```

That produces 64 hex characters, comfortably over the minimum. Rotating the
secret invalidates every existing cookie: everyone signs in again, no data is
lost.

> One gap to know about: `/api/health` checks that `SESSION_SECRET` is
> *present*, not that it is long enough. A 12-character secret reports
> `capabilities.sessionSecret: true` and `status: "ok"` while every request
> throws. If health says `ok` and the app still 500s on every route, check the
> secret's length first.

### The `OPENAI_MODEL` hazard

One variable, two call sites, two different defaults:

| Read by | Default | Needs |
|---|---|---|
| `src/lib/parse/extract.ts` | `gpt-4o-2024-08-06` | Structured outputs (JSON-schema-constrained responses) |
| `src/lib/plan/chat.ts` | `gpt-4o-mini` | Ordinary chat completion |

Setting `OPENAI_MODEL` overrides **both**. Pointing it at a cheap chat model to
save money on chat also repoints the extractor, and if that model does not
support structured outputs, every upload throws inside `extractWithAi` — which
is caught, so uploads do not error, they just silently degrade to the heuristic
parser. You get worse parsing and no obvious signal. Leave it unset unless you
mean both.

### Setting them on Vercel

```bash
vercel env add SESSION_SECRET production
```

Repeat per variable, per environment. Preview deployments get their own values —
give Preview a **different** `SESSION_SECRET` and a **different**
`GOOGLE_REDIRECT_URI`, or Google will reject the preview callback.

None of these may ever carry a `NEXT_PUBLIC_` prefix. Every one of them is read
in a server-only module.

---

## 2. Supabase

1. Create a project at [supabase.com](https://supabase.com). Region close to
   your Vercel region.
2. Open **SQL Editor**, paste the contents of the *current* `supabase/schema.sql`
   from your checkout, run it. Or from your machine:

   ```bash
   psql "$DATABASE_URL" -f supabase/schema.sql
   ```

   The file is written to be idempotent — `create table if not exists`,
   `create index if not exists`, `alter table … add column if not exists`,
   `drop policy if exists` before each `create policy` — so re-running it on a
   database that is already current is a no-op.

   **Caveat for a database created before this week.** `create table if not
   exists` does not alter a table that already exists, and the `users.id` column
   type changed from `uuid` to `text` (see below). Only the `timezone` column has
   an explicit `alter … add column` migration. If you have an older database with
   `users.id uuid`, re-running the file will *not* fix it — drop and recreate the
   schema (you are pre-launch; there is nothing to preserve), or write the type
   change by hand.

3. **Settings → API** gives you two values:
   - **Project URL** → `SUPABASE_URL`
   - **`service_role` key** → `SUPABASE_SERVICE_ROLE_KEY`

### Why `users.id` is `text`

Worth knowing before you look at the schema and assume it is a mistake. The
application supplies the user id: a real user gets Google's `sub` claim (a
~21-digit numeric string, stable across email changes), and demo mode uses the
literal `"demo-user"`. Neither is a UUID, so a `uuid` column rejects the very
first sign-in with `invalid input syntax for type uuid`. `courses.user_id` is
`text` to match. The RLS policies compare against `auth.uid()::text`.

### The service-role key bypasses RLS

This is the sentence to remember: **the service-role key ignores every row-level
security policy in the schema.** A browser holding that key can read and write
every user's rows. Treat it exactly like a database superuser password.

- Never prefix it `NEXT_PUBLIC_`. Ever. `NEXT_PUBLIC_` is what tells Next.js to
  inline the value into the client bundle, and once it is in a bundle it is
  public forever.
- Only `src/lib/store/supabase.ts` reads it, and that module is server-only.
- If you paste it anywhere client-side by accident, rotate it in the Supabase
  dashboard and redeploy. Rotating is cheap; assuming it wasn't scraped is not.

Because the server bypasses RLS, **ownership is enforced in application code**,
not by the database. `src/lib/store/supabase.ts` proves ownership on every
method that takes a `userId`: `deleteCourse` adds `.eq("user_id", userId)` to
the delete, so another user's id matches zero rows and "not yours" is
indistinguishable from "no such course"; `listAssessments` first resolves the
user's course ids and filters `.in("course_id", …)`; `updateAssessment` calls
`ownedAssessment()` and never emits `id` or `course_id` in the patch, so an
assessment cannot be re-parented into someone else's course. The local driver
mirrors the same gates.

The RLS policies in `supabase/schema.sql` are defence in depth. They are what
protects the data if the **anon** key is ever used directly — the Supabase JS
client from a browser, PostgREST, a future realtime subscription. Keep them
enabled even though the server path never trips them.

---

## 3. Google Cloud

The step most likely to cost you an afternoon. Do it carefully once.

### 3a. Enable the API and create the client

1. In the [Cloud Console](https://console.cloud.google.com), select (or create)
   your project.
2. **APIs & Services → Library →** enable **Google Calendar API**. Sign-in will
   work without this and calendar sync will fail at the first API call, which is
   a confusing way to find out.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID →
   Application type: Web application.**
4. Copy the client ID and client secret into `GOOGLE_CLIENT_ID` /
   `GOOGLE_CLIENT_SECRET`.

### 3b. The redirect URI

Google compares the redirect URI **byte for byte**: scheme, host, port, path.
`https://` vs `http://`, a trailing slash, `www.` — any difference is
`redirect_uri_mismatch`.

Your production value is the deployed origin plus `/api/auth/callback`:

```
https://your-app.vercel.app/api/auth/callback
```

Not localhost. `src/lib/google/oauth.ts` falls back to
`http://localhost:3000/api/auth/callback` when `GOOGLE_REDIRECT_URI` is unset —
that default exists for `npm run dev` and is wrong for every deploy.

Add every origin you will actually use to **Authorized redirect URIs** on the
client, and set `GOOGLE_REDIRECT_URI` to the matching value in each Vercel
environment:

| Environment | Authorized redirect URI |
|---|---|
| Local dev | `http://localhost:3000/api/auth/callback` |
| Preview | `https://<your-preview-domain>/api/auth/callback` |
| Production | `https://<your-production-domain>/api/auth/callback` |

Vercel preview URLs contain a per-deploy hash, so they cannot be pre-registered
one by one. Either give previews a stable alias domain and register that, or
accept that sign-in only works on production and on localhost.

### 3c. Sensitive scope, Testing status, and the 7-day cliff

`src/lib/google/oauth.ts` requests four scopes:

```
openid
email
profile
https://www.googleapis.com/auth/calendar
```

That last one is full read-write Calendar access — the code takes it rather than
`calendar.events` because creating the dedicated "Syllabus AI" calendar requires
it. Google classes it as a **sensitive scope**, which is what puts the app under
the verification regime.

While your OAuth consent screen's publishing status is **Testing**:

- **Only listed test users can sign in at all.** Everyone else gets "access
  blocked" — not a bug in your app.
- Testing projects are limited to **100 test users** ([Google Cloud support:
  test user limits](https://support.google.com/cloud/answer/15549945)). Test
  users consume quota once added.
- Every tester sees an **"unverified app"** interstitial with a warning triangle
  before the consent screen. They have to click **Advanced → Go to \<app\>
  (unsafe)** to continue. It looks exactly like a phishing warning. Warn them
  first — see step 7.
- **Refresh tokens expire after 7 days.** Google's own words: a project
  "configured for an external user type and a publishing status of 'Testing' is
  issued a refresh token expiring in 7 days, unless the only OAuth scopes
  requested are a subset of name, email address, and user profile." We request
  `calendar`, so we are not in the exemption
  ([OAuth 2.0 refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)).

The 7-day expiry is the one that will look like a product bug. Sync works all
week, then a tester comes back on day eight, hits **Sync to Google Calendar**,
and it fails. What they see is a sync error; what happened is that Google
revoked the refresh token stored on their user row. The fix for them is to sign
out and sign in again. The fix for you is publishing.

Add your testers explicitly: **APIs & Services → OAuth consent screen → Audience
→ Test users → Add users**, one Google account address per friend.

Moving the app to **In production** publishing status is what removes the 7-day
expiry and the interstitial — and for a sensitive scope that means going through
Google's verification (app homepage, privacy policy, demo video, domain
ownership). Plan for weeks, not hours. For a handful of friends over a couple of
weeks, staying in Testing and telling everyone to re-consent when sync breaks is
the reasonable trade.

**Google changes these policies.** Confirm the current test-user cap, the expiry
rule, and the verification requirements in your own Cloud Console and in
Google's docs before you invite anyone — the two pages linked above are the
authoritative source, this guide is not.

---

## 4. Hosting (Vercel)

Standard Next.js 15 App Router deploy. No `vercel.json` is needed; the only
build config is `serverExternalPackages: ["pdf-parse"]` in `next.config.ts`,
which is already there and load-bearing — without it the production build gets a
`require` that cannot resolve, and every PDF upload fails under `next start`
while dev works fine.

```bash
vercel --prod
```

### Environment variables per environment

Set all seven of your variables (step 1) for **Production**. Then decide about
Preview:

- Different `SESSION_SECRET` (a preview deploy should not be able to mint
  production sessions).
- Different `GOOGLE_REDIRECT_URI`, matching a registered URI.
- Ideally a *different Supabase project* for Preview. Both environments pointed
  at one database means a preview deploy writes real testers' rows.

### `maxDuration` must fit your plan

Three routes declare a duration ceiling:

| Route | `maxDuration` | Why |
|---|---|---|
| `src/app/api/upload/route.ts` | `120` | Chunked OpenAI extraction; the client has a 90s per-request timeout and retries once. |
| `src/app/api/sync/route.ts` | `120` | One Calendar API round trip per event, with bounded backoff. |
| `src/app/api/chat/route.ts` | `60` | One completion. |

If a value exceeds your plan's ceiling the deploy fails, and if a function is
capped below it long uploads die mid-parse with no useful error.

Vercel's docs at time of writing put the default *and* maximum duration at 300s
for Hobby, with Pro and Enterprise higher only at the extended tier — on those
numbers, 120 and 60 fit on every plan. That limit has moved more than once
(Hobby was 60s not long ago), so **check
[vercel.com/docs/functions/configuring-functions/duration](https://vercel.com/docs/functions/configuring-functions/duration)
against your own plan** rather than trusting this paragraph. If Hobby is capped
below 120 when you read this, either upgrade or lower the two `120`s — a capped
upload is worse than a slow one.

### The local JSON store cannot run in serverless

`src/lib/store/index.ts` picks its driver at first use:

```
SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY both set  ->  Supabase
otherwise                                          ->  .data/db.json on local disk
```

The local driver writes the entire database to one JSON file under
`process.cwd()`, via a temp-file-plus-rename. On Vercel that filesystem is
read-only apart from `/tmp`, and `/tmp` is per-invocation and ephemeral — a
serverless function's disk does not survive to the next request, let alone
across concurrent instances. Uploads would fail, or appear to succeed and
vanish.

So: **Supabase is mandatory in production, not optional.** Two ways to confirm
which driver you got — `GET /api/health` reports `"storage": "supabase"`, and
the deploy log prints the choice on first use:

```
[store] driver=supabase
```

If either says `local`, one of the two Supabase variables is missing or
misspelled in that environment. Health will also be `degraded` and say so.

---

## 5. Cost control

The OpenAI key is billed to you, and your testers can spend it. Two routes call
OpenAI on user input:

- `POST /api/upload` — `src/lib/parse/extract.ts`. Model `gpt-4o-2024-08-06` by
  default, `temperature: 0`, structured outputs. Input is capped at 15 MB per
  file and roughly 120,000 characters per call; longer documents are chunked at
  ~90,000 characters with 4,000 characters of overlap, to a hard ceiling of
  **4 chunks**. So the worst case for one upload is four large completions, not
  an unbounded loop.
- `POST /api/chat` — `src/lib/plan/chat.ts`. Model `gpt-4o-mini` by default.
  Messages are capped at 2,000 characters. Cheap per call, unbounded in call
  count.

**Set a hard monthly spend limit and usage alerts in the OpenAI dashboard**
(Settings → Organization → Limits). That is the only control that cannot be
bypassed by a bug, a loop in the UI, or a tester who discovers that re-uploading
the same PDF twenty times is fun. Set the cap to a number you would be annoyed
but not hurt to lose.

### The app's own rate limits

`src/lib/ratelimit.ts` is wired into `/api/upload`, `/api/chat` and `/api/sync`,
keyed per user (`user:<id>`). A denied request gets **429** with the standard
`ApiResult` envelope and a `Retry-After` header. Current `RULES` — read the file
rather than trusting this table, the numbers are tuned for a private beta:

| Rule | Limit |
|---|---|
| Upload, per user | 3/min and 20/day |
| Chat, per user | 12/min and 150/day |
| Sync, per user | 6/min |
| Global OpenAI backstop, all users | 60/min and 1000/day |

Per-user rules are checked before the global backstop, so a user over their own
limit gets a message about themselves. Nothing is consumed on a denial.

**This is not a spend ceiling.** State lives in a `Map` in one Node process. On
Vercel that means counters are per instance (N warm instances multiply every cap
by N), a cold start resets every counter to zero, and preview and production
share nothing. It raises the cost of casual abuse — a friend holding down a
button, a runaway retry loop — from free to annoying. A determined tester who
can trigger cold starts or fan out across instances will get more than the table
suggests.

The OpenAI dashboard limit is the real safety net. Set it first.

---

## 6. Post-deploy smoke test

Run this against the live URL, in order, before you send the link to anyone.
`$APP` is your production origin.

1. **Health.**

   ```bash
   curl -s "$APP/api/health"
   ```

   `/api/health` always returns HTTP **200** — the process is up and answering,
   and the nuance is in the body, so an uptime monitor is not paged over a
   missing env var. What you are reading is `data.status`:

   ```
   "status": "ok"         -> everything required is configured
   "status": "degraded"   -> read data.warnings; they name the variable
   ```

   In production it reports `degraded` when `SESSION_SECRET` is missing or when
   the Supabase pair is incomplete. Also check `data.storage` is `"supabase"`
   (not `"local"`) and that `data.capabilities` reads
   `{ openai: true, google: true, supabase: true, sessionSecret: true }`. Those
   are booleans only — the endpoint is unauthenticated and never reports a
   value, prefix, length or hash of any credential.

   `data.version`, `data.commit`, `data.environment` and `data.uptimeSeconds`
   tell you *which* deploy answered. A `uptimeSeconds` in the single digits just
   means you hit a cold start.

2. **Confirm you are not in demo mode.**

   ```bash
   curl -s "$APP/api/config"
   ```

   Expect `"demoMode": false`. If it is `true`, your Google credentials did not
   reach the deployment and every anonymous visitor is being handed the same
   shared `demo-user` account.

3. **Sign in with Google.** Open `$APP`, click through to sign-in. You should
   land on the Google consent screen (via the unverified-app interstitial), grant
   access, and be redirected to `/dashboard`. If you bounce back to `/` with an
   `auth_error` query parameter, read it — `bad_state` is a cookie problem,
   `redirect_uri_mismatch` is step 3b, anything else is echoed from Google.

   If instead every route 500s, go back to `SESSION_SECRET` in step 1 — including
   its 32-character minimum, which health does not check.

4. **Confirm you are really signed in.** In the browser with your session cookie,
   `GET /api/me` should return your Google email — not `demo@syllabus.ai`. The
   dashboard also POSTs your browser's IANA zone to `/api/me/timezone` on mount;
   the `User` it returns should carry a `timezone` like `"America/New_York"`.
   That value is what step 7 depends on.

5. **Upload a syllabus.** Use a real PDF from a real course, not a fixture. The
   upload response carries `warnings`; read them. Confirm the extracted course
   code, title and term look right.

6. **Confirm items appear.** The dashboard should list assessments with due
   dates. Anything with confidence under 0.6 is flagged for review — expect a
   few. Zero assessments from a syllabus that clearly has deadlines means the
   parse fell back or the schedule table did not survive text extraction.

7. **Sync to Google Calendar.** Click **Sync to Google Calendar** (if the button
   says "Preview the sync", you are in demo mode — go back to step 2). Expect
   `created` > 0 and an empty `errors` array.

8. **Check the calendar — and check the times.** In Google Calendar, a new
   calendar named **Syllabus AI** should have appeared in the left sidebar, with
   your deadlines and study blocks in it. Your primary calendar must be
   untouched.

   Then open an event with a specific due time and confirm it is at the **right
   local time** — a 23:59 deadline should read 23:59 to you, not shifted by your
   UTC offset. `syncToCalendar` resolves the zone once per sync from the user's
   stored `timezone` and stamps it on `start.timeZone` / `end.timeZone` for every
   timed event; all-day events correctly keep a bare `date` with no zone. It
   falls back to the server's zone (UTC on Vercel) only when the user's is still
   null — which is what a shifted time means: step 4's timezone POST did not
   land. Check that before blaming the calendar.

9. **Re-run the sync.** Click sync again with nothing changed. Expect
   `created: 0`, `updated: N`, and **no duplicate events** in the calendar.

   The idempotency is real: `syncToCalendar` looks up
   `store.getCalendarLink(sourceId)` for every planned event, keyed on the
   assessment id (or study-block id) rather than on anything about the event's
   contents. A link present means `events.patch`; absent means `events.insert`
   followed by `setCalendarLink`. In Postgres, `calendar_links.assessment_id` is
   the primary key, which makes "one event per assessment" a database invariant
   rather than a convention. A 404 or 410 on patch — the user deleted the event —
   is caught and turned into a fresh insert plus a re-link, which is why a second
   sync can legitimately report a small `created` count if you deleted events by
   hand in between.

10. **Ask a chat question.** Something grounded in the uploaded data, e.g. "When
    should I start studying for the midterm?" A useful answer means the plan and
    the model call both work. A plausible-sounding answer with no real dates in
    it means chat fell back to the deterministic matcher — check
    `capabilities.openai` in step 1.

11. **Trip a rate limit on purpose.** Send 13 chat messages inside a minute, or
    hit sync 7 times. You should get a **429** with a `Retry-After` header and a
    plain-English message. Better to confirm the limiter works now than to
    discover it doesn't from your OpenAI bill.

12. **Delete the test course** if you used a real syllabus you do not want
    sitting in the database, and confirm it disappears.

---

## 7. What to tell your testers

Paste this, edited for your voice:

> **Syllabus AI — please break it**
>
> Upload a course syllabus (PDF) and it pulls out your assignments, exams, due
> dates and grading weights, builds a week-by-week workload view, and can push
> everything to your Google Calendar with study blocks scheduled ahead of exams.
>
> **It will ask for Google access, including Calendar.** It needs Calendar
> permission to create events — that's the whole feature. It creates a **separate
> calendar called "Syllabus AI"** and writes only there. It never touches your
> primary calendar, and you can hide or delete the whole calendar in one click if
> you hate it.
>
> **You will see a scary "Google hasn't verified this app" warning.** That is
> expected. It's not a scam and it's not a virus — it means I haven't finished
> Google's app-verification process yet, which takes weeks and isn't worth it for
> a test. Click **Advanced**, then **Go to Syllabus AI (unsafe)**. If you're not
> comfortable with that, no hard feelings, don't.
>
> Two other things: I have to add your Google address to a list before you can
> sign in at all, so tell me which account you'll use. And Google expires access
> for unverified apps after about **7 days** — if calendar sync suddenly stops
> working after a week, that's why: sign out and sign back in.
>
> There are usage limits (a few uploads a minute, a couple of dozen a day) so
> nobody can run up my OpenAI bill by accident. If you hit one you'll get a
> message telling you when to come back — that's working as intended, not a bug.
>
> **Reporting a bug — what actually helps:**
> 1. What you did, in order (what you uploaded, what you clicked).
> 2. What you expected vs what happened.
> 3. A screenshot, including any error text, verbatim.
> 4. Roughly when it happened, with your timezone — it lets me find it in the logs.
> 5. If it's a wrong date or a missing assignment: which line of the syllabus it
>    came from. That's the single most useful thing you can send me.
>
> Please don't upload anything you'd mind me being able to read in the database.

---

## 8. Known operational limits

What breaks or bites in a live deploy. For what the *parser* can't do — OCR, the
heuristic fallback's one-item-per-line rule, document length — see **Known scope
limits** in `README.md`.

**Google**

- **Refresh tokens die after 7 days** while the OAuth app is in Testing status.
  Sync stops working about a week in and the tester must re-consent. This is the
  single most likely thing to be reported as a bug. Step 3c.
- **100 test users maximum**, and each must be added by hand before they can sign
  in at all.
- **Google Calendar write quota** is per user and is the thing that breaks under
  a heavy sync, not our code.

**Rate limits and spend**

- **Rate limits are in-memory** and reset on every cold start, multiply by warm
  instance count, and are not shared between environments. They are not a spend
  ceiling. The OpenAI dashboard cap is. Step 5.
- **The global backstop is shared.** If one tester exhausts the 1000/day OpenAI
  budget, everyone else gets "Syllabus AI has reached its shared daily usage
  cap" until it resets.

**Sync**

- **Sync runs inside one request** with bounded retries (4 attempts, exponential
  backoff with jitter) against a `maxDuration` of 120s. A student with several
  hundred deadlines and a slow Calendar API can hit the ceiling. Per-event
  failures are collected into `errors` and never abort the run, so a partial sync
  is a normal outcome — re-running finishes the job.
- **Assessments with no resolvable date are skipped**, not guessed. They show up
  in the `skipped` count and stay in the dashboard for manual dating.
- **Deleting a course does not remove its Google events.** The cascade cleans up
  assessments and calendar links in the database; the events already on the
  user's calendar stay until they delete the "Syllabus AI" calendar themselves.

**Accounts and data**

- **Sessions are a signed cookie, not an auth provider.** No revocation, no
  device list, no session store — a stolen cookie is valid for its full 30 days.
  Rotating `SESSION_SECRET` is the only mass logout available.
- **No account deletion and no data export.** A tester who asks you to delete
  their data needs you to run SQL by hand. There is no self-serve path, and no
  way for them to get their own data out.
- **Google refresh tokens are stored in plaintext** in
  `users.google_refresh_token`. The column is never selected into anything
  client-facing and access tokens are never persisted, so a leaked row expires
  the moment the user revokes the grant — but a database compromise is a
  compromise of everyone's calendar write access.
- **`/api/health` is unauthenticated.** It is boolean-only by design, but it does
  tell the internet which capabilities your deploy has and how long the instance
  has been up. That is the intended trade; know you made it.

---

## Rollback

Vercel keeps every deployment. If a release is bad, promote the previous one
from the dashboard, or:

```bash
vercel rollback
```

Environment-variable changes do **not** apply to existing deployments — you must
redeploy after changing one. A rollback restores the code, not the variables.

---

## Appendix: persistent volume instead of Supabase

For a small deployment (one instance, a handful of users) the bundled JSON store
is a legitimate production database, provided it writes somewhere durable. Set
`DATA_DIR` to a mounted volume and the data outlives the container.

### Railway

1. Service → **Variables** → add `DATA_DIR` = `/data`
2. Service → **Settings** → **Volumes** → **Add volume**, mount path `/data`
3. Redeploy

Do not set `PORT`; Railway injects it.

### Verifying it took

```bash
curl -s https://<your-app>/api/health
```

`"storage":"volume"` and no storage warning means it is durable. `"storage":"local"`
with a warning means `DATA_DIR` is unset and **your data dies on the next deploy**.

The startup log says the same thing:

```
[store] driver=local dir=/data (persistent volume) -- set SUPABASE_* to use Postgres instead
[store] driver=local dir=.data (EPHEMERAL -- lost on redeploy) -- mount a volume and set DATA_DIR, or set SUPABASE_*
```

### What you are accepting

| | Volume | Supabase |
|---|---|---|
| Setup | two settings | project + run schema.sql |
| Instances | **exactly one** | many |
| Backups | yours to arrange | automatic, point-in-time |
| Querying data | read the JSON file | SQL |
| Good up to | a few dozen users | well beyond |

The single-instance limit is real, not a formality: the store is one JSON file
guarded by an in-process lock, so two replicas on one volume would clobber each
other. If you ever raise the replica count, migrate to Supabase first.

Back it up by copying `$DATA_DIR/db.json` off the volume periodically. It is one
file, and it is the whole database.

### Migrating to Supabase later

Set the two `SUPABASE_*` variables and restart: the store picks its driver from
env at first use, so nothing in the code changes. Existing volume data does not
copy itself across — at this scale, re-uploading a few syllabi is usually faster
than writing an importer.
