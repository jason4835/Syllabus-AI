# Deploying Syllabus Center

A checklist for the first real deploy — the one where other people sign in with
their own Google accounts and upload their own syllabi.

Work through it in order. Steps 1–4 are setup, 5 is cost control, 6 is the smoke
test that tells you whether it actually works, 7 is what to send your testers,
8 is what to tell them it can't do, 9 turns on payments, 10 is the metrics page
you watch afterwards, and 11 is analytics and A/B testing.

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
| `APP_URL` | **Yes** | Absolute URLs fall back to the request's `Host`/`X-Forwarded-Host` header. On a host that forwards a client-supplied value, a forged header rewrites the calendar-feed URL the panel shows — and that URL carries the student's feed token, so the link would hand their semester to whoever chose the host. Also what makes link previews resolve. No trailing slash. |
| `SESSION_SECRET` | **Yes — app refuses to serve** | In production, every request throws. See below. |
| `GOOGLE_CLIENT_ID` | **Yes** | `/api/auth/google` returns 503. The app decides it is in demo mode and hands every anonymous visitor the shared `demo-user` account. |
| `GOOGLE_CLIENT_SECRET` | **Yes** | Same as above — `isDemoMode()` in `src/lib/session.ts` checks both. |
| `GOOGLE_REDIRECT_URI` | **Yes** | Falls back to `http://localhost:3000/api/auth/callback`, so Google redirects your users to their own laptops. Sign-in cannot work. |
| `SUPABASE_URL` | **Yes** | Storage falls back to `.data/db.json` on local disk, which does not survive on serverless. `/api/health` reports `degraded`. See step 4. |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | Same — the store only picks the Supabase driver when *both* are set. |
| `OPENAI_API_KEY` | Recommended | Uploads fall back to the heuristic parser and chat answers from a deterministic matcher. Nothing errors; quality drops and a warning is attached to the parse. |
| `OPENAI_MODEL` | No — advanced | Optional override, deliberately **not** in `.env.example`. See the hazard below. |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_TERM_PASS_PRICE_ID` | Recommended | Academic Term Pass billing is off: the free course and everything else keep working, but the Term Pass paywall shows "not configured" copy instead of a Buy button. See step 9. |
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

`src/lib/google/oauth.ts` requests four scopes, and that array is the single
source of truth for the whole app:

| Requested in code | How the Cloud Console spells it |
|---|---|
| `openid` | `openid` |
| `email` | `https://www.googleapis.com/auth/userinfo.email` |
| `profile` | `https://www.googleapis.com/auth/userinfo.profile` |
| `https://www.googleapis.com/auth/calendar` | `https://www.googleapis.com/auth/calendar` |

That mismatch in spelling matters more than it looks — see 3d. `/admin` prints
this table live from the code, so you never have to retype it to compare.

