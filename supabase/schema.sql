-- Syllabus Center -- Postgres schema.
--
-- Dates are stored as `text`, not `date`/`timestamptz`, because the domain
-- types in src/lib/types.ts are strings: a syllabus gives "2025-10-14" with no
-- timezone, and round-tripping that through a timestamp invents an offset the
-- source never stated. Structured-but-schemaless course fields (meeting times,
-- grade weights, policies) are `jsonb` so the extractor can evolve their shape
-- without a migration.
--
-- Run against a fresh project:  psql "$DATABASE_URL" -f supabase/schema.sql
--
-- RE-RUNNING THIS FILE IS SAFE, BUT IT IS NOT A MIGRATION TOOL.
-- Every statement is guarded (`if not exists`, `drop policy if exists`), so a
-- re-run is a no-op on an up-to-date database. That guard is also the trap:
-- `create table if not exists` will NOT alter a table that already exists.
--
-- In particular, `users.id` and `courses.user_id` changed from `uuid` to `text`
-- (see the users table below for why). A database created from an older copy of
-- this file still has `uuid` columns, and re-running this will not fix them --
-- it will succeed silently and the first Google sign-in will still fail with
-- `invalid input syntax for type uuid`. Until there is data worth keeping, the
-- fix is to drop the four tables and run this file again:
--
--   drop table if exists public.calendar_links, public.assessments,
--                        public.courses, public.users cascade;
--
-- `notion_connections`, `notion_links`, `academic_terms` and `stripe_events` are
-- NEW. A database created before they existed simply does not have them, and
-- because they are additions rather than alterations, re-running this file does
-- create them -- no drop needed.
--
-- COLUMNS ADDED TO EXISTING TABLES need an explicit `alter table ... add column
-- if not exists` line, since `create table if not exists` will not add them.
-- The ones that exist so far:
--
--   users.timezone                -- IANA zone reported by the browser
--   users.calendar_feed_token     -- secret in the user's private .ics feed URL
--   users.calendar_prefs          -- what the sync and the .ics feed include
--   assessments.reviewed_at       -- when the student confirmed or edited the item
--   assessments.end_time          -- when a sitting ends, when the syllabus gave a range
--   courses.no_class              -- term days when the class does not meet
--   courses.section               -- the section the student picked, of the many listed
--   courses.sections              -- one section per question the syllabus asks
--   courses.term_id               -- the academic term the course belongs to
--   calendar_links.user_id        -- who a synced event belongs to
--
-- `calendar_links` also RESHAPED: its `assessment_id uuid` primary key became
-- `key text`, and the foreign key to `assessments` is gone. See that table.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------

-- `id` is TEXT, not uuid, on purpose. The application supplies it: real users
-- get Google's `sub` claim (a ~21-digit numeric string) so an account survives
-- an email change, and demo mode uses the literal "demo-user". Neither is a
-- uuid, so a uuid column rejects the very first sign-in with
-- `invalid input syntax for type uuid`.
create table if not exists public.users (
  id                    text primary key,
  email                 text not null unique,
  name                  text,
  picture               text,
  -- Long-lived Google credential. Never selected into anything client-facing.
  google_refresh_token  text,
  -- IANA zone reported by the user's browser. Nullable: it arrives after the
  -- first sign-in, and calendar sync falls back to the server zone until then.
  timezone              text,
  -- Secret embedded in the user's private calendar-feed URL. Like
  -- google_refresh_token above, it is a credential: never selected into
  -- anything client-facing, never logged. Anyone holding it can read that
  -- user's whole semester, since a calendar app polling the feed cannot present
  -- a session. Unique so a feed lookup is an exact single-row match, and
  -- nullable because it is minted on first use, not at sign-up.
  calendar_feed_token   text unique,
  -- What the calendar sync and the .ics feed include, as
  -- `{classes, recitations, officeHours, deadlines, studySessions}` booleans.
  -- `{}` rather than the full object is the default on purpose: the shape is
  -- owned by DEFAULT_CALENDAR_PREFS in src/lib/types.ts, and a stored copy of
  -- it would go stale the day a preference is added. Every read is merged over
  -- those defaults (`mergeCalendarPrefs`), so a partial value -- including this
  -- empty one -- always comes back complete.
  calendar_prefs        jsonb not null default '{}'::jsonb,
  created_at            text not null
);

