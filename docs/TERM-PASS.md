# Academic Term Pass

One-time payment for premium access to one academic term. Stripe takes the
money; Syllabus Center decides what a term is and when access ends.

This document is the implementation plan and the developer reference. The
plan section is kept as written before the code, so the decisions can be
checked against what shipped.

## Product rules

- A **term** belongs to a user: name, type, start date, end date. Types are
  labels (`semester`, `quarter`, `trimester`, `summer`, `winter`, `j_term`,
  `custom`); they never set dates. A term is at most **183 days** long.
- Every term allows **one course free**. The free course is the full product.
- Adding a second course to a term that is not premium shows the Term Pass
  paywall. The server enforces this; the UI only shows it early.
- **Academic Term Pass — $5.99**, one-time, `mode: "payment"`. No renewal.
- Premium is a property of the term, not the account. It expires **14 days
  after the term's end date** (`premiumExpiresAt` in `src/lib/terms.ts`, the
  only place that arithmetic lives).
- Premium is granted **only** by the verified `checkout.session.completed`
  webhook. The success redirect polls; it never activates anything.

## Plan

### Data model

New type `AcademicTerm` (`src/lib/types.ts`) and table `academic_terms`:

| column | type | notes |
| --- | --- | --- |
| id | uuid | |
| user_id | text | FK users, cascade |
| name | text | "Fall 2026", "Quarter 2", anything |
| term_type | text | enum above |
| start_date / end_date | text | ISO dates, like every date in this schema |
| free_courses | int, default 1 | the free allowance; backfilled terms get the count they were created with (see Existing users) |
| confirmed_at | text null | null while the term was inferred from a syllabus and the student has not confirmed it |
| premium | boolean default false | |
| premium_started_at / premium_expires_at | text null | |
| paid_end_date | text null | end_date at the moment of purchase; caps later edits |
| stripe_checkout_session_id / stripe_payment_intent_id / stripe_customer_id | text null | |
| created_at / updated_at | text | |

`courses.term_id uuid null references academic_terms(id) on delete set null`.
The existing `courses.term` text column stays as the display fallback for a
course that has no term row; nothing is dropped.

Table `stripe_events (id text primary key, type text, processed_at text)` for
webhook idempotency: the insert is the lock, and a duplicate event id is a
no-op.

The local JSON driver gets `terms` and `stripeEvents` arrays with read-side
defaults, exactly like every earlier addition.

### Where the logic lives

- `src/lib/terms.ts` (pure, tested): `MAX_TERM_DAYS = 183`,
  `PREMIUM_GRACE_DAYS = 14`, `premiumExpiresAt(endDate)`,
  `termHasPremiumAccess(term, now)`, `canAddCourse(term, courseCount)`,
  `validateTermInput`, `suggestTerm(parsed, existingTerms)` (inference and
  overlap matching), `seasonName(startDate)` (a *name* suggestion only).
- `src/lib/pricing.ts`: the display price object. Stripe's price id comes from
  `STRIPE_TERM_PASS_PRICE_ID`; the amount shown in the UI comes from here.
  Nothing else in the tree says 5.99.
- `src/lib/stripe.ts`: the SDK client, `createTermPassCheckout`,
  `verifyWebhook`. Tests mock this module.
- `src/lib/analytics.ts`: `track(event, fields)` → one structured log line
  (`analytics.<event>`), the hook a vendor can be wired to later.
- `src/lib/term-backfill.ts`: the lazy migration for existing courses.

### Routes

| route | purpose |
| --- | --- |
| `GET /api/terms` | the user's terms with course counts and `access` (free / premium / expired) |
| `POST /api/terms` | create a term (validated) |
| `PATCH /api/terms/[id]` | edit name/type/dates; confirm; premium edit policy applied |
| `DELETE /api/terms/[id]` | only when it holds no courses |
| `POST /api/terms/[id]/checkout` | ownership-checked; creates the Checkout Session; returns `{ url }` |
| `POST /api/stripe/webhook` | signature-verified; idempotent; grants premium |
| `POST /api/analytics` | client-side funnel events, allow-listed names |
| `POST /api/upload` (modified) | accepts `termId` or `newTerm`; resolves the term; enforces the paywall (402) before creating the course |
| `PATCH /api/courses/[id]` (modified) | accepts `termId`; moving a course into a full free term is refused the same way |
| `GET /api/config` (modified) | adds `billing: { ready, termPass }` for the UI |

The paywall answer is `402` with `{ error, paywall: { term, courseCount } }`.

### Upload flow

The first syllabus is the activation moment, so nothing is added in front of
it. The upload panel sends its best guess of the term (`termId`), or nothing.
Server side, after the parse:

