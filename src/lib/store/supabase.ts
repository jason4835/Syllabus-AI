/**
 * Supabase (Postgres) driver.
 *
 * Runs with the service-role key, which bypasses RLS -- ownership is therefore
 * this file's job, not the database's. Every method that takes a `userId`
 * proves ownership before it reads or writes, including for assessments, which
 * inherit ownership through their course.
 *
 * Server-only: the service-role key must never reach a browser bundle.
 */

import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  AcademicTerm,
  Assessment,
  AssessmentKind,
  CalendarPrefs,
  Course,
  CoursePolicy,
  GradeWeight,
  NoClassPeriod,
  NotionConnection,
  NotionLink,
  NotionLinkKind,
  ParsedSyllabus,
  PendingUpload,
  TermInput,
  TermType,
  User,
  UserProfile,
} from "@/lib/types";
import { DEMO_USER_PREFIX, TERM_TYPES } from "@/lib/types";
import { FREE_COURSES_PER_TERM, todayIso } from "@/lib/terms";
import { foldPaidTerms, isoDaysAgo, type PaidTerm } from "@/lib/metrics";
import type {
  CalendarLink,
  CalendarLinkQuery,
  KeyedCalendarLink,
  OrphanedNotionPage,
  Store,
  UserUpsert,
} from "@/lib/store";
import {
  calendarLinkMatchesQuery,
  isFeedTokenShaped,
  isLegacyCalendarLinkOf,
  mergeCalendarPrefs,
  newCalendarFeedToken,
  normalizeMeetingTimes,
  notionSessionLinkPrefix,
} from "@/lib/store";
import { ASSESSMENT_KINDS } from "@/lib/validation";

// -- Row shapes -------------------------------------------------------------
// Hand-written rather than generated so the mapping stays visible at review
// time; snake_case here, camelCase in the domain.

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  google_refresh_token: string | null;
  timezone: string | null;
  calendar_feed_token: string | null;
  calendar_prefs: unknown;
  /** Absent from rows written before the column existed; read as `{}`. */
  profile?: unknown;
  created_at: string;
}

/** The two columns `metrics()` projects a paid term down to. */
interface PaidTermRow {
  user_id: string;
  premium_expires_at: string | null;
}

/** `parsed` is the whole ParsedSyllabus as jsonb -- the exact input createCourse takes. */
interface PendingUploadRow {
  id: string;
  user_id: string;
  term_id: string | null;
  file_name: string;
  parsed: unknown;
  created_at: string;
}

interface CourseRow {
  id: string;
  user_id: string;
  code: string;
  title: string;
  instructor: string | null;
  term: string | null;
  /**
   * The academic term this course belongs to. Null for a course written before
   * terms existed, until `ensureTermsBackfilled` files it; the `term` text above
   * is what the UI shows in the meantime.
   */
  term_id: string | null;
  start_date: string | null;
  end_date: string | null;
  meeting_times: unknown;
  /**
   * One answer per question the syllabus asks. `section` is its single-answer
   * predecessor: still on every existing row, never written to again, folded
   * into `sections` on read by `courseToDomain`.
   */
  sections: unknown;
  section: string | null;
  no_class: unknown;
  grade_weights: unknown;
  policies: unknown;
  created_at: string;
}

interface AssessmentRow {
  id: string;
  course_id: string;
  title: string;
  kind: string;
  due_date: string | null;
  due_time: string | null;
  end_time: string | null;
  weight_percent: number | string | null;
  source_text: string | null;
  confidence: number | string;
  reviewed_at: string | null;
  notes: string | null;
}