-- Migration for databases created before `timezone` existed. `create table if
-- not exists` above is a no-op on those, so the column has to be added here;
-- `add column if not exists` makes running the whole file again a no-op too.
alter table public.users add column if not exists timezone text;

-- Migration for databases created before `calendar_feed_token` existed. The
-- unique index is created separately because `add column if not exists` cannot
-- carry the constraint on a re-run.
alter table public.users add column if not exists calendar_feed_token text;
create unique index if not exists users_calendar_feed_token_idx
  on public.users (calendar_feed_token);

-- Migration for databases created before `calendar_prefs` existed. Existing
-- rows get `{}`, which reads back as the documented defaults.
alter table public.users
  add column if not exists calendar_prefs jsonb not null default '{}'::jsonb;

-- Optional onboarding answers (school, year, how they found the app). jsonb so
-- a question can be added or dropped without a migration, and `{}` rather than
-- null so "never answered" and "skipped" read the same to every caller. This
-- is the one thing the app asks that a syllabus cannot tell it; nothing in the
-- product depends on it, and it is never sent to a third party except as a
-- coarse label on an analytics event (see src/lib/analytics.ts).
alter table public.users
  add column if not exists profile jsonb not null default '{}'::jsonb;

create index if not exists users_email_idx on public.users (lower(email));

-- ---------------------------------------------------------------------------
-- courses
-- ---------------------------------------------------------------------------

create table if not exists public.courses (
  id             uuid primary key default gen_random_uuid(),
  -- text, to match users.id above.
  user_id        text not null references public.users (id) on delete cascade,
  code           text not null,
  title          text not null,
  instructor     text,
  term           text,
  start_date     text,
  end_date       text,
  -- One entry per meeting the syllabus states, each carrying its own `kind`
  -- (lecture / recitation / lab / office_hours / other), `section` label and
  -- `instructor`. A big course's syllabus lists EVERY section, and they are all
  -- kept: see `sections` below for which ones are the student's.
  meeting_times  jsonb not null default '[]'::jsonb,
  -- The sections the student chose, each matching a `section` label in
  -- meeting_times. An ARRAY because a syllabus asks one question per meeting
  -- kind, not one question overall: two lectures and three labs is a choice of
  -- lecture AND a choice of lab, and the student attends one of each. While a
  -- question is unanswered its meetings are not synced, because guessing puts
  -- the student in someone else's classroom.
  sections       jsonb not null default '[]'::jsonb,
  -- The single answer this replaced. Kept, never written to again: reads fall
  -- back to it as a one-element array (see `courseToDomain`), so a student who
  -- had already picked their lecture keeps that answer and is simply asked the
  -- lab question nobody ever put to them.
  section        text,
  -- Inclusive date ranges when the class does NOT meet -- holidays, recesses,
  -- and everything after the stated last day of classes. Drives which class
  -- meetings are left off the calendar. `[]` means "meets every week of the
  -- term", which is the honest default for a syllabus that says nothing.
  no_class       jsonb not null default '[]'::jsonb,
  grade_weights  jsonb not null default '[]'::jsonb,
  policies       jsonb not null default '[]'::jsonb,
  created_at     text not null
);

-- Migration for databases created before `no_class` existed. `create table if
-- not exists` above is a no-op on those, so the column has to be added here;
-- `add column if not exists` makes running the whole file again a no-op too.
alter table public.courses
  add column if not exists no_class jsonb not null default '[]'::jsonb;

-- Migration for databases created before `section` existed. Meetings stored
-- before `kind`/`section`/`instructor` existed need no migration: meeting_times
-- is jsonb, and every read completes them (`normalizeMeetingTimes`).
alter table public.courses add column if not exists section text;

-- Migration for databases created before `sections` existed. The legacy
-- `section` column above is deliberately NOT dropped and NOT backfilled here:
-- the read side folds it in (`section ? [section] : []`), so nobody's answer is
-- lost and no migration has to run before the app is safe to deploy.
alter table public.courses
  add column if not exists sections jsonb not null default '[]'::jsonb;

create index if not exists courses_user_id_idx on public.courses (user_id);