1. `termId` given → that term (must be the user's).
2. Else `suggestTerm(parsed, terms)`: an existing term whose dates overlap the
   course's by at least half the course span is selected automatically.
3. Else a new term is created from the syllabus — name from the syllabus's
   own term label or the season of the start date, dates from the course
   bounds (falling back to the assessment date range) — with
   `confirmed_at = null`. The dashboard's setup card then asks **"Create
   Fall 2026? September 3 – December 17"** with *Create term* / *Edit dates*.
   Confirming sets `confirmed_at`; editing opens the term editor. Nothing is
   silently final, and the parse is not paid for twice.
4. If the syllabus gives no usable dates, the term is created with the label
   only and the setup card asks for name, start and end.

Before parsing, the client already knows whether the selected term is full
and not premium, and shows the paywall instead of uploading. The server
check after the parse is the enforcement; the client check is the courtesy.

### Checkout and webhook

`POST /api/terms/[id]/checkout`: real (non-demo) user, owns the term, term
confirmed, not already premium. Session: `mode: "payment"`, one line item of
`STRIPE_TERM_PASS_PRICE_ID`, `client_reference_id = termId`,
`metadata = { user_id, term_id }`, `customer_email`, success and cancel URLs
on `APP_URL` (`/dashboard?checkout=success&term=…`). The session id is stored
on the term. Demo visitors get 403 and the UI offers Google sign-in instead.

`POST /api/stripe/webhook`: raw body, `stripe.webhooks.constructEvent` with
`STRIPE_WEBHOOK_SECRET`. On `checkout.session.completed` with
`payment_status = "paid"`: record the event id (duplicate → 200, done); load
the term by `(user_id, term_id)` from metadata; grant premium, set
`premium_started_at`, `premium_expires_at = end_date + 14 days`,
`paid_end_date`, the Stripe ids. `checkout.session.expired` logs
`term_checkout_abandoned`. Unknown events are acknowledged and ignored.

### Success screen

`/dashboard?checkout=success&term=…` polls `GET /api/terms` every two seconds
for up to thirty seconds until the term reads premium, then shows "Your
Academic Term Pass is active. Fall 2026 is unlocked." If the webhook is slow
it says so and keeps the term visible; it never reports a failure it cannot
know about.

### Editing a paid term

Corrections are allowed; extensions are bounded. For a premium term, a new
end date must keep the term within 183 days and must not push
`premium_expires_at` more than **30 days** past what was bought
(`paid_end_date + 14 + 30`). Shortening is always allowed and moves the
expiry earlier. Start date edits cannot move the end. All of this is server
side in the PATCH validator; the client mirrors the six-month rule only.

### Existing users (migration and grandfathering)

No SQL data migration. `ensureTermsBackfilled(userId)` runs once per user on
the next read of their courses (the same read-side pattern the codebase uses
for every earlier column). It groups the user's term-less courses:

1. by their `term` text when present (normalized), else
2. by overlapping date ranges (a course joins a group when its dates overlap
   the group's by at least half its own span), else
3. into one group of "undated" courses.

Each group becomes a term named from the label, or the season of its start,
or "My courses"; dates are the union of the group's dates (clamped to 183
days); `free_courses` is the number of courses in the group, and
`confirmed_at` is set (nothing is asked of a user who did nothing new).
So every existing course stays visible and editable, a user with three
migrated courses keeps all three, and the paywall applies only to the next
course added to that term or to any new term. Demo sandboxes go through the
same path, so their three seeded courses are one grandfathered term.

### Security

Secret key, webhook secret and price id are server-only environment
variables. The client never sends a price or a price id. Term ownership is
checked by `user_id` on every term route. The webhook verifies the signature
and reads the user and term from Stripe's copy of the metadata, never from
the request body. The redirect query string grants nothing. Term dates are
validated server side on create and edit. Checkout and term mutations sit
behind the existing `crossSiteDenied` check and the session cookie; the
webhook is exempt from the Origin check because it is signed.

### Tests

The project has no test runner. `vitest` is added as a dev dependency with
`npm test`; the alias `@/` is mapped to `src/`. Stripe is mocked at
`src/lib/stripe.ts`. The route handlers are called directly with a mocked
session. Tests cover the fifteen cases in the brief.

### Risks

- The webhook URL must be registered in Stripe for the production origin,
  and `APP_URL` must be set (it already must be, for OAuth).
- Stripe's SDK is server-only; nothing Stripe touches a client bundle.
- Railway's Node version must be 18+ for the SDK (the project already runs
  Next 15, which needs that).
- A student who hits the server-side paywall after a parse has spent one
  parse; the client-side check makes that the rare path.

## Reference

### What shipped, and where