The last scope is full read-write Calendar access. The code takes it rather than
`calendar.events` because creating the dedicated "Syllabus Center" calendar
requires it. Google classes it as a **sensitive scope**, which is what puts the
app under the verification regime. Sensitive, *not* restricted: no third-party
security assessment is required. (Google's own published example of an
acceptable scope justification is for this exact scope — see
[Verification requirements](https://support.google.com/cloud/answer/13464321).)

While your publishing status is **Testing**:

- **Only listed test users can sign in at all.** Everyone else gets "access
  blocked" — not a bug in your app.
- Testing projects are limited to **100 test users** ([Manage App
  Audience](https://support.google.com/cloud/answer/15549945)). Test users
  consume quota once added.
- Every tester sees an **"unverified app"** interstitial with a warning triangle
  before the consent screen. They have to click **Advanced → Go to \<app\>
  (unsafe)** to continue. It looks exactly like a phishing warning. Warn them
  first — see step 7.
- **Authorizations expire after 7 days**, refresh token included. Google's
  exemption covers only "a subset of name, email address, and user profile"
  (`userinfo.email`, `userinfo.profile`, `openid`). We also request `calendar`,
  so we are not in the exemption.

The 7-day expiry is the one that will look like a product bug. Sync works all
week, then a tester comes back on day eight, hits **Sync to Google Calendar**,
and it fails. What they see is a sync error; what happened is that Google
revoked the refresh token stored on their user row. The fix for them is to sign
out and sign in again. The fix for you is publishing.

Add your testers explicitly: **Google Auth Platform → Audience → Test users →
Add users**, one Google account address per friend.

Moving to **In production** is what removes the 7-day expiry and the
interstitial — and for a sensitive scope that means verification (app homepage
on a domain you own, privacy policy, demo video, domain ownership in Search
Console). Google quotes **10 business days** for sensitive-scope review, plus
2–3 for brand verification. For a handful of friends over a couple of weeks,
staying in Testing and telling everyone to re-consent when sync breaks is the
reasonable trade.

**Google changes these policies.** Confirm the current test-user cap, the expiry
rule, and the verification requirements in your own Cloud Console and in
Google's docs before you invite anyone — the pages linked here are the
authoritative source, this guide is not.

---

### 3d. "Google hasn't verified this app" when you *are* verified

This is the one that makes people think verification silently failed. It did
not. Google gives a single, specific cause, in two places
([Manage App Audience](https://support.google.com/cloud/answer/15549945),
[Verification FAQ](https://support.google.com/cloud/answer/13463817)):

> If your users are seeing the "unverified app" screen, it is because your OAuth
> request includes additional scopes that haven't been approved.

So the warning is almost never about the verification *submission*. It is about
a **mismatch between the scopes your code sends and the scopes the project was
approved for**. Work down this list in order; the first three account for nearly
all of it.

**1. Publishing status is still "Testing".**
Submitting the verification form does not move it. **Google Auth Platform →
Audience** must say *In production*, which happens only after you click
**Publish app**. In Testing the interstitial always shows, for every user,
verified or not.

**2. A scope in the code is not on the approved list.**
Open **Google Auth Platform → Data Access** and compare it against the table in
3c above — or just open `/admin` on your own deployment, which prints the same
four strings straight from `src/lib/google/oauth.ts`.

The classic miss is `email` and `profile`. The code requests the short aliases;
the Console lists them as `.../auth/userinfo.email` and
`.../auth/userinfo.profile`. If those two rows are not in Data Access, the
request carries unapproved scopes and every new user sees the warning — no
matter how green the verification status looks. Same story if Data Access has
`calendar.events` but the code asks for `calendar`: those are different scopes.

It has to match in **both** directions. An extra approved scope the code never
asks for is harmless; a requested scope that is not approved is the bug.

**3. The deployed client belongs to a different Cloud project.**
Verification is per **project**, not per credential. A dev project and a prod
project are two separate verification states, and it is easy to verify one and
deploy the other's client ID. Check that the `GOOGLE_CLIENT_ID` in your hosting
environment is a credential of the project whose Data Access page you have been
looking at.

**4. Verification is submitted but still pending.**
Sensitive-scope review is quoted at 10 business days. Until it completes, the
warning and the 100-user cap stay. Nothing to do but wait — and watch the inbox
on the project's contact address, because a reviewer asking a question and
getting no reply is what turns 10 days into 10 weeks.

**5. A scope was added after approval.**
Adding one re-triggers verification *for that scope* and puts the warning back
until it is approved. Google's guidance: get the scope approved **before**
shipping code that requests it, and use a separate Cloud project for testing new
scopes.

Worth knowing what does *not* cause it: changing the app name, logo, redirect
URI, homepage link or privacy policy link requires **brand re-verification**,
but Google states explicitly that those changes "do not trigger the unverified
app screen or the 100-user cap" — the old name and logo just keep showing until
the re-review lands.

**What the code does to stay out of this.** `getAuthUrl` deliberately does *not*
pass `include_granted_scopes`. That flag is for incremental authorization, which
this app has no use for — `SCOPES` is fixed and requested in full on every
sign-in. Left on, it folds a returning user's previously granted scopes back
into the request, which is exactly the "additional scopes that haven't been
approved" condition above. If you ever add it back, you own that failure mode.

**Checking the user cap.** **Google Auth Platform → Audience → OAuth user cap**
shows how much of the 100 is spent. It applies over the project's whole lifetime
and cannot be reset, so an app that burned through it while unverified needs
verification, not a new day.

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
   calendar named **Syllabus Center** should have appeared in the left sidebar, with
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

### Also worth checking once

- **Class meetings** — after a Google sync, the "Syllabus Center" calendar should
  show recurring class events for each meeting pattern, with no event on the
  holidays and breaks the syllabus names (Labor Day, Thanksgiving, after the
  last day of classes). A syllabus that mentions no breaks gets every week.
- **Sections** — upload a syllabus that lists several sections (big intro
  courses do). The upload result must ask which section you're in and add no
  class meetings until you answer; after choosing, a sync writes exactly that
  section's meetings and the "Removed" count clears anything stale.
- **Exam times** — an exam the syllabus gives as "12:30–1:50 PM" must appear
  on the calendar at 12:30–1:50, not as a block ending at 12:30. Assignments
  keep a block ending at the deadline.
- **Calendar feed** — in the Sync panel, create the feed link, then subscribe
  from Apple Calendar or Outlook. Reset the link and confirm the old URL 404s.

## 7. What to tell your testers

Paste this, edited for your voice:

> **Syllabus Center — please break it**
>
> Upload a course syllabus (PDF) and it pulls out your assignments, exams, due
> dates and grading weights, builds a week-by-week workload view, and can push
> everything to your Google Calendar with study blocks scheduled ahead of exams.
>
> **It will ask for Google access, including Calendar.** It needs Calendar
> permission to create events — that's the whole feature. It creates a **separate
> calendar called "Syllabus Center"** and writes only there. It never touches your
> primary calendar, and you can hide or delete the whole calendar in one click if
> you hate it.
>
> **You will see a scary "Google hasn't verified this app" warning.** That is
> expected. It's not a scam and it's not a virus — it means I haven't finished
> Google's app-verification process yet, which takes weeks and isn't worth it for
> a test. Click **Advanced**, then **Go to Syllabus Center (unsafe)**. If you're not
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
  budget, everyone else gets "Syllabus Center has reached its shared daily usage
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
  user's calendar stay until they delete the "Syllabus Center" calendar themselves.

**Accounts and data**

- **Sessions are a signed cookie, not an auth provider.** No revocation, no
  device list, no session store — a stolen cookie is valid for its full 30 days.
  Rotating `SESSION_SECRET` is the only mass logout available.
- Account deletion and data export live in the dashboard's Account panel.
  Deletion is total on our side; it never touches Notion pages and removes
  the Google "Syllabus Center" calendar only when the user asks.
- **Google refresh tokens are stored in plaintext** in
  `users.google_refresh_token`. The column is never selected into anything
  client-facing and access tokens are never persisted, so a leaked row expires
  the moment the user revokes the grant — but a database compromise is a
  compromise of everyone's calendar write access.
- **`/api/health` is unauthenticated.** It is boolean-only by design, but it does
  tell the internet which capabilities your deploy has and how long the instance
  has been up. That is the intended trade; know you made it.

---

## 9. Stripe (Academic Term Pass)

The Academic Term Pass is a one-time $5.99 payment that unlocks premium access
for one academic term — full product rules (the 183-day term cap, the 14-day
grace period, the one-free-course rule, how a paid term can and can't be
edited) are in `docs/TERM-PASS.md`, not repeated here. This section is only
the operational setup: what to create in the Stripe Dashboard, how to test it
locally, and what to check after a deploy.

Billing is optional and degrades independently of everything else: without
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_TERM_PASS_PRICE_ID`
all set, uploads and the rest of the app work exactly as they do today and the
Term Pass paywall shows "not configured" copy instead of a Buy button.

### 9a. Product and price

1. In the [Stripe Dashboard](https://dashboard.stripe.com), stay in **test
   mode** first (the toggle is top right) — do this whole section in test
   mode before touching live keys.
2. **Product catalog → Add product.** Name it exactly **Academic Term Pass**
   (this is display-only, but keep it unambiguous in your own dashboard).
3. Give it **one price**: **$5.99 USD**, billing type **One time**. Do not
   create a recurring price — the product has no renewal.
4. Save, then open the price and copy its id (`price_...`) into
   `STRIPE_TERM_PASS_PRICE_ID`. This id is the only place the price lives;
   `src/lib/pricing.ts` reads the displayed amount back from Stripe-adjacent
   config, and nothing in the codebase hardcodes `5.99`.
5. **Developers → API keys → Secret key** → copy into `STRIPE_SECRET_KEY`
   (`sk_test_...` for now). `STRIPE_PUBLISHABLE_KEY` lives on the same page;
   set it too even though the server does not read it today — it exists for
   a possible future client-side Stripe element.

### 9b. Webhook endpoint

Premium is granted **only** by a verified webhook — the success redirect
polls `GET /api/terms` and never activates anything itself, so an endpoint
that isn't delivering means nobody's purchase ever completes, with no error
visible in the UI.

1. **Developers → Webhooks → Add endpoint.**
2. Endpoint URL: `https://<APP_URL>/api/stripe/webhook` — the real deployed
   origin, not localhost (local testing uses the Stripe CLI instead, below).
3. Select exactly these events:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.expired`
4. Save, then open the endpoint and copy its **Signing secret**
   (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`.

### 9c. Local testing

`stripe trigger checkout.session.completed` fires a synthetic event with no
`client_reference_id` and no `metadata`, so the webhook handler has nothing to
look up a term by — it will not fail loudly, it will just look up the metadata
and find nothing to grant. Don't use `trigger` to test this flow.

1. Install the [Stripe CLI](https://stripe.com/docs/stripe-cli), then:

   ```bash
   stripe listen --forward-to localhost:3000/api/stripe/webhook
   ```

2. The CLI prints its own `whsec_...` value on startup. Use **that** value as
   `STRIPE_WEBHOOK_SECRET` in `.env.local` while `stripe listen` is running —
   not the Dashboard endpoint's secret, which only matches events Stripe sends
   directly to a deployed URL.
3. Run a real test-mode checkout through the app (start a checkout for a term,
   land on Stripe's hosted page) and pay with the standard test card
   `4242 4242 4242 4242`, any future expiry, any CVC. That produces a genuine
   `checkout.session.completed` event carrying the real `client_reference_id`
   and `metadata.user_id` / `metadata.term_id`, which the CLI forwards to your
   local server.
4. Confirm the term flips to premium (`GET /api/terms` shows
   `access: "premium"`) and that the terminal running `stripe listen` shows a
   `200` for the forwarded event.

### 9d. Going live

1. Switch the Dashboard out of test mode.
2. Re-create the price in **live mode** — test-mode and live-mode objects are
   separate; a `price_...` id from test mode does not exist in live mode.
   Copy the new id into the production `STRIPE_TERM_PASS_PRICE_ID`.
3. Create a **new** webhook endpoint for the live mode, same URL and same
   three events as 9b. It gets its own signing secret — copy that into the
   production `STRIPE_WEBHOOK_SECRET`; it is not the same value as the
   test-mode endpoint's.
4. Swap `STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY` for their
   `sk_live_...` / `pk_live_...` equivalents.
5. Redeploy — environment variable changes never apply to an existing
   deployment (same rule as every other variable in step 1).

### 9e. What to check after deploy

1. On a staging term, buy a pass in test mode (9c's card works in any
   environment still pointed at test-mode keys).
2. Confirm the term reads **"Term Pass Active"** in the dashboard.
3. Check the deploy log for the line `analytics.term_pass_purchased` — that
   is `src/lib/analytics.ts`'s structured log for a completed grant, and its
   absence with a successful-looking checkout means the webhook fired but the
   grant logic didn't run.
4. In the Stripe Dashboard, open the webhook endpoint's recent deliveries and
   confirm the event shows a **200** response. A delivery stuck retrying, or
   showing a 4xx/5xx, means the signature check or the raw-body handling
   (below) is misconfigured in that environment — the purchase went through
   on Stripe's side even though the app never saw it as valid.

### Deployment note: raw body and `APP_URL`

`POST /api/stripe/webhook` verifies the request with
`stripe.webhooks.constructEvent`, which hashes the **exact raw bytes** of the
request body against the `Stripe-Signature` header. Anything that
re-serializes the body before your route sees it — a body-parsing proxy, a
WAF that rewrites JSON, an edge middleware that reads and re-emits the
request — breaks the signature and every event is rejected. Make sure nothing
sits in front of this route that parses or rewrites the body.

`APP_URL` must be set in every environment that takes real payments: the
checkout session's success and cancel URLs
(`/dashboard?checkout=success&term=…`) are built from it, the same way the
calendar feed and OAuth redirect already depend on it (step 1). An unset
`APP_URL` on a host that trusts a forwarded `Host` header means a checkout
that redirects the payer somewhere you don't control.

### Migration

Re-run `supabase/schema.sql` — it is written to be idempotent (step 2), so
running it again on a database that predates the Term Pass adds the new
`academic_terms` and `stripe_events` tables and the `courses.term_id` column
without touching anything that already exists.

Two later additions follow the same idempotent pattern and need only the same
re-run: `pending_uploads` (a parse the paywall refused, kept until the term is
unlocked — see `docs/TERM-PASS.md`, "Pending uploads") and `users.profile`
(the onboarding card's answers, `jsonb`, defaults to `{}`). Both are guarded
`create table if not exists` / `add column if not exists`, so re-running
`schema.sql` on a live database adds them and touches nothing else.

There is no data-migration script to run. Existing courses have no `term_id`
until `ensureTermsBackfilled(userId)` groups a user's term-less courses into
terms on their **next dashboard load** — the same read-side pattern the
codebase already uses for every earlier schema addition. Nothing needs to be
scheduled or backfilled ahead of the deploy; the first login after this
release does the work per user, lazily. See "Existing users (migration and
grandfathering)" in `docs/TERM-PASS.md` for exactly how courses get grouped.

---

## 10. Watching the numbers (`/admin`)

`/admin` is a metrics page for you, the operator: sign-ups, paying members,
passes sold, and the live OAuth scope table from 3d. It is a server-rendered
page that reads the store directly — no API route, no client JavaScript, no
second login.

Turn it on by listing yourself:

```
ADMIN_EMAILS=you@gmail.com
```

Comma-separated for more than one, matched case-insensitively against the
signed-in user's email. **Unset means nobody**: the page 404s for everyone,
including you. It also 404s rather than 403s for a signed-in non-admin, so the
URL does not confirm to a curious student that a metrics page exists.

What the numbers mean:

| Stat | Exactly what it counts |
|---|---|
| Sign-ups | Rows in `users` whose id is not a `demo_…` sandbox |
| New in the last 7 / 30 days | Same, filtered on `created_at` |
| Demo sandboxes | `demo_…` rows. Listed so the `users` table's size is not a mystery |
| Paying members | Distinct `user_id` over `academic_terms` where `premium` is true |
| Passes sold | Those rows, not deduplicated — the repeat-purchase signal |
| Passes active today | Of those, the ones whose `premium_expires_at` has not passed |
| Gross revenue | Passes sold x the current display price. **An estimate** — Stripe is the ledger, and this ignores refunds and any past price |

Two further sections, added once the product had real usage to report:

| Section | What it shows |
|---|---|
| **Usage** | Activated accounts (signed in *and* uploaded), courses, deadlines extracted, calendar connections, events actually written, feed subscribers, Notion connections, and **stalled at the paywall** — syllabi parsed, refused, and never unlocked. That last one is the paywall's conversion gap as a single number |
| **Who signed up** | The onboarding card's answers as breakdowns: top ten schools (canonical names only), year, and how they found you. Also how many answered, skipped, or have not been asked, and how many typed a school the list did not have — if that grows, the list needs those schools |

Everything is a count or a top-N over real accounts. Demo sandboxes are excluded
from all of it, no row is ever shown, and free-typed text (a school that
matched nothing) is counted but never displayed.

The counts are taken live on every load and are never cached. On Supabase they
are four `count`-only queries plus one small select over paid terms, so the cost
does not grow with sign-ups.

**This is not a funnel tool.** How many people saw the paywall, started a
checkout and abandoned it are moments in time, not rows, and they go to the log
drain as `analytics.*` lines from `src/lib/analytics.ts`. If you want those
charted, that is where a real analytics vendor would plug in — one function,
`track()`, not the call sites.

---

## 11. Analytics and A/B tests

Two systems, doing two different jobs. Keep them straight and neither will
mislead you.

| | `/admin` | PostHog |
|---|---|---|
| Answers | How many signed up, how many paid | Where people drop out, whether they come back, which variant won |
| Source | Your own `users` and `academic_terms` tables | Named events from the browser and the server |
| Accuracy | Exact | Best-effort — ad blockers and opt-outs cost you some |
| Use it for | Revenue, totals, anything you'd quote | Funnels, retention, experiments |

If the two disagree on revenue, `/admin` is right and PostHog is under-counting.
That is expected, not a bug.

### 11a. Turning PostHog on

```
NEXT_PUBLIC_POSTHOG_KEY=phc_xxxxxxxx
NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com
```

The **project** key from PostHog → Settings → Project. It is public by design:
it can write events and read nothing. Never put a personal API key here.

Without a key everything still works — events still hit your log drain, the A/B
tests still run and are still assigned identically. You lose the charts, nothing
else.

`next.config.ts` reads the same two variables to open exactly one host in the
Content-Security-Policy. No other host is opened, and `script-src` is untouched
because `posthog-js` is bundled from npm rather than loaded from a CDN.

### 11b. What is deliberately not collected

`src/lib/analytics-client.ts` disables **autocapture** and **session replay**.
That is not a default left in place — both are switched off on purpose, and the
privacy policy is written against that configuration:

- Autocapture records the text of whatever was clicked. Here that text is course
  codes, assignment titles and instructors' names.
- A session replay of the dashboard is a recording of somebody's semester.

Also never sent: email addresses, names, Google data, tokens, chat messages, the
calendar feed token. `identify()` gets an account id and nothing else, and demo
sandboxes are not identified at all.

Do Not Track and Global Privacy Control switch analytics off for that visitor
automatically. GPC has legal weight in California; honouring it is what makes the
privacy policy's claim true.

**If you change any of this, change the privacy policy in the same commit.** A
privacy policy describing a configuration you no longer run is the one kind of
documentation bug with legal consequences.

### 11c. The funnel

```
demo_started -> landing_cta_clicked -> signed_in
             -> syllabus_uploaded -> first_course_created -> calendar_synced
             -> second_course_paywall_viewed -> term_checkout_started -> term_pass_purchased
```

Server and browser events share a `distinct_id`, so a funnel crosses the
boundary — which it has to, because "saw the paywall" happens in a browser and
"paid" happens in a Stripe webhook.

`calendar_synced` is the retention event worth watching. It is the point at which
the plan stops living in a tab, and it predicts whether somebody comes back.

Event names are an allow-list in `src/lib/analytics.ts`; adding one means adding
it there. **No event may carry syllabus content, Google data, or anything that
names a student.** Ids, counts, variants and enum-ish labels only.

### 11d. Running an A/B test

Experiments live in `src/lib/experiments.ts` and are decided by a hash of the
experiment key and the subject id — no vendor, no network call, no flag service.
That buys three things:

1. **The server decides.** The price test picks a Stripe price id. A browser that
   chose its own variant would be choosing its own price.
2. **Sticky for free.** Same person, same arm, every visit, every device, because
   it is a function of their id rather than a coin flip someone stored. Nobody is
   ever quoted two different prices.
3. **It cannot fail.** No flag fetch to be slow or down.

Three tests ship wired up:

| Experiment | Arms | Where |
|---|---|---|
| `landing_hero` | `control`, `outcome` | Hero headline, subhead and CTA |
| `paywall_copy` | `control`, `outcome` | Term Pass card heading and body |
| `term_pass_price` | `control`, `higher` | The actual Stripe price charged |

**To start the price test**, create a second one-time price on the same Stripe
product and set `STRIPE_TERM_PASS_PRICE_ID_HIGHER` to its id. Unset it and the
test is off — every arm falls back to `STRIPE_TERM_PASS_PRICE_ID`, so a
half-configured environment charges the normal price rather than failing
checkout. No deploy either way.

The displayed amount is read back **from Stripe** for whichever price applies and
is never configured anywhere. That is what lets the Terms promise the price shown
is the price charged, and it is why there is no `..._AMOUNT` variable to forget.

**To read the results**, split any funnel in PostHog by the experiment's
property — every event carries all three assignments as super properties.

**To end a test**, delete it from `EXPERIMENTS` and remove the losing branch. The
call sites fall back to the control, which should be the arm you keep.

**Never rename a live experiment key.** The key is half the hash input, so a
rename rebuckets everyone — and mid-flight on the price test that means quoting a
returning customer a different price. Change the variants, never the key.

### 11e. Reading the results honestly

At a thousand users you will not have significance on a small effect quickly. A
paywall conversion rate moving from 4% to 5% needs a few thousand views per arm
before it means anything. PostHog's experiment view will tell you; believe it
over the shape of the line.

Run one experiment per surface at a time. All three ship enabled because they
touch three different screens and three different decisions — a landing headline,
a paywall's words, and its price. Adding a fourth that also touches the paywall
would make both unreadable.

---

### 11f. Error tracking

There is no Sentry here, and for now that is a decision rather than an omission.

**Server errors** already go to your log drain: 24 of 31 routes call
`logApiError`, and the ones that do not are redirects that cannot fail into
JSON. Every webhook failure mode is logged by name, including
`stripe.webhook_grant_missed` — somebody paid and did not get access.

**Client errors** now go to PostHog. `posthog-js` ships `captureException`, so
this needed no new dependency:

- `PanelBoundary` wraps each dashboard panel, so one crashing panel shows an
  inline error and the other nine keep working. Without it, a single
  `undefined.map` in the heatmap replaced the upload box, the calendar sync and
  the chat with an error screen.
- `src/app/error.tsx` and `global-error.tsx` are the outer nets, for the shell
  and the root layout.
- `installGlobalErrorHandlers()` catches what no boundary can — rejected
  promises in event handlers, `setTimeout` callbacks, third-party scripts.

Client errors deliberately do **not** go to the log drain. `/api/analytics`
allow-lists event names precisely so a client cannot write free text into a
drain that people read and alert on, and an error message is the most free-text
thing there is. PostHog is built for untrusted client input and groups
duplicates, which is the difference between "this broke 400 times for one
person" and "this broke for 400 people".

A visitor who opted out of analytics reports nothing. That is the cost of
honouring the opt-out honestly.

#### Email alerts

A log drain answers questions you already thought to ask, after somebody
complains. These push instead.

```
RESEND_API_KEY=re_xxxxxxxx
ALERT_EMAIL_TO=you@gmail.com
ALERT_EMAIL_FROM=alerts@yourdomain.com
```

`ALERT_EMAIL_FROM` must be on a domain verified with the provider or every send
is rejected. Resend's free tier covers this many times over; any provider with
an HTTP API works, and `send()` in `src/lib/alerts.ts` is the only ~20 lines
that know which one you use.

**What alerts:**

- Every `error`-level line — which means every route failure, since they all go
  through `logApiError`.
- A short allow-list of `warn` events that all mean *a student was charged and
  something did not happen*: `stripe.webhook_grant_missed`,
  `webhook_term_not_found`, `webhook_term_without_end_date`,
  `webhook_missing_metadata`, `webhook_unverified`.

That allow-list is the point. Alerting on severity alone would have missed every
one of them, because they are all logged at `warn` — the webhook ran fine and
*decided* not to grant. From the student's side that is indistinguishable from
the payment failing, except they have been charged.

Each email carries the ids and what to do about it, because an alert that names
a problem without naming the next step is a notification, not an alert.

**What does not alert:** expected 404s, `notFound()`, rate-limit denials,
validation failures. Probing `/admin` does not wake you up.

**Throttling — the part that decides whether this survives.** At most one email
per event name per hour, and at most 20 an hour in total. Without the first, one
broken route sends an email per request; without the second, a deploy that
breaks ten things at once sends ten storms. An operator who learns to filter the
alert address to trash is worse off than one with no alerting, so the caps are
deliberately tight. Everything suppressed is still in the log drain under the
same event name.

Counters are in memory, so on serverless they are per-instance: a wide outage
across N warm instances can send up to N times these numbers. For alerting that
is the right direction to be wrong in.

#### Where errors are caught

Two layers, because one was not enough:

- `logApiError` in each route's `catch` — the normal path.
- `src/instrumentation.ts` (`onRequestError`) — everything that throws *outside*
  a route's `try`. That is not a hypothetical: routes resolve the caller before
  the try block opens, and `resolveVisitor()` reads and writes the store. When
  the store is down, roughly twenty routes throw before their own error handling
  exists, Next turns it into a 500, and nothing in the app is told. The failure
  most worth being woken up for was the one that could not page anybody.

An error caught and logged by a route never reaches the hook, so nothing is
reported twice.

#### Verifying it works

The fast way: `/admin` → **Send a test alert**. It sends one real email past
the throttle and prints the provider's exact answer. "API key is invalid",
"domain is not verified", and "not configured" all look identical from an
empty inbox and are three different fixes here. `GET /api/health` also reports
`capabilities.alerts` — true only when both `RESEND_API_KEY` and
`ALERT_EMAIL_TO` are set in that environment.

The slower way, from before the button existed:

Set a deliberately wrong `RESEND_API_KEY`, cause any 500, and look for this in
the server log:

```
[alerts] provider rejected the alert for "server.unhandled" (401)
```

A 401 is a good sign — it means the request was well-formed and reached the
provider. With a real key that line is an email instead.

#### When to add Sentry

Add it when one of these is true, not before:

- You want **source-mapped stack traces** from minified production bundles.
  PostHog's are serviceable; Sentry's are better.
- You want **release tracking** — "this started at deploy 47".
- You want **alerting on new errors** without building it yourself.
- Server-side exceptions need grouping too, not just a searchable log.

At that point it is a `@sentry/nextjs` install and a config file, and the
boundaries built here keep working unchanged — only `reportError` changes.

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

---

## Appendix: Notion

Optional. Without `NOTION_CLIENT_ID` / `NOTION_CLIENT_SECRET` the dashboard's
Notion panel explains it is not configured and nothing else changes.

1. Go to https://www.notion.so/my-integrations → **New integration**.
2. Type must be **Public** (Internal integrations have no OAuth flow and cannot
   be connected by other people's workspaces).
3. Redirect URI: `https://<your-app>/api/notion/callback` — exact match, same
   rule as Google.
4. Capabilities: read, update and **insert** content. No user-information
   capability is needed.
5. Copy the OAuth client ID and secret into the service's variables and
   redeploy.

When a tester clicks **Connect Notion**, Notion's consent screen asks them to
pick pages to share. Tell them to pick **one** page — the hub gets built under
it. Sharing several is fine; they will be shown a picker.

Notion allows an average of 3 requests/second **per integration, across all
your users**. A full sync of one course is ~40 requests, so the app throttles
itself and rate-limits each user to 4 Notion syncs per minute. A dozen active
testers is comfortable; a hundred syncing at once would queue.

Notion tokens do not expire; a tester who removes the integration from their
workspace shows up as "Notion access was removed" and simply reconnects.

Design and limits: `docs/NOTION.md`.
