-- Syllabus AI -- Postgres schema.
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
  created_at            text not null
);

-- Migration for databases created before `timezone` existed. `create table if
-- not exists` above is a no-op on those, so the column has to be added here;
-- `add column if not exists` makes running the whole file again a no-op too.
alter table public.users add column if not exists timezone text;

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
  meeting_times  jsonb not null default '[]'::jsonb,
  grade_weights  jsonb not null default '[]'::jsonb,
  policies       jsonb not null default '[]'::jsonb,
  created_at     text not null
);

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
  due_time        text,
  weight_percent  numeric,
  source_text     text,
  -- 0..1 extractor confidence; the UI surfaces anything under 0.6 for review.
  confidence      numeric not null default 0,
  notes           text,
  constraint assessments_kind_check check (
    kind in ('assignment','exam','quiz','project','reading','lab','presentation','other')
  ),
  constraint assessments_confidence_check check (confidence >= 0 and confidence <= 1)
);

create index if not exists assessments_course_id_idx on public.assessments (course_id);
create index if not exists assessments_due_date_idx on public.assessments (due_date);

-- ---------------------------------------------------------------------------
-- calendar_links
--
-- One row per assessment we have pushed to Google Calendar. Its presence is
-- what turns a re-sync into an event update instead of a duplicate event, so
-- the assessment id is the primary key rather than a surrogate.
-- ---------------------------------------------------------------------------

create table if not exists public.calendar_links (
  assessment_id   uuid primary key references public.assessments (id) on delete cascade,
  google_event_id text not null,
  calendar_id     text not null,
  updated_at      text not null
);

create index if not exists calendar_links_calendar_id_idx on public.calendar_links (calendar_id);

-- ---------------------------------------------------------------------------
-- Row level security
--
-- The server routes connect with the SERVICE ROLE key, which bypasses RLS
-- entirely -- ownership for those paths is enforced in src/lib/store/supabase.ts.
-- These policies are the second line of defence: they are what protects the
-- data if the anon key is ever used directly (Supabase client SDK, PostgREST
-- from a browser, a future realtime subscription).
-- ---------------------------------------------------------------------------

alter table public.users          enable row level security;
alter table public.courses        enable row level security;
alter table public.assessments    enable row level security;
alter table public.calendar_links enable row level security;

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

-- Assessments and calendar links have no user_id of their own; they inherit
-- ownership through the course, so the policy walks the chain.
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

drop policy if exists calendar_links_owner_access on public.calendar_links;
create policy calendar_links_owner_access on public.calendar_links
  for all
  using (
    exists (
      select 1
      from public.assessments a
      join public.courses c on c.id = a.course_id
      where a.id = calendar_links.assessment_id and c.user_id = auth.uid()::text
    )
  )
  with check (
    exists (
      select 1
      from public.assessments a
      join public.courses c on c.id = a.course_id
      where a.id = calendar_links.assessment_id and c.user_id = auth.uid()::text
    )
  );