| concern | file |
| --- | --- |
| types (`AcademicTerm`, `TermInput`, `TERM_TYPES`, `Course.termId`) | `src/lib/types.ts` |
| pure rules: length cap, grace period, entitlement, validation, inference | `src/lib/terms.ts` |
| entitlement over the store: `TermSummary`, `assertCanAddCourse`, `PaywallError`, `resolveTermForUpload` | `src/lib/entitlement.ts` |
| lazy migration of existing courses | `src/lib/term-backfill.ts` |
| display price | `src/lib/pricing.ts` |
| Stripe client, Checkout Session, webhook verification | `src/lib/stripe.ts` |
| funnel events | `src/lib/analytics.ts` |
| store methods (both drivers) | `src/lib/store/index.ts`, `local.ts`, `supabase.ts` |
| schema | `supabase/schema.sql` |
| routes | `src/app/api/terms/**`, `src/app/api/stripe/webhook`, `src/app/api/analytics`; changes in `upload`, `courses/[id]`, `courses`, `config` |
| UI | `src/components/dashboard/term-pass-card.tsx`, `terms-panel.tsx`, `term-form.tsx`; changes in `upload-panel.tsx`, `course-editor.tsx`, `setup-card.tsx`, `roadmap-panel.tsx`, `src/app/dashboard/dashboard-shell.tsx`, `src/components/api-client.ts`, `src/lib/setup.ts` |
| tests (vitest) | `src/lib/*.test.ts`, `src/lib/store/local.terms.test.ts`, `src/app/api/terms/*.test.ts`, `src/app/api/stripe/webhook.test.ts` |

### Decisions made while building

- **The demo sandbox's sample term has one spare free slot.** The three
  fixture courses go into one term with `free_courses = 4`, so a visitor can
  upload a syllabus of their own before meeting the paywall. A demo visitor
  who then wants a pass is sent to Google sign-in; purchases attach only to
  durable accounts.
- **The paywall appears on the attempt, not on page load.** A full term shows
  a one-line note under the term chooser; the card replaces the dropzone
  only when a file is chosen for that term, or when the server answers 402.
- **The backfill is serialized per user** in process. The dashboard requests
  courses and terms in parallel and both routes run the backfill; without
  the lock, both saw every course term-less and each made a term.
- **The webhook releases its idempotency claim on failure.** The event id is
  claimed before the grant (the insert is the lock against a concurrent
  duplicate delivery); if the grant throws, the claim is deleted so Stripe's
  retry runs it again instead of being answered as a duplicate.
- **`second_course_paywall_viewed` is tracked by the card**, not the 402
  response, so the pre-upload and post-parse paths count once each.
- **`next lint` is not configured in this project** (no ESLint config; the
  command prompts to create one). The gates are `npm run typecheck`,
  `npm run build` (which validates types) and `npm test`.

### Environment variables

| name | required for | where it comes from |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | creating Checkout Sessions | Dashboard → Developers → API keys (`sk_test_…` / `sk_live_…`) |
| `STRIPE_WEBHOOK_SECRET` | verifying webhooks | the endpoint's signing secret (`whsec_…`), or the Stripe CLI's printed secret locally |
| `STRIPE_TERM_PASS_PRICE_ID` | the one-time price to charge | the price's id (`price_…`) on the product |
| `STRIPE_PUBLISHABLE_KEY` | not used by the server today | kept for a future client-side element |
| `APP_URL` | success and cancel URLs | already required in production |

Without the three required values, `GET /api/config` reports
`billing.ready = false`, the paywall says payments are not set up, checkout
answers 503, and everything else works.

### Stripe Dashboard setup

1. Test mode on. Products → Add product: name "Academic Term Pass", one-time
   price $5.99 USD. Copy the price id into `STRIPE_TERM_PASS_PRICE_ID`.
2. Developers → API keys: copy the secret key into `STRIPE_SECRET_KEY`.
3. Developers → Webhooks → Add endpoint: `https://www.syllabuscenter.com/api/stripe/webhook`,
   events `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.expired`. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
4. Set the three variables on Railway, redeploy, and re-run
   `supabase/schema.sql` against the project (idempotent; adds
   `academic_terms`, `stripe_events`, `courses.term_id`).
5. Going live: repeat 1–3 in live mode (a live price id, live secret key, a
   live webhook endpoint with its own secret) and swap the variables.

### Testing locally

- `npm test` runs the suite with Stripe mocked; no network.
- End to end: `stripe listen --forward-to localhost:3000/api/stripe/webhook`
  prints a `whsec_` for `STRIPE_WEBHOOK_SECRET`; run the app with the test
  keys; buy a pass with card `4242 4242 4242 4242`. `stripe trigger` events
  do not carry this app's metadata, so use a real test-mode checkout.
- Watch the log for `analytics.term_checkout_started`,
  `stripe.term_pass_granted`, `analytics.term_pass_purchased`; the Stripe
  Dashboard's webhook page should show 200s.

### Still manual

- Creating the Stripe product/price and webhook, and setting the variables
  on Railway (secrets never pass through this repo).
- Re-running `supabase/schema.sql` on the production project.
- Adding the live-mode price and endpoint when leaving test mode.