-- ---------------------------------------------------------------------------
-- assessments
-- ---------------------------------------------------------------------------

create table if not exists public.assessments (
  id              uuid primary key default gen_random_uuid(),
  course_id       uuid not null references public.courses (id) on delete cascade,
  title           text not null,
  kind            text not null default 'other',
  due_date        text,
  -- For a deadline, the cutoff; for a sitting (exam, quiz, presentation), when
  -- it STARTS. `end_time` is when that sitting ends, and is set only when the
  -- syllabus actually wrote a range ("12:30-1:50 PM") -- null otherwise, and
  -- meaningless without `due_time`. Keeping the end is what stops the calendar
  -- from drawing a default-length block that ENDS at the start of the exam.
  due_time        text,
  end_time        text,
  weight_percent  numeric,
  source_text     text,
  -- 0..1 extractor confidence; the UI surfaces anything under 0.6 for review.
  confidence      numeric not null default 0,
  -- ISO timestamp of the moment the student confirmed or edited this item;
  -- null until they do. Text, like every other date here, because the domain
  -- type is a string. Kept separate from `confidence` on purpose: a reviewed
  -- item is treated as certain everywhere, while the extractor's own score
  -- stays an honest record of how the row was produced.
  reviewed_at     text,
  notes           text,
  constraint assessments_kind_check check (
    kind in ('assignment','exam','quiz','project','reading','lab','presentation','other')
  ),
  constraint assessments_confidence_check check (confidence >= 0 and confidence <= 1)
);

-- Migration for databases created before `reviewed_at` existed. `create table
-- if not exists` above is a no-op on those, so the column has to be added here;
-- `add column if not exists` makes running the whole file again a no-op too.
alter table public.assessments add column if not exists reviewed_at text;
alter table public.assessments add column if not exists end_time text;

create index if not exists assessments_course_id_idx on public.assessments (course_id);
create index if not exists assessments_due_date_idx on public.assessments (due_date);

-- ---------------------------------------------------------------------------
-- calendar_links
--
-- One row per event we have pushed to Google Calendar. Its presence is what
-- turns a re-sync into an event update instead of a duplicate event, so the
-- key we sync under is the primary key rather than a surrogate.
--
-- `key` deliberately has NO foreign key, for the same reason
-- `notion_links.entity_id` does not: it holds three kinds of id in one column.
--   <assessment id>            -- a deadline; the only one that is a row
--   sb_<assessment id>_<n>     -- a study session the planner minted, never stored
--   mt_<course id>_<n>         -- a recurring class series, from courses.meeting_times
-- It used to be `assessment_id uuid` with a cascade from `assessments`. That
-- stopped being possible the moment class meetings and study sessions became
-- syncable: neither is a row, so neither can be a foreign key, and a uuid
-- column rejects both outright.
--
-- `user_id` is what replaced that cascade. Nullable, because rows written
-- before it existed have no owner; those are attributed by their key
-- (`isLegacyCalendarLinkOf` in src/lib/store/index.ts) so they can still be
-- listed and cleaned up. Deleting a COURSE or an ASSESSMENT cascades nothing
-- here -- that cleanup is explicit in src/lib/store/supabase.ts, exactly as it
-- is for notion_links.
-- ---------------------------------------------------------------------------

create table if not exists public.calendar_links (
  key             text primary key,
  -- text, to match users.id. Null only on rows predating this column.
  user_id         text references public.users (id) on delete cascade,
  google_event_id text not null,
  calendar_id     text not null,
  updated_at      text not null
);

-- Migration for databases created while this table keyed on `assessment_id`.
-- `create table if not exists` above is a no-op on those, so the reshape is
-- done here: drop the cascade that can no longer hold, widen the column to
-- text (every existing value is an assessment id, which is still a valid key),
-- and rename it. Guarded on the old column's existence, so a re-run is a no-op.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'calendar_links'
      and column_name = 'assessment_id'
  ) then
    alter table public.calendar_links
      drop constraint if exists calendar_links_assessment_id_fkey;
    alter table public.calendar_links
      alter column assessment_id type text using assessment_id::text;
    alter table public.calendar_links rename column assessment_id to key;
  end if;
end
$$;