interface TermRow {
  id: string;
  user_id: string;
  name: string;
  term_type: string;
  start_date: string | null;
  end_date: string | null;
  free_courses: number | string;
  confirmed_at: string | null;
  premium: boolean;
  premium_started_at: string | null;
  premium_expires_at: string | null;
  paid_end_date: string | null;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_customer_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * `key` is an assessment id, `sb_<assessmentId>_<n>` for a study session, or
 * `mt_<courseId>_<n>` for a class series. Only the first is a row id, which is
 * why the column carries no foreign key and `user_id` has to be recorded
 * instead -- there is nothing to join through for ownership.
 *
 * `user_id` is nullable: rows written before the column existed have none and
 * are attributed by their key (`isLegacyCalendarLinkOf`).
 */
interface CalendarLinkRow {
  key: string;
  user_id: string | null;
  google_event_id: string;
  calendar_id: string;
  updated_at: string;
}

interface NotionConnectionRow {
  user_id: string;
  access_token: string;
  workspace_id: string;
  workspace_name: string | null;
  bot_id: string | null;
  parent_page_id: string | null;
  hub_page_id: string | null;
  hub_url: string | null;
  courses_db_id: string | null;
  assignments_db_id: string | null;
  sessions_db_id: string | null;
  status: string;
  connected_at: string;
}

interface NotionLinkRow {
  user_id: string;
  kind: string;
  entity_id: string;
  page_id: string;
  url: string | null;
}

/**
 * The `AssessmentKind` union as runtime data.
 *
 * Re-exported from `@/lib/validation`, which now owns the one copy: the check
 * constraint in supabase/schema.sql, the coercion below and the assessment
 * routes' validation all have to name the same eight strings, and a second
 * literal is how the API and the database drift apart. The name stays exported
 * here so existing importers do not have to care where it moved.
 */
export { ASSESSMENT_KINDS };

// -- Coercion helpers -------------------------------------------------------

/** jsonb comes back as `unknown`; a malformed column must not crash a page. */
function jsonArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** The retired single answer, read as the one-element set of answers it was. */
function legacySections(section: string | null): string[] {
  const label = section?.trim();
  return label ? [label] : [];
}

/** Postgres `numeric` is delivered as a string by some driver/column combos. */
function toNumberOrNull(value: number | string | null): number | null {
  if (value === null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function toKind(value: string): AssessmentKind {
  return (ASSESSMENT_KINDS as readonly string[]).includes(value)
    ? (value as AssessmentKind)
    : "other";
}

/**
 * An unrecognised type degrades to `custom` rather than being dropped: a term
 * type is a label the UI prints, so the worst outcome of the fallback is a term
 * shown as "Custom", while dropping the row would hide a term somebody paid for.
 */
function toTermType(value: string): TermType {
  return (TERM_TYPES as readonly string[]).includes(value)
    ? (value as TermType)
    : "custom";
}

const NOTION_LINK_KINDS: readonly NotionLinkKind[] = [
  "course",
  "assessment",
  "session",
];

const NOTION_STATUSES: readonly NotionConnection["status"][] = [
  "connected",
  "needs_parent",
  "revoked",
];

/**
 * An unrecognised status degrades to `revoked` rather than `connected`: the
 * worst outcome of that is one reconnect prompt, whereas guessing "connected"
 * would send sync requests with a token we have no reason to trust.
 */
function toNotionStatus(value: string): NotionConnection["status"] {
  return (NOTION_STATUSES as readonly string[]).includes(value)
    ? (value as NotionConnection["status"])
    : "revoked";
}

function toNotionLinkKind(value: string): NotionLinkKind | null {
  return (NOTION_LINK_KINDS as readonly string[]).includes(value)
    ? (value as NotionLinkKind)
    : null;
}

// -- Mappers ----------------------------------------------------------------

function userToDomain(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    picture: row.picture,
    googleRefreshToken: row.google_refresh_token,
    timezone: row.timezone,
    // `?? null` like `reviewed_at` below: a database that has not had the
    // `calendar_feed_token` migration applied yet returns no such key, and
    // `undefined` would leave the field missing from the domain object.
    calendarFeedToken: row.calendar_feed_token ?? null,
    // Laid over the defaults rather than read straight: the column defaults to
    // `{}`, rows written before it existed have nothing, and a preference
    // reading `undefined` would silently mean "do not sync that".
    profile: (row.profile && typeof row.profile === "object" ? (row.profile as UserProfile) : {}),
    calendarPrefs: mergeCalendarPrefs(row.calendar_prefs),
    createdAt: row.created_at,
  };
}

function userToRow(user: User): UserRow {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture,
    google_refresh_token: user.googleRefreshToken,
    timezone: user.timezone,
    calendar_feed_token: user.calendarFeedToken,
    profile: user.profile ?? {},
    calendar_prefs: user.calendarPrefs,
    created_at: user.createdAt,
  };
}

function courseToDomain(row: CourseRow): Course {
  return {
    id: row.id,
    userId: row.user_id,
    code: row.code,
    title: row.title,
    instructor: row.instructor,
    term: row.term,
    // `?? null` like the other late additions: a database that has not had the
    // `term_id` migration applied yet returns no such key, and `undefined` would
    // leave the field missing from the JSON the API sends -- and would reach the
    // backfill as something other than "this course has no term yet".
    termId: row.term_id ?? null,
    startDate: row.start_date,
    endDate: row.end_date,
    // Completed field by field, not just shape-checked: a meeting stored
    // before `kind`/`section`/`instructor` existed is a lecture in the only
    // section, which is exactly what it meant when it was written.
    meetingTimes: normalizeMeetingTimes(row.meeting_times),
    // Read-side migration, and the only place the legacy `section` column is
    // still consulted. A row written before a course could hold more than one
    // answer has `sections` null: the single answer it does have becomes a
    // one-element array, so a student who picked their lecture keeps that pick
    // and is simply asked the lab question they were never asked. Nothing is
    // backfilled and nothing is dropped, so a rollback stays safe.
    sections: Array.isArray(row.sections)
      ? jsonArray<string>(row.sections)
      : legacySections(row.section),
    // Defaults to [] through `jsonArray`, which is also the migration story: a
    // database without the `no_class` column reads back "this class has no
    // breaks" rather than `undefined`.
    noClass: jsonArray<NoClassPeriod>(row.no_class),
    gradeWeights: jsonArray<GradeWeight>(row.grade_weights),
    policies: jsonArray<CoursePolicy>(row.policies),
    createdAt: row.created_at,
  };
}

function courseToRow(course: Course): CourseRow {
  return {
    id: course.id,
    user_id: course.userId,
    code: course.code,
    title: course.title,
    instructor: course.instructor,
    term: course.term,
    term_id: course.termId,
    start_date: course.startDate,
    end_date: course.endDate,
    meeting_times: course.meetingTimes,
    sections: course.sections ?? [],
    // Written as null on every insert from here on. The column survives only to
    // keep older deploys readable; `courseToDomain` is what reads it.
    section: null,
    no_class: course.noClass,
    grade_weights: course.gradeWeights,
    policies: course.policies,
    created_at: course.createdAt,
  };
}

/**
 * Partial patch -> partial row, explicit key by key. Only keys actually present
 * are emitted, so an absent field means "leave alone" rather than "set to
 * null". `id`, `user_id` and `created_at` are never emitted: they are identity,
 * and re-assigning `user_id` would be an ownership escape.
 */
function coursePatchToRow(
  patch: Partial<Course>,
): Partial<Omit<CourseRow, "id" | "user_id" | "created_at">> {
  const row: Partial<Omit<CourseRow, "id" | "user_id" | "created_at">> = {};
  if (patch.code !== undefined) row.code = patch.code;
  if (patch.title !== undefined) row.title = patch.title;
  if (patch.instructor !== undefined) row.instructor = patch.instructor;
  if (patch.term !== undefined) row.term = patch.term;
  // Moving a course between terms is an edit a student makes, and the backfill's
  // only write. The route checks that the id is a term of theirs first: the
  // foreign key would catch a nonexistent one, but not somebody else's.
  if (patch.termId !== undefined) row.term_id = patch.termId;
  if (patch.startDate !== undefined) row.start_date = patch.startDate;
  if (patch.endDate !== undefined) row.end_date = patch.endDate;
  // `sections` and `meeting_times` ARE editable, unlike the rest of what the
  // parser writes: a syllabus for a big course lists every section and the
  // extractor keeps them all, so which ones the student attends can only come
  // from the student -- and a room the extractor misread has to be fixable.
  // The array is replaced whole; normalising it here means an entry that
  // arrives without a `kind` cannot be stored without one.
  if (patch.sections !== undefined) row.sections = patch.sections;
  if (patch.meetingTimes !== undefined) {
    row.meeting_times = normalizeMeetingTimes(patch.meetingTimes);
  }
  // The remaining parser-owned columns (no_class, grade_weights, policies) are
  // intentionally absent: nothing a person types should overwrite them.
  return row;
}

function assessmentToDomain(row: AssessmentRow): Assessment {
  return {
    id: row.id,
    courseId: row.course_id,
    title: row.title,
    kind: toKind(row.kind),
    dueDate: row.due_date,
    dueTime: row.due_time,
    // `?? null` for the same reason `reviewed_at` below gets one: a database
    // without the `end_time` migration returns no such key, and `undefined`
    // would drop the field out of the JSON the API sends.
    endTime: row.end_time ?? null,
    weightPercent: toNumberOrNull(row.weight_percent),
    sourceText: row.source_text,
    confidence: toNumberOrNull(row.confidence) ?? 0,
    // `?? null` rather than a straight read: a database that has not had the
    // `reviewed_at` migration applied yet returns no such key, and `undefined`
    // would leave the field missing from the JSON the API sends.
    reviewedAt: row.reviewed_at ?? null,
    notes: row.notes,
  };
}

function assessmentToRow(assessment: Assessment): AssessmentRow {
  return {
    id: assessment.id,
    course_id: assessment.courseId,
    title: assessment.title,
    kind: assessment.kind,
    due_date: assessment.dueDate,
    due_time: assessment.dueTime,
    end_time: assessment.endTime,
    weight_percent: assessment.weightPercent,
    source_text: assessment.sourceText,
    confidence: assessment.confidence,
    reviewed_at: assessment.reviewedAt,
    notes: assessment.notes,
  };
}

/**
 * Partial patch -> partial row. Only keys actually present are emitted, so an
 * absent field means "leave alone" rather than "set to null". `id`/`courseId`
 * are never emitted: re-parenting an assessment would be an ownership escape.
 */
function assessmentPatchToRow(
  patch: Partial<Assessment>,
): Partial<Omit<AssessmentRow, "id" | "course_id">> {
  const row: Partial<Omit<AssessmentRow, "id" | "course_id">> = {};
  if (patch.title !== undefined) row.title = patch.title;
  if (patch.kind !== undefined) row.kind = patch.kind;
  if (patch.dueDate !== undefined) row.due_date = patch.dueDate;
  if (patch.dueTime !== undefined) row.due_time = patch.dueTime;
  if (patch.endTime !== undefined) row.end_time = patch.endTime;
  if (patch.weightPercent !== undefined) row.weight_percent = patch.weightPercent;
  if (patch.sourceText !== undefined) row.source_text = patch.sourceText;
  if (patch.confidence !== undefined) row.confidence = patch.confidence;
  // Reviewing is an edit like any other, so it travels in the same patch. The
  // route sets it on every accepted request; nothing here decides policy.
  if (patch.reviewedAt !== undefined) row.reviewed_at = patch.reviewedAt;
  if (patch.notes !== undefined) row.notes = patch.notes;
  return row;
}

function pendingToDomain(row: PendingUploadRow): PendingUpload {
  return {
    id: row.id,
    userId: row.user_id,
    termId: row.term_id,
    fileName: row.file_name,
    parsed: row.parsed as ParsedSyllabus,
    createdAt: row.created_at,
  };
}

function termToDomain(row: TermRow): AcademicTerm {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    termType: toTermType(row.term_type),
    startDate: row.start_date,
    endDate: row.end_date,
    // `integer` should arrive as a number, but the same driver/column combos
    // that deliver `numeric` as a string are why `toNumberOrNull` exists; a
    // string here would compare against a course count as text and decide the
    // paywall wrong.
    freeCourses: toNumberOrNull(row.free_courses) ?? FREE_COURSES_PER_TERM,
    confirmedAt: row.confirmed_at,
    premium: row.premium === true,
    premiumStartedAt: row.premium_started_at,
    premiumExpiresAt: row.premium_expires_at,
    paidEndDate: row.paid_end_date,
    stripeCheckoutSessionId: row.stripe_checkout_session_id,
    stripePaymentIntentId: row.stripe_payment_intent_id,
    stripeCustomerId: row.stripe_customer_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * A create, as a row. `id` is left to the column default (`gen_random_uuid()`)
 * and the premium columns to theirs: a term is never born paid for, and the
 * only writer of those is `grantTermPremium`.
 */
function termInsertRow(
  userId: string,
  input: TermInput & { freeCourses?: number; confirmedAt?: string | null },
  now: string,
): Omit<TermRow, "id" | "premium" | "premium_started_at" | "premium_expires_at" | "paid_end_date" | "stripe_checkout_session_id" | "stripe_payment_intent_id" | "stripe_customer_id"> {
  return {
    user_id: userId,
    name: input.name,
    term_type: input.termType,
    start_date: input.startDate,
    end_date: input.endDate,
    // One course free unless the caller is migrating several in; see
    // `ensureTermsBackfilled`.
    free_courses: input.freeCourses ?? FREE_COURSES_PER_TERM,
    // Null means "inferred from a syllabus, still waiting on the student".
    confirmed_at: input.confirmedAt ?? null,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Partial patch -> partial row, key by key, so an absent field means "leave
 * alone" rather than "set to null".
 *
 * `user_id`, `created_at`, `free_courses` and the payment columns are never
 * emitted: the first two are identity, the allowance is the product's, and the
 * rest belong to `grantTermPremium`. `premium_expires_at` IS emitted, because
 * shortening a paid term moves its expiry earlier with it.
 */
function termPatchToRow(patch: Partial<AcademicTerm>): Partial<TermRow> {
  const row: Partial<TermRow> = {};
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.termType !== undefined) row.term_type = patch.termType;
  if (patch.startDate !== undefined) row.start_date = patch.startDate;
  if (patch.endDate !== undefined) row.end_date = patch.endDate;
  if (patch.confirmedAt !== undefined) row.confirmed_at = patch.confirmedAt;
  if (patch.premiumExpiresAt !== undefined) {
    row.premium_expires_at = patch.premiumExpiresAt;
  }
  if (patch.stripeCheckoutSessionId !== undefined) {
    row.stripe_checkout_session_id = patch.stripeCheckoutSessionId;
  }
  return row;
}

function calendarLinkToDomain(row: CalendarLinkRow): CalendarLink {
  return { googleEventId: row.google_event_id, calendarId: row.calendar_id };
}

function keyedCalendarLinkToDomain(row: CalendarLinkRow): KeyedCalendarLink {
  return {
    key: row.key,
    googleEventId: row.google_event_id,
    calendarId: row.calendar_id,
  };
}

function notionConnectionToDomain(row: NotionConnectionRow): NotionConnection {
  return {
    userId: row.user_id,
    accessToken: row.access_token,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    botId: row.bot_id,
    parentPageId: row.parent_page_id,
    hubPageId: row.hub_page_id,
    hubUrl: row.hub_url,
    coursesDbId: row.courses_db_id,
    assignmentsDbId: row.assignments_db_id,
    sessionsDbId: row.sessions_db_id,
    status: toNotionStatus(row.status),
    connectedAt: row.connected_at,
  };
}

function notionConnectionToRow(conn: NotionConnection): NotionConnectionRow {
  return {
    user_id: conn.userId,
    access_token: conn.accessToken,
    workspace_id: conn.workspaceId,
    workspace_name: conn.workspaceName,
    bot_id: conn.botId,
    parent_page_id: conn.parentPageId,
    hub_page_id: conn.hubPageId,
    hub_url: conn.hubUrl,
    courses_db_id: conn.coursesDbId,
    assignments_db_id: conn.assignmentsDbId,
    sessions_db_id: conn.sessionsDbId,
    status: conn.status,
    connected_at: conn.connectedAt,
  };
}

/**
 * Null for a `kind` outside the union. Only a hand-written row can produce one
 * (a check constraint guards the column), and dropping it beats coercing it
 * into some other kind whose sync path would then patch the wrong page.
 */
function notionLinkToDomain(row: NotionLinkRow): NotionLink | null {
  const kind = toNotionLinkKind(row.kind);
  if (kind === null) return null;
  return {
    userId: row.user_id,
    kind,
    entityId: row.entity_id,
    pageId: row.page_id,
    url: row.url,
  };
}

function notionLinkToRow(link: NotionLink): NotionLinkRow {
  return {
    user_id: link.userId,
    kind: link.kind,
    entity_id: link.entityId,
    page_id: link.pageId,
    url: link.url,
  };
}

// -- Driver -----------------------------------------------------------------

/** Postgres "no rows" from `.single()`; expected, not an error worth throwing. */
const NO_ROWS = "PGRST116";

/**
 * Postgres `unique_violation`. Expected on the `stripe_events` insert, where it
 * IS the answer: the primary key is what makes a duplicate webhook delivery a
 * no-op, so the collision is the lock working rather than a failure.
 */
const UNIQUE_VIOLATION = "23505";

function fail(operation: string, error: { message: string }): never {
  throw new Error(`[store/supabase] ${operation}: ${error.message}`);
}

export function createSupabaseStore(url: string, serviceRoleKey: string): Store {
  const client: SupabaseClient = createClient(url, serviceRoleKey, {
    // No browser session to persist, and refreshing tokens on a service-role
    // key is meaningless.
    auth: { persistSession: false, autoRefreshToken: false },
  });

  async function courseIdsFor(userId: string): Promise<string[]> {
    const { data, error } = await client
      .from("courses")
      .select("id")
      .eq("user_id", userId);
    if (error) fail("listing course ids", error);
    return ((data ?? []) as { id: string }[]).map((r) => r.id);
  }

  async function assessmentIdsFor(courseIds: string[]): Promise<string[]> {
    if (courseIds.length === 0) return [];
    const { data, error } = await client
      .from("assessments")
      .select("id")
      .in("course_id", courseIds);
    if (error) fail("listing assessment ids", error);
    return ((data ?? []) as { id: string }[]).map((r) => r.id);
  }

  /**
   * The calendar links that could belong to `userId`: the ones tagged with
   * their owner, plus the ones written before `user_id` existed.
   *
   * The untagged rows are read and attributed in JS rather than filtered in
   * SQL, for the same reason `deleteNotionSessionLinks` does it that way: the
   * attribution is a set of prefix tests, and hand-assembling an N-clause
   * PostgREST `or=(key.like.*)` string is where one unescaped id silently
   * widens the query. The untagged set is legacy and finite -- nothing writes
   * to it any more -- so it does not grow with use.
   */
  async function candidateCalendarLinkRows(userId: string): Promise<{
    owned: CalendarLinkRow[];
    unowned: CalendarLinkRow[];
  }> {
    const { data: owned, error } = await client
      .from("calendar_links")
      .select("*")
      .eq("user_id", userId);
    if (error) fail("calendar links by owner", error);

    const { data: unowned, error: unownedError } = await client
      .from("calendar_links")
      .select("*")
      .is("user_id", null);
    if (unownedError) fail("calendar links without an owner", unownedError);

    return {
      owned: (owned ?? []) as CalendarLinkRow[],
      unowned: (unowned ?? []) as CalendarLinkRow[],
    };
  }

  /** Every link that is this user's, however it came to be theirs. */
  async function userCalendarLinkRows(userId: string): Promise<CalendarLinkRow[]> {
    const courseIds = await courseIdsFor(userId);
    const assessmentIds = new Set(await assessmentIdsFor(courseIds));
    const courseIdSet = new Set(courseIds);
    const { owned, unowned } = await candidateCalendarLinkRows(userId);
    return [
      ...owned,
      ...unowned.filter((row) => isLegacyCalendarLinkOf(row.key, assessmentIds, courseIdSet)),
    ];
  }

  /**
   * Drops the calendar links a deleted course or assessment leaves behind.
   *
   * `calendar_links.key` has no foreign key -- it holds assessment ids,
   * planner-minted session ids and generated class-series ids in one column --
   * so nothing cascades from Postgres and the cleanup is explicit here, exactly
   * as it is for `notion_links`. A link left behind points the next sync at a
   * Google event for a class the student deleted.
   *
   * Scoped to links this user owns or that nobody owns: the id tests below are
   * prefix matches, and they must never be able to reach into another account.
   *
   * Returns what it deleted. The rows are the only remaining record of the
   * Google event ids, so the caller needs them to clean up the calendar (see
   * `CourseDeletion`); dropping them silently is what leaves a student with
   * events for a class they deleted and no way to remove them.
   */
  async function deleteCalendarLinksFor(
    userId: string,
    assessmentIds: string[],
    courseIds: string[],
  ): Promise<KeyedCalendarLink[]> {
    if (assessmentIds.length === 0 && courseIds.length === 0) return [];
    const assessmentIdSet = new Set(assessmentIds);
    const courseIdSet = new Set(courseIds);
    const { owned, unowned } = await candidateCalendarLinkRows(userId);
    const orphaned = [...owned, ...unowned].filter((row) =>
      isLegacyCalendarLinkOf(row.key, assessmentIdSet, courseIdSet),
    );
    if (orphaned.length === 0) return [];

    const { error } = await client
      .from("calendar_links")
      .delete()
      .in("key", orphaned.map((row) => row.key));
    if (error) fail("deleting calendar links", error);
    return orphaned.map(keyedCalendarLinkToDomain);
  }

  /** Returns the assessment's row only when `userId` owns its course. */
  async function ownedAssessment(
    userId: string,
    assessmentId: string,
  ): Promise<AssessmentRow | null> {
    const { data, error } = await client
      .from("assessments")
      .select("*")
      .eq("id", assessmentId)
      .maybeSingle();
    if (error && error.code !== NO_ROWS) fail("loading assessment", error);
    if (!data) return null;

    const row = data as AssessmentRow;
    const { data: course, error: courseError } = await client
      .from("courses")
      .select("id")
      .eq("id", row.course_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (courseError && courseError.code !== NO_ROWS) {
      fail("verifying course ownership", courseError);
    }
    return course ? row : null;
  }

  /**
   * Drops the Notion links a deleted course leaves behind.
   *
   * `notion_links.entity_id` cannot carry a foreign key -- it holds course ids,
   * assessment ids and planner-minted session ids in one column -- so nothing
   * cascades from Postgres and the three kinds are cleared explicitly here.
   * The Notion pages themselves are left alone on purpose (docs/NOTION.md).
   */
  async function deleteNotionLinksForCourse(
    userId: string,
    courseId: string,
    assessmentIds: string[],
  ): Promise<OrphanedNotionPage[]> {
    const { error: courseError } = await client
      .from("notion_links")
      .delete()
      .eq("user_id", userId)
      .eq("kind", "course")
      .eq("entity_id", courseId);
    if (courseError) fail("deleteCourse notion course link", courseError);
    // Not selected back, unlike the two below: the class page is the one the
    // student's own notes live on, so its pointer goes and the page stays
    // (see `CourseDeletion.notionPages`).

    if (assessmentIds.length === 0) return [];

    const { data, error: assessmentError } = await client
      .from("notion_links")
      .delete()
      .eq("user_id", userId)
      .eq("kind", "assessment")
      .in("entity_id", assessmentIds)
      .select("kind, entity_id, page_id");
    if (assessmentError) {
      fail("deleteCourse notion assessment links", assessmentError);
    }

    return [
      ...orphanedPages(data),
      ...(await deleteNotionSessionLinks(userId, assessmentIds)),
    ];
  }

  /**
   * The deleted `notion_links` rows, as the pages they named.
   *
   * `kind` is narrowed the same way every read of the table narrows it: a row
   * carrying a kind this build does not know is dropped rather than guessed at.
   */
  function orphanedPages(rows: unknown): OrphanedNotionPage[] {
    return ((rows ?? []) as NotionLinkRow[]).flatMap((row) => {
      const kind = toNotionLinkKind(row.kind);
      return kind === null
        ? []
        : [{ kind, entityId: row.entity_id, pageId: row.page_id }];
    });
  }

  /**
   * Drops the Notion links for study sessions belonging to `assessmentIds`.
   *
   * Session links can only be matched by prefix: the planner mints sessions as
   * `sb_<assessmentId>_<n>` and never stores them, so there is no row to join
   * against. Reading this user's session links and filtering in JS beats
   * hand-assembling an N-clause PostgREST `or=(entity_id.like.*)` string, where
   * one unescaped id would silently widen the delete.
   *
   * Shared by the course and single-assessment cascades so the two cannot
   * drift apart from each other or from the planner.
   */
  async function deleteNotionSessionLinks(
    userId: string,
    assessmentIds: string[],
  ): Promise<OrphanedNotionPage[]> {
    if (assessmentIds.length === 0) return [];

    const { data, error } = await client
      .from("notion_links")
      .select("entity_id")
      .eq("user_id", userId)
      .eq("kind", "session");
    if (error) fail("notion session links", error);

    const prefixes = assessmentIds.map(notionSessionLinkPrefix);
    const orphaned = ((data ?? []) as { entity_id: string }[])
      .map((r) => r.entity_id)
      .filter((id) => prefixes.some((prefix) => id.startsWith(prefix)));
    if (orphaned.length === 0) return [];

    const { data: deleted, error: sessionError } = await client
      .from("notion_links")
      .delete()
      .eq("user_id", userId)
      .eq("kind", "session")
      .in("entity_id", orphaned)
      .select("kind, entity_id, page_id");
    if (sessionError) fail("notion session links", sessionError);
    return orphanedPages(deleted);
  }

  /** The single-assessment half of `deleteNotionLinksForCourse`. */
  async function deleteNotionLinksForAssessment(
    userId: string,
    assessmentId: string,
  ): Promise<OrphanedNotionPage[]> {
    const { data, error } = await client
      .from("notion_links")
      .delete()
      .eq("user_id", userId)
      .eq("kind", "assessment")
      .eq("entity_id", assessmentId)
      .select("kind, entity_id, page_id");
    if (error) fail("deleteAssessment notion assessment link", error);

    return [
      ...orphanedPages(data),
      ...(await deleteNotionSessionLinks(userId, [assessmentId])),
    ];
  }

  /**
   * `users` rows matching a filter, excluding demo sandboxes.
   *
   * The demo predicate is a LIKE on the id prefix, and the backslash matters:
   * unescaped, `_` is a single-character wildcard in SQL LIKE, so `demo_%`
   * would also match a hypothetical `demoXY` account. `\\_` pins it to a
   * literal underscore, which is what `DEMO_USER_PREFIX` actually is.
   */
  const DEMO_ID_PATTERN = `${DEMO_USER_PREFIX.replace("_", "\\_")}%`;

  /** Real signups, optionally only those created at or after an ISO instant. */
  async function countUsers(createdSince?: string): Promise<number> {
    // `head: true` asks Postgres for the count and no rows at all.
    const query = client
      .from("users")
      .select("id", { count: "exact", head: true })
      .not("id", "like", DEMO_ID_PATTERN);
    const { count, error } = await (createdSince
      ? query.gte("created_at", createdSince)
      : query);
    if (error) fail("metrics signup count", error);
    return count ?? 0;
  }

  async function countDemoUsers(): Promise<number> {
    const { count, error } = await client
      .from("users")
      .select("id", { count: "exact", head: true })
      .like("id", DEMO_ID_PATTERN);
    if (error) fail("metrics demo count", error);
    return count ?? 0;
  }

  /**
   * Every paid term, paged.
   *
   * Rows, not a count: `foldPaidTerms` needs the buyer ids to deduplicate and
   * the expiry dates to say which passes are still live, and neither is
   * something Postgres can answer through this client in one aggregate.
   *
   * Paged because PostgREST caps a response at `db-max-rows` (1000 by default)
   * and answers a larger result by silently truncating it -- which here would
   * mean under-reporting revenue with no error anywhere. The set is bounded by
   * purchases, not by sign-ups, so in practice this is one round trip.
   */
  async function paidTerms(): Promise<PaidTerm[]> {
    const PAGE = 1000;
    const out: PaidTerm[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await client
        .from("academic_terms")
        .select("user_id, premium_expires_at")
        .eq("premium", true)
        // A stable order, so paging cannot skip or repeat a row.
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) fail("metrics paid terms", error);

      const rows = (data ?? []) as PaidTermRow[];
      for (const row of rows) {
        out.push({ userId: row.user_id, premiumExpiresAt: row.premium_expires_at });
      }
      // A short page is the last page.
      if (rows.length < PAGE) return out;
    }
  }

  return {
    async metrics() {
      // Four count-only queries plus the paid terms. Postgres does the
      // sign-up counting, so that half stays a fixed amount of work however
      // many students sign up -- pulling the rows back to count them in JS
      // would not.
      const [signups, signups7, signups30, demoSandboxes, paid] = await Promise.all([
        countUsers(),
        countUsers(isoDaysAgo(7)),
        countUsers(isoDaysAgo(30)),
        countDemoUsers(),
        paidTerms(),
      ]);

      return {
        signups,
        signupsLast7Days: signups7,
        signupsLast30Days: signups30,
        demoSandboxes,
        ...foldPaidTerms(paid, todayIso()),
        generatedAt: new Date().toISOString(),
      };
    },

    async setUserProfile(userId, patch) {
      // Read-merge-write rather than a jsonb `||` in SQL, so the local driver
      // and this one apply the same merge and a test against either is a test
      // of both. Two concurrent onboarding submissions from one student are
      // not a race worth a round trip to prevent.
      const { data: existing, error: readError } = await client
        .from("users")
        .select("profile")
        .eq("id", userId)
        .maybeSingle();
      if (readError && readError.code !== NO_ROWS) fail("setUserProfile read", readError);
      if (!existing) return null;
      const current =
        existing.profile && typeof existing.profile === "object"
          ? (existing.profile as UserProfile)
          : {};
      const { data, error } = await client
        .from("users")
        .update({ profile: { ...current, ...patch } })
        .eq("id", userId)
        .select("*")
        .maybeSingle();
      if (error && error.code !== NO_ROWS) fail("setUserProfile", error);
      return data ? userToDomain(data as UserRow) : null;
    },

    async savePendingUpload(userId, termId, fileName, parsed) {
      const { data, error } = await client
        .from("pending_uploads")
        .insert({
          user_id: userId,
          term_id: termId,
          file_name: fileName,
          parsed,
          created_at: new Date().toISOString(),
        })
        .select("*")
        .single();
      if (error) fail("savePendingUpload", error);
      return pendingToDomain(data as PendingUploadRow);
    },

    async getPendingUpload(userId, id) {
      // The user_id predicate IS the ownership check, as with getTerm.
      const { data, error } = await client
        .from("pending_uploads")
        .select("*")
        .eq("id", id)
        .eq("user_id", userId)
        .maybeSingle();
      if (error && error.code !== NO_ROWS) fail("getPendingUpload", error);
      return data ? pendingToDomain(data as PendingUploadRow) : null;
    },

    async listPendingUploads(userId) {
      const { data, error } = await client
        .from("pending_uploads")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
      if (error) fail("listPendingUploads", error);
      return ((data ?? []) as PendingUploadRow[]).map(pendingToDomain);
    },

    async deletePendingUpload(userId, id) {
      const { data, error } = await client
        .from("pending_uploads")
        .delete()
        .eq("id", id)
        .eq("user_id", userId)
        .select("id");
      if (error) fail("deletePendingUpload", error);
      return ((data ?? []) as { id: string }[]).length > 0;
    },

    async getUser(id) {
      const { data, error } = await client
        .from("users")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (error && error.code !== NO_ROWS) fail("getUser", error);
      return data ? userToDomain(data as UserRow) : null;
    },

    async getUserByEmail(email) {
      const { data, error } = await client
        .from("users")
        .select("*")
        .eq("email", email.toLowerCase())
        .maybeSingle();
      if (error && error.code !== NO_ROWS) fail("getUserByEmail", error);
      return data ? userToDomain(data as UserRow) : null;
    },

    async upsertUser(u: UserUpsert) {
      const { data: existing, error: readError } = await client
        .from("users")
        .select("created_at, timezone, calendar_feed_token, calendar_prefs")
        .eq("id", u.id)
        .maybeSingle();
      if (readError && readError.code !== NO_ROWS) fail("upsertUser read", readError);

      // `upsert` replaces the whole row, so anything the caller did not send has
      // to be carried forward here or it is silently lost.
      const stored = existing as
        | {
            created_at: string;
            timezone: string | null;
            calendar_feed_token: string | null;
            calendar_prefs: unknown;
          }
        | null;

      const merged: User = {
        id: u.id,
        email: u.email.toLowerCase(),
        name: u.name,
        picture: u.picture,
        googleRefreshToken: u.googleRefreshToken,
        // Absent key means "keep what is stored": the sign-in flow does not
        // know the browser's zone, and must not clear one already reported.
        timezone: u.timezone !== undefined ? u.timezone : (stored?.timezone ?? null),
        // Same rule, and it matters more: dropping the feed token here would
        // break every calendar app already subscribed to that URL, on every
        // sign-in. The callers that upsert a user do not know it.
        calendarFeedToken:
          u.calendarFeedToken !== undefined
            ? u.calendarFeedToken
            : (stored?.calendar_feed_token ?? null),
        // And again for the sync preferences: they are set on a settings
        // screen this caller knows nothing about, so a sign-in that dropped
        // them would silently re-enable whatever the user turned off. A first
        // create with nothing stored gets `DEFAULT_CALENDAR_PREFS`.
        calendarPrefs: mergeCalendarPrefs(
          u.calendarPrefs !== undefined ? u.calendarPrefs : stored?.calendar_prefs,
        ),
        // First write wins: signing in again must not reset the join date.
        createdAt: stored?.created_at ?? u.createdAt ?? new Date().toISOString(),
      };

      const { data, error } = await client
        .from("users")
        .upsert(userToRow(merged), { onConflict: "id" })
        .select("*")
        .single();
      if (error) fail("upsertUser", error);
      return userToDomain(data as UserRow);
    },

    async setUserTimezone(userId, timezone) {
      const { data, error } = await client
        .from("users")
        .update({ timezone })
        .eq("id", userId)
        .select("*")
        .maybeSingle();
      if (error && error.code !== NO_ROWS) fail("setUserTimezone", error);
      return data ? userToDomain(data as UserRow) : null;
    },

    async setCalendarPrefs(userId, patch) {
      // Read-merge-write rather than a jsonb merge in SQL, so the result is
      // laid over `DEFAULT_CALENDAR_PREFS` exactly once, in one place: a
      // caller that knows about one toggle cannot reset the others, and a
      // value stored before a preference existed still reads back complete.
      const { data: existing, error } = await client
        .from("users")
        .select("calendar_prefs")
        .eq("id", userId)
        .maybeSingle();
      if (error && error.code !== NO_ROWS) fail("setCalendarPrefs read", error);
      if (!existing) return null;

      const merged: CalendarPrefs = mergeCalendarPrefs({
        ...mergeCalendarPrefs((existing as { calendar_prefs: unknown }).calendar_prefs),
        ...patch,
      });

      const { data, error: writeError } = await client
        .from("users")
        .update({ calendar_prefs: merged })
        .eq("id", userId)
        .select("*")
        .maybeSingle();
      if (writeError && writeError.code !== NO_ROWS) fail("setCalendarPrefs", writeError);
      return data ? userToDomain(data as UserRow) : null;
    },

    async ensureCalendarFeedToken(userId) {
      const { data: existing, error } = await client
        .from("users")
        .select("calendar_feed_token")
        .eq("id", userId)
        .maybeSingle();
      if (error && error.code !== NO_ROWS) fail("ensureCalendarFeedToken read", error);
      if (!existing) return null;

      const stored = (existing as { calendar_feed_token: string | null })
        .calendar_feed_token;
      if (stored) return stored;

      // `.is("calendar_feed_token", null)` makes the mint conditional: two
      // concurrent first-time requests both reach here, and the loser updates
      // no rows instead of overwriting the winner's token and killing a feed
      // URL that has already been handed out.
      const { data, error: writeError } = await client
        .from("users")
        .update({ calendar_feed_token: newCalendarFeedToken() })
        .eq("id", userId)
        .is("calendar_feed_token", null)
        .select("calendar_feed_token")
        .maybeSingle();
      if (writeError && writeError.code !== NO_ROWS) {
        fail("ensureCalendarFeedToken", writeError);
      }
      if (data) {
        return (data as { calendar_feed_token: string | null }).calendar_feed_token;
      }

      // Lost the race: hand back whatever the winner wrote, so both callers
      // publish the same URL.
      const { data: after, error: rereadError } = await client
        .from("users")
        .select("calendar_feed_token")
        .eq("id", userId)
        .maybeSingle();
      if (rereadError && rereadError.code !== NO_ROWS) {
        fail("ensureCalendarFeedToken reread", rereadError);
      }
      return after
        ? (after as { calendar_feed_token: string | null }).calendar_feed_token
        : null;
    },

    async resetCalendarFeedToken(userId) {
      // Unconditional, unlike `ensure`: the point of a reset is that the old
      // token stops working, so it always writes a new one.
      const { data, error } = await client
        .from("users")
        .update({ calendar_feed_token: newCalendarFeedToken() })
        .eq("id", userId)
        .select("calendar_feed_token")
        .maybeSingle();
      if (error && error.code !== NO_ROWS) fail("resetCalendarFeedToken", error);
      return data
        ? (data as { calendar_feed_token: string | null }).calendar_feed_token
        : null;
    },

    async getUserByFeedToken(token) {
      // Junk never reaches the database: an empty or truncated token is
      // rejected before the query. `.eq` is whole-value equality -- never
      // `.like`/`.ilike`, which would let a guessed prefix match a real token.
      if (!isFeedTokenShaped(token)) return null;
      const { data, error } = await client
        .from("users")
        .select("*")
        .eq("calendar_feed_token", token.trim())
        .maybeSingle();
      if (error && error.code !== NO_ROWS) fail("getUserByFeedToken", error);
      return data ? userToDomain(data as UserRow) : null;
    },

    /**
     * One statement, because `users.id` is the cascade root for every table in
     * supabase/schema.sql. Verified chain by chain against that file:
     *
     *   users
     *     <- courses.user_id              on delete cascade
     *          <- assessments.course_id        on delete cascade
     *     <- academic_terms.user_id       on delete cascade
     *     <- calendar_links.user_id       on delete cascade  (nullable!)
     *     <- notion_connections.user_id   on delete cascade
     *     <- notion_links.user_id         on delete cascade
     *
     * So `delete from users where id = ?` reaches the user row, their courses,
     * those courses' assessments, their academic terms, the Notion connection,
     * every Notion link they own, and every calendar link that RECORDS an owner.
     *
     * `courses.term_id` is `on delete set null` rather than a cascade, which is
     * the right way round: deleting one term must not delete a course. It makes
     * no difference here, because the courses go with the user anyway.
     *
     * `stripe_events` is deliberately NOT touched: a webhook delivery id is
     * Stripe's record of a message, not a user's data, and forgetting one would
     * re-open the door to processing it twice.
     *
     * The one gap is deliberate and is closed by hand first: `calendar_links`
     * used to key on `assessments.id` and cascade from there, and it no longer
     * can -- a key is now an assessment id, a `sb_<assessmentId>_<n>` study
     * session or a `mt_<courseId>_<n>` class series, and only the first is a
     * row. `user_id` replaced that cascade, but it is nullable, so rows written
     * before it existed have none and nothing would ever collect them. They are
     * attributed by key and deleted below, before the user row goes and takes
     * the courses and assessments those keys are attributed against with it.
     *
     * `notion_links` is worth stating for the same reason: deleteCourse above
     * *does* clear it manually, because `entity_id` carries no foreign key.
     * Deleting the user is a different question -- `user_id` is denormalised
     * onto every link row and does cascade, so all three kinds go.
     *
     * If a future table stores something per user, give it
     * `references public.users (id) on delete cascade` or delete it here.
     */
    async deleteUser(userId) {
      // Before anything else, while the courses and assessments those legacy
      // keys name are still there to attribute them against.
      const linkKeys = (await userCalendarLinkRows(userId)).map((row) => row.key);
      if (linkKeys.length > 0) {
        const { error: linkError } = await client
          .from("calendar_links")
          .delete()
          .in("key", linkKeys);
        if (linkError) fail("deleteUser calendar links", linkError);
      }

      // `.select("id")` is what makes "no such user" distinguishable from a
      // successful delete: PostgREST reports no row count otherwise.
      const { data, error } = await client
        .from("users")
        .delete()
        .eq("id", userId)
        .select("id");
      if (error) fail("deleteUser", error);
      return ((data ?? []) as { id: string }[]).length > 0;
    },

    async listTerms(userId) {
      const { data, error } = await client
        .from("academic_terms")
        .select("*")
        .eq("user_id", userId)
        // Oldest first, and by creation rather than by date: a term inferred
        // from a syllabus that stated no dates still has to have a place in the
        // list.
        .order("created_at", { ascending: true });
      if (error) fail("listTerms", error);
      return ((data ?? []) as TermRow[]).map(termToDomain);
    },

    async getTerm(userId, id) {
      // The user_id predicate IS the ownership check: another user's id matches
      // no rows, which is indistinguishable from "no such term".
      const { data, error } = await client
        .from("academic_terms")
        .select("*")
        .eq("id", id)
        .eq("user_id", userId)
        .maybeSingle();
      if (error && error.code !== NO_ROWS) fail("getTerm", error);
      return data ? termToDomain(data as TermRow) : null;
    },

    async createTerm(userId, input) {
      const now = new Date().toISOString();
      const { data, error } = await client
        .from("academic_terms")
        .insert(termInsertRow(userId, input, now))
        .select("*")
        .single();
      if (error) fail("createTerm", error);
      return termToDomain(data as TermRow);
    },

    async updateTerm(userId, id, patch) {
      const rowPatch = termPatchToRow(patch);
      if (Object.keys(rowPatch).length === 0) {
        // Nothing to write, but the caller still needs the ownership answer --
        // and `updated_at` must not move for an edit that changed nothing.
        const { data, error } = await client
          .from("academic_terms")
          .select("*")
          .eq("id", id)
          .eq("user_id", userId)
          .maybeSingle();
        if (error && error.code !== NO_ROWS) fail("updateTerm read", error);
        return data ? termToDomain(data as TermRow) : null;
      }

      const { data, error } = await client
        .from("academic_terms")
        .update({ ...rowPatch, updated_at: new Date().toISOString() })
        .eq("id", id)
        .eq("user_id", userId)
        .select("*")
        .maybeSingle();
      if (error && error.code !== NO_ROWS) fail("updateTerm", error);
      return data ? termToDomain(data as TermRow) : null;
    },

    async deleteTerm(userId, id) {
      // The courses that referenced it keep everything except the reference:
      // `courses.term_id` is `on delete set null` in supabase/schema.sql, so
      // Postgres does that part. Deleting a term is tidying a label, never
      // throwing away a semester of coursework.
      const { data, error } = await client
        .from("academic_terms")
        .delete()
        .eq("id", id)
        .eq("user_id", userId)
        .select("id");
      if (error) fail("deleteTerm", error);
      return ((data ?? []) as { id: string }[]).length > 0;
    },

    async grantTermPremium(userId, id, grant) {
      // The user_id predicate is what stops a Checkout Session from granting
      // premium on a stranger's term. The webhook reads both ids from Stripe's
      // copy of the metadata, so this predicate is the only thing standing
      // between those two values and a write.
      const { data, error } = await client
        .from("academic_terms")
        .update({
          premium: true,
          premium_started_at: grant.premiumStartedAt,
          // Computed by the caller through `premiumExpiresAt` in `@/lib/terms`,
          // so the fourteen-day grace has one definition in the tree.
          premium_expires_at: grant.premiumExpiresAt,
          paid_end_date: grant.paidEndDate,
          stripe_checkout_session_id: grant.stripeCheckoutSessionId,
          stripe_payment_intent_id: grant.stripePaymentIntentId,
          stripe_customer_id: grant.stripeCustomerId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("user_id", userId)
        .select("*")
        .maybeSingle();
      if (error && error.code !== NO_ROWS) fail("grantTermPremium", error);
      return data ? termToDomain(data as TermRow) : null;
    },

    async recordStripeEvent(id, type) {
      // The INSERT is the lock, not a read followed by a write: Stripe retries
      // deliveries, two of them can arrive at once, and a check-then-write would
      // let both pass and grant premium twice. A primary-key collision is
      // therefore the expected answer rather than an error.
      const { error } = await client.from("stripe_events").insert({
        id,
        type,
        processed_at: new Date().toISOString(),
      });
      if (error) {
        if (error.code === UNIQUE_VIOLATION) return false;
        fail("recordStripeEvent", error);
      }
      return true;
    },

    async forgetStripeEvent(id) {
      const { error } = await client.from("stripe_events").delete().eq("id", id);
      if (error) fail("forgetStripeEvent", error);
    },

    async listCourses(userId) {
      const { data, error } = await client
        .from("courses")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
      if (error) fail("listCourses", error);
      return ((data ?? []) as CourseRow[]).map(courseToDomain);
    },

    async getCourse(id) {
      const { data, error } = await client
        .from("courses")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (error && error.code !== NO_ROWS) fail("getCourse", error);
      return data ? courseToDomain(data as CourseRow) : null;
    },

    async createCourse(userId, parsed: ParsedSyllabus, termId?: string | null) {
      const courseId = randomUUID();
      const course: Course = {
        id: courseId,
        userId,
        code: parsed.course.code,
        title: parsed.course.title,
        instructor: parsed.course.instructor,
        term: parsed.course.term,
        // Resolved by the upload flow, not by the parser: absent means a course
        // with no term row, which the backfill will file later.
        termId: termId ?? null,
        startDate: parsed.course.startDate,
        endDate: parsed.course.endDate,
        meetingTimes: normalizeMeetingTimes(parsed.course.meetingTimes),
        // Empty from both parsers: which sections are the student's is a fact
        // about the student, and the upload flow has not asked yet.
        sections: parsed.course.sections ?? [],
        noClass: parsed.course.noClass ?? [],
        gradeWeights: parsed.course.gradeWeights,
        policies: parsed.course.policies,
        createdAt: new Date().toISOString(),
      };

      const { data: courseData, error: courseError } = await client
        .from("courses")
        .insert(courseToRow(course))
        .select("*")
        .single();
      if (courseError) fail("createCourse", courseError);

      const assessments: Assessment[] = parsed.assessments.map((a) => ({
        id: randomUUID(),
        courseId,
        title: a.title,
        kind: a.kind,
        dueDate: a.dueDate,
        dueTime: a.dueTime,
        endTime: a.endTime,
        weightPercent: a.weightPercent,
        sourceText: a.sourceText,
        confidence: a.confidence,
        // Freshly extracted: nobody has looked at it yet. The parsers set this
        // to null, and it is carried rather than assumed.
        reviewedAt: a.reviewedAt,
        notes: a.notes,
      }));

      if (assessments.length === 0) {
        return { course: courseToDomain(courseData as CourseRow), assessments: [] };
      }

      const { data: rows, error: assessmentError } = await client
        .from("assessments")
        .insert(assessments.map(assessmentToRow))
        .select("*");
      if (assessmentError) {
        // No transactions over PostgREST: drop the orphaned course so a failed
        // upload does not leave an empty course behind.
        await client.from("courses").delete().eq("id", courseId);
        fail("createCourse assessments", assessmentError);
      }

      return {
        course: courseToDomain(courseData as CourseRow),
        assessments: ((rows ?? []) as AssessmentRow[]).map(assessmentToDomain),
      };
    },

    async updateCourse(userId, id, patch) {
      const rowPatch = coursePatchToRow(patch);
      if (Object.keys(rowPatch).length === 0) {
        // Nothing to write, but the caller still needs the ownership answer.
        const { data, error } = await client
          .from("courses")
          .select("*")
          .eq("id", id)
          .eq("user_id", userId)
          .maybeSingle();
        if (error && error.code !== NO_ROWS) fail("updateCourse read", error);
        return data ? courseToDomain(data as CourseRow) : null;
      }

      // The user_id predicate IS the ownership check: another user's id matches
      // no rows, so the update is a no-op that reports "not found".
      const { data, error } = await client
        .from("courses")
        .update(rowPatch)
        .eq("id", id)
        .eq("user_id", userId)
        .select("*")
        .maybeSingle();
      if (error && error.code !== NO_ROWS) fail("updateCourse", error);
      return data ? courseToDomain(data as CourseRow) : null;
    },

    async deleteCourse(userId, courseId) {
      // Read the assessment ids BEFORE the delete: `on delete cascade` takes
      // the assessment rows with the course, and the Notion links keyed on them
      // would then be unreachable.
      const { data: assessmentRows, error: assessmentError } = await client
        .from("assessments")
        .select("id")
        .eq("course_id", courseId);
      if (assessmentError) fail("deleteCourse assessment ids", assessmentError);
      const assessmentIds = ((assessmentRows ?? []) as { id: string }[]).map(
        (r) => r.id,
      );

      // The user_id predicate is the ownership check: another user's id simply
      // matches no rows, so it is indistinguishable from "no such course".
      const { data, error } = await client
        .from("courses")
        .delete()
        .eq("id", courseId)
        .eq("user_id", userId)
        .select("id");
      if (error) fail("deleteCourse", error);
      if (((data ?? []) as { id: string }[]).length === 0) return null;

      // Only after the delete succeeded: a caller who does not own the course
      // must not be able to clear anyone's links.
      const notionPages = await deleteNotionLinksForCourse(
        userId,
        courseId,
        assessmentIds,
      );
      // The course's own class series (`mt_<courseId>_*`) as well as its
      // assessments' deadlines and study sessions. A class meeting is not a
      // row, so nothing else would ever find those links again -- which is why
      // the rows are returned rather than just dropped: the caller deletes the
      // Google events they name.
      const calendarLinks = await deleteCalendarLinksFor(userId, assessmentIds, [courseId]);
      return { calendarLinks, notionPages };
    },

    async listAssessments(userId) {
      const courseIds = await courseIdsFor(userId);
      if (courseIds.length === 0) return [];

      const { data, error } = await client
        .from("assessments")
        .select("*")
        .in("course_id", courseIds)
        .order("due_date", { ascending: true, nullsFirst: false });
      if (error) fail("listAssessments", error);
      return ((data ?? []) as AssessmentRow[]).map(assessmentToDomain);
    },

    async createAssessment(userId, courseId, assessment) {
      // Ownership lives on the course, so it is proven before the insert --
      // there is no transaction to roll back afterwards.
      const { data: course, error: courseError } = await client
        .from("courses")
        .select("id")
        .eq("id", courseId)
        .eq("user_id", userId)
        .maybeSingle();
      if (courseError && courseError.code !== NO_ROWS) {
        fail("createAssessment ownership", courseError);
      }
      if (!course) return null;

      const row: Assessment = {
        id: randomUUID(),
        courseId,
        title: assessment.title,
        kind: assessment.kind,
        dueDate: assessment.dueDate,
        dueTime: assessment.dueTime,
        endTime: assessment.endTime,
        weightPercent: assessment.weightPercent,
        sourceText: assessment.sourceText,
        confidence: assessment.confidence,
        reviewedAt: assessment.reviewedAt,
        notes: assessment.notes,
      };

      const { data, error } = await client
        .from("assessments")
        .insert(assessmentToRow(row))
        .select("*")
        .single();
      if (error) fail("createAssessment", error);
      return assessmentToDomain(data as AssessmentRow);
    },

    async updateAssessment(userId, id, patch) {
      const owned = await ownedAssessment(userId, id);
      if (!owned) return null;

      const rowPatch = assessmentPatchToRow(patch);
      if (Object.keys(rowPatch).length === 0) return assessmentToDomain(owned);

      const { data, error } = await client
        .from("assessments")
        .update(rowPatch)
        .eq("id", id)
        .select("*")
        .single();
      if (error) fail("updateAssessment", error);
      return assessmentToDomain(data as AssessmentRow);
    },

    async deleteAssessment(userId, id) {
      const owned = await ownedAssessment(userId, id);
      // Not-yours and not-there are the same answer, as everywhere else.
      if (!owned) return null;

      const { data, error } = await client
        .from("assessments")
        .delete()
        .eq("id", id)
        .select("id");
      if (error) fail("deleteAssessment", error);
      if (((data ?? []) as { id: string }[]).length === 0) return null;

      // Neither `calendar_links.key` nor `notion_links.entity_id` carries a
      // foreign key -- each mixes assessment ids with planner-minted session
      // ids (and, for calendar links, generated class-series ids) in one
      // column -- so nothing cascades and both are cleared by hand, only after
      // the delete succeeded.
      const notionPages = await deleteNotionLinksForAssessment(userId, id);
      const calendarLinks = await deleteCalendarLinksFor(userId, [id], []);
      return { calendarLinks, notionPages };
    },

    async getCalendarLink(userId, key) {
      const { data, error } = await client
        .from("calendar_links")
        .select("*")
        .eq("key", key)
        .eq("user_id", userId)
        .maybeSingle();
      if (error && error.code !== NO_ROWS) fail("getCalendarLink", error);
      return data ? calendarLinkToDomain(data as CalendarLinkRow) : null;
    },

    async setCalendarLink(key, googleEventId, calendarId) {
      // No owner to record, and an existing one is left alone: this overload
      // cannot know it, and writing null over a stored owner would make a link
      // that `listCalendarLinks` could find stop being findable.
      const { error } = await client.from("calendar_links").upsert(
        {
          key,
          google_event_id: googleEventId,
          calendar_id: calendarId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" },
      );
      if (error) fail("setCalendarLink", error);
    },

    async setCalendarLinkForUser(userId, key, googleEventId, calendarId) {
      const row: CalendarLinkRow = {
        key,
        user_id: userId,
        google_event_id: googleEventId,
        calendar_id: calendarId,
        updated_at: new Date().toISOString(),
      };
      const { error } = await client
        .from("calendar_links")
        .upsert(row, { onConflict: "key" });
      if (error) fail("setCalendarLinkForUser", error);
    },

    async listCalendarLinks(userId, opts?: CalendarLinkQuery) {
      const rows = await userCalendarLinkRows(userId);
      return rows
        .filter((row) => calendarLinkMatchesQuery(row.key, opts))
        .map(keyedCalendarLinkToDomain);
    },

    async deleteCalendarLink(key) {
      const { error } = await client.from("calendar_links").delete().eq("key", key);
      if (error) fail("deleteCalendarLink", error);
    },

    async getNotionConnection(userId) {
      const { data, error } = await client
        .from("notion_connections")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();
      if (error && error.code !== NO_ROWS) fail("getNotionConnection", error);
      return data ? notionConnectionToDomain(data as NotionConnectionRow) : null;
    },

    async setNotionConnection(conn) {
      // Whole-record replace rather than the read-merge-write `upsertUser`
      // does: every caller here (OAuth callback, hub builder, 401 handler)
      // holds the complete connection, and merging would keep the previous
      // workspace's hub ids alive after a reconnect elsewhere.
      const { data, error } = await client
        .from("notion_connections")
        .upsert(notionConnectionToRow(conn), { onConflict: "user_id" })
        .select("*")
        .single();
      if (error) fail("setNotionConnection", error);
      return notionConnectionToDomain(data as NotionConnectionRow);
    },

    async deleteNotionConnection(userId) {
      const { data: connections, error } = await client
        .from("notion_connections")
        .delete()
        .eq("user_id", userId)
        .select("user_id");
      if (error) fail("deleteNotionConnection", error);

      // The links are worthless without the token that created them, and
      // leaving them would make a later reconnect patch pages in a workspace
      // the user may no longer be using.
      const { data: links, error: linkError } = await client
        .from("notion_links")
        .delete()
        .eq("user_id", userId)
        .select("entity_id");
      if (linkError) fail("deleteNotionConnection links", linkError);

      return (
        ((connections ?? []) as { user_id: string }[]).length > 0 ||
        ((links ?? []) as { entity_id: string }[]).length > 0
      );
    },

    async getNotionLink(userId, kind, entityId) {
      const { data, error } = await client
        .from("notion_links")
        .select("*")
        .eq("kind", kind)
        .eq("entity_id", entityId)
        .eq("user_id", userId)
        .maybeSingle();
      if (error && error.code !== NO_ROWS) fail("getNotionLink", error);
      return data ? notionLinkToDomain(data as NotionLinkRow) : null;
    },

    async setNotionLink(link) {
      // (kind, entity_id) is the primary key, so re-linking after Notion 404s
      // on a page the user deleted overwrites the dead page id in place instead
      // of leaving two rows racing to describe one entity.
      const { error } = await client
        .from("notion_links")
        .upsert(notionLinkToRow(link), { onConflict: "kind,entity_id" });
      if (error) fail("setNotionLink", error);
    },

    async listNotionLinks(userId) {
      const { data, error } = await client
        .from("notion_links")
        .select("*")
        .eq("user_id", userId);
      if (error) fail("listNotionLinks", error);
      return ((data ?? []) as NotionLinkRow[])
        .map(notionLinkToDomain)
        .filter((link): link is NotionLink => link !== null);
    },

    async deleteNotionLink(kind, entityId) {
      const { error } = await client
        .from("notion_links")
        .delete()
        .eq("kind", kind)
        .eq("entity_id", entityId);
      if (error) fail("deleteNotionLink", error);
    },
  };
}