-- Migration for databases created before `user_id` existed. The foreign key is
-- added separately because `add column if not exists` cannot carry it, and is
-- itself guarded so re-running the file does not try to add it twice. A fresh
-- database already has it from `create table` above, under the same name.
alter table public.calendar_links add column if not exists user_id text;

do $$
begin
  if not exists (
    -- conname alone is not unique across tables; pin it to this one.
    select 1 from pg_constraint
    where conname = 'calendar_links_user_id_fkey'
      and conrelid = 'public.calendar_links'::regclass
  ) then
    alter table public.calendar_links
      add constraint calendar_links_user_id_fkey
      foreign key (user_id) references public.users (id) on delete cascade;
  end if;
end
$$;

create index if not exists calendar_links_calendar_id_idx on public.calendar_links (calendar_id);
create index if not exists calendar_links_user_id_idx on public.calendar_links (user_id);

-- ---------------------------------------------------------------------------
-- notion_connections
--
-- One row per user, keyed by user_id rather than a surrogate: a user has one
-- Notion workspace connection, and reconnecting replaces it. Kept out of
-- `users` because it holds a bearer secret -- a `users` row can be handed
-- around server-side without a redaction step, this one cannot.
-- ---------------------------------------------------------------------------

create table if not exists public.notion_connections (
  -- text, to match users.id.
  user_id            text primary key references public.users (id) on delete cascade,
  -- Notion access tokens do not expire and there is no refresh token, so this
  -- is a long-lived credential. Never selected into anything client-facing.
  access_token       text not null,
  workspace_id       text not null,
  workspace_name     text,
  bot_id             text,
  -- The page the user shared during consent; null until one is chosen, which
  -- is the whole point of the `needs_parent` status.
  parent_page_id     text,
  -- The "Syllabus Center" hub page and its three databases. Null until built.
  hub_page_id        text,
  hub_url            text,
  courses_db_id      text,
  assignments_db_id  text,
  sessions_db_id     text,
  status             text not null,
  connected_at       text not null,
  constraint notion_connections_status_check check (
    status in ('connected','needs_parent','revoked')
  )
);

-- ---------------------------------------------------------------------------
-- notion_links
--
-- One row per Notion page we created for one of our entities. Its presence is
-- what turns a re-sync into a property update instead of a duplicate page, so
-- (kind, entity_id) is the primary key rather than a surrogate.
--
-- `entity_id` deliberately has NO foreign key: it holds course ids, assessment
-- ids AND study-session ids in one column, and a session id is not a row id at
-- all -- the planner mints them as `sb_<assessment_id>_<n>` and never stores
-- them. Deleting a course therefore cannot cascade here; that cleanup lives in
-- deleteCourse in src/lib/store/supabase.ts.
-- ---------------------------------------------------------------------------

create table if not exists public.notion_links (
  -- text, to match users.id. Denormalised onto the row because entity_id has
  -- nothing to join through for ownership.
  user_id    text not null references public.users (id) on delete cascade,
  kind       text not null,
  entity_id  text not null,
  page_id    text not null,
  url        text,
  primary key (kind, entity_id),
  constraint notion_links_kind_check check (
    kind in ('course','assessment','session')
  )
);

create index if not exists notion_links_user_id_idx on public.notion_links (user_id);

-- ---------------------------------------------------------------------------
-- academic_terms
--
-- One row per term of one user's, and the unit premium is sold in: the Academic
-- Term Pass unlocks a term, not an account (docs/TERM-PASS.md). The payment
-- columns therefore live here rather than on `users` -- a student who buys a
-- pass in the spring and comes back in the autumn is buying again, which an
-- expiry hanging off the account could not express.
--
-- `term_type` is a LABEL and never implies dates: the same word means different
-- months at different schools, so nothing in this app derives a date from it.
-- Dates are `text` for the reason stated at the top of this file.
-- ---------------------------------------------------------------------------

create table if not exists public.academic_terms (
  id                          uuid primary key default gen_random_uuid(),
  -- text, to match users.id above.
  user_id                     text not null references public.users (id) on delete cascade,
  -- Whatever the student calls it: "Fall 2026", "Quarter 2", "Block 3".
  name                        text not null,
  term_type                   text not null default 'custom',
  -- Null only while the term was inferred from a syllabus that stated no dates
  -- and the student has not filled them in. A confirmed term always has both:
  -- without an end date there is nothing to compute an expiry from.
  start_date                  text,
  end_date                    text,
  -- The free allowance. 1 for a term somebody created, and the number of
  -- courses migrated in for a term `ensureTermsBackfilled` created -- a user who
  -- had three courses keeps all three free. Not a column anybody edits.
  free_courses                integer not null default 1,
  -- When the student confirmed this term; null while it is still the app's
  -- guess from a syllabus. Nothing inferred is silently final.
  confirmed_at                text,
  -- Set ONLY by the verified `checkout.session.completed` webhook (see
  -- grantTermPremium in src/lib/store/supabase.ts). The success redirect polls;
  -- it activates nothing. Stays true after expiry, because the record of a
  -- purchase is not something to erase -- `premium_expires_at` is what says
  -- whether it still grants anything today.
  premium                     boolean not null default false,
  premium_started_at          text,
  -- end_date + 14 days, computed by `premiumExpiresAt` in src/lib/terms.ts,
  -- which is the only place that arithmetic lives.
  premium_expires_at          text,
  -- `end_date` as it stood at the moment of purchase. An edit to a paid term is
  -- bounded against THIS, not against the current end date, so a term can be
  -- corrected but not renewed (`premiumEndDateAllowed`).
  paid_end_date               text,
  stripe_checkout_session_id  text,
  stripe_payment_intent_id    text,
  stripe_customer_id          text,
  created_at                  text not null,
  updated_at                  text not null,
  constraint academic_terms_term_type_check check (
    term_type in ('semester','quarter','trimester','summer','winter','j_term','custom')
  )
);

create index if not exists academic_terms_user_id_idx on public.academic_terms (user_id);

-- Migration for databases created before terms existed. `on delete set null`,
-- NOT cascade, and the difference matters: deleting a term is tidying a label,
-- and it must never take a semester of coursework with it. The course keeps its
-- own `term` text, which is what the UI falls back to.
alter table public.courses
  add column if not exists term_id uuid references public.academic_terms (id) on delete set null;

create index if not exists courses_term_id_idx on public.courses (term_id);

-- ---------------------------------------------------------------------------
-- stripe_events
--
-- Webhook idempotency, and nothing else. Stripe retries deliveries and can send
-- the same event twice, so the handler records the id before it acts: the INSERT
-- is the lock, a `unique_violation` is the answer "already handled", and two
-- concurrent deliveries cannot both grant premium. A check-then-write would let
-- them.
--
-- No `user_id`: an event id is Stripe's record of a message, not a user's data,
-- which is also why deleting an account leaves these rows alone -- forgetting
-- one would re-open the door to processing it twice.
-- ---------------------------------------------------------------------------

create table if not exists public.stripe_events (
  id            text primary key,
  type          text not null,
  processed_at  text not null
);

-- ---------------------------------------------------------------------------
-- pending_uploads
--
-- A parsed syllabus the student could not keep YET. When an upload is refused
-- with the paywall (the term's free course is taken and it is not premium), the
-- parse has already happened -- it is what decided which term the syllabus
-- belongs to -- and throwing it away meant the student paid, came back from
-- Stripe to an empty dropzone, and had to find and re-upload the same file.
-- So the parse is kept here instead, keyed to the term it was refused for, and
-- the moment that term reads premium the client replays it through the upload
-- route with `pendingId` and no file. Nothing is re-parsed.
--
-- `parsed` is the whole ParsedSyllabus as JSON: it is the exact input
-- `createCourse` takes, so the replay is the normal create path, not a second
-- one. `term_id` is `on delete set null` for the same reason `courses.term_id`
-- is -- deleting a term must not delete a syllabus somebody uploaded.
--
-- Deleted on successful replay. Rows a student never claims are small and
-- harmless, and removed with the account like everything else.
-- ---------------------------------------------------------------------------

create table if not exists public.pending_uploads (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null references public.users (id) on delete cascade,
  term_id     uuid references public.academic_terms (id) on delete set null,
  file_name   text not null,
  parsed      jsonb not null,
  created_at  text not null
);

create index if not exists pending_uploads_user_id_idx on public.pending_uploads (user_id);

-- ---------------------------------------------------------------------------
-- Row level security
--
-- The server routes connect with the SERVICE ROLE key, which bypasses RLS
-- entirely -- ownership for those paths is enforced in src/lib/store/supabase.ts.
-- These policies are the second line of defence: they are what protects the
-- data if the anon key is ever used directly (Supabase client SDK, PostgREST
-- from a browser, a future realtime subscription).
-- ---------------------------------------------------------------------------

alter table public.users               enable row level security;
alter table public.courses             enable row level security;
alter table public.assessments         enable row level security;
alter table public.academic_terms      enable row level security;
alter table public.pending_uploads     enable row level security;
alter table public.calendar_links      enable row level security;
alter table public.notion_connections  enable row level security;
alter table public.notion_links        enable row level security;
-- No policy for stripe_events, deliberately: enabling RLS with none defined
-- denies every anon and authenticated request outright, which is exactly right.
-- These rows are the webhook's own bookkeeping -- they belong to no user, they
-- are never read by a browser, and the only client that touches them is the
-- server on the service-role key, which bypasses RLS entirely. A policy here
-- could only widen access to something nobody should be reading.
alter table public.stripe_events       enable row level security;

drop policy if exists users_self_access on public.users;
create policy users_self_access on public.users
  for all
  using (id = auth.uid()::text)
  with check (id = auth.uid()::text);

drop policy if exists courses_owner_access on public.courses;
create policy courses_owner_access on public.courses
  for all
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

-- Terms carry their owner directly, so the policy is a plain self-check. Note
-- that the payment columns are covered by it too: nothing but the server on the
-- service-role key can write `premium`, and an anon client reading its own term
-- learns only what the UI already shows it.
drop policy if exists academic_terms_owner_access on public.academic_terms;
create policy academic_terms_owner_access on public.academic_terms
  for all
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

drop policy if exists pending_uploads_owner_access on public.pending_uploads;
create policy pending_uploads_owner_access on public.pending_uploads
  for all
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

-- Assessments have no user_id of their own; they inherit ownership through the
-- course, so the policy walks the chain.
drop policy if exists assessments_owner_access on public.assessments;
create policy assessments_owner_access on public.assessments
  for all
  using (
    exists (
      select 1 from public.courses c
      where c.id = assessments.course_id and c.user_id = auth.uid()::text
    )
  )
  with check (
    exists (
      select 1 from public.courses c
      where c.id = assessments.course_id and c.user_id = auth.uid()::text
    )
  );

-- Calendar links carry their owner now, so the common case is a plain
-- self-check. The chain walk survives only for rows written before `user_id`
-- existed, where the key is the sole evidence of who they belong to -- the same
-- attribution `isLegacyCalendarLinkOf` performs in the store. `starts_with`
-- rather than `like`, so an id can never be read as a wildcard.
--
-- `with check` is the plain self-check ALONE: an anon writer must claim
-- ownership of what it writes. Nothing should be creating ownerless rows any
-- more, and letting one be created under a borrowed key is how a link ends up
-- pointing at somebody else's event.
drop policy if exists calendar_links_owner_access on public.calendar_links;
create policy calendar_links_owner_access on public.calendar_links
  for all
  using (
    user_id = auth.uid()::text
    or (
      user_id is null
      and (
        exists (
          select 1
          from public.assessments a
          join public.courses c on c.id = a.course_id
          where c.user_id = auth.uid()::text
            and (
              calendar_links.key = a.id::text
              or starts_with(calendar_links.key, 'sb_' || a.id::text || '_')
            )
        )
        or exists (
          select 1
          from public.courses c
          where c.user_id = auth.uid()::text
            and starts_with(calendar_links.key, 'mt_' || c.id::text || '_')
        )
      )
    )
  )
  with check (user_id = auth.uid()::text);

-- The Notion tables carry user_id directly, so their policies are a plain
-- self-check -- no chain to walk. Note again that the server never sees these:
-- the service-role key bypasses RLS and ownership is enforced in
-- src/lib/store/supabase.ts.
drop policy if exists notion_connections_owner_access on public.notion_connections;
create policy notion_connections_owner_access on public.notion_connections
  for all
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

drop policy if exists notion_links_owner_access on public.notion_links;
create policy notion_links_owner_access on public.notion_links
  for all
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);
