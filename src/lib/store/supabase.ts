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
  Assessment,
  AssessmentKind,
  Course,
  CoursePolicy,
  GradeWeight,
  MeetingTime,
  NotionConnection,
  NotionLink,
  NotionLinkKind,
  ParsedSyllabus,
  User,
} from "@/lib/types";
import type { CalendarLink, Store, UserUpsert } from "@/lib/store";
import { notionSessionLinkPrefix } from "@/lib/store";

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
  created_at: string;
}

interface CourseRow {
  id: string;
  user_id: string;
  code: string;
  title: string;
  instructor: string | null;
  term: string | null;
  start_date: string | null;
  end_date: string | null;
  meeting_times: unknown;
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
  weight_percent: number | string | null;
  source_text: string | null;
  confidence: number | string;
  notes: string | null;
}

interface CalendarLinkRow {
  assessment_id: string;
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

const ASSESSMENT_KINDS: readonly AssessmentKind[] = [
  "assignment",
  "exam",
  "quiz",
  "project",
  "reading",
  "lab",
  "presentation",
  "other",
];

// -- Coercion helpers -------------------------------------------------------

/** jsonb comes back as `unknown`; a malformed column must not crash a page. */
function jsonArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
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
    startDate: row.start_date,
    endDate: row.end_date,
    meetingTimes: jsonArray<MeetingTime>(row.meeting_times),
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
    start_date: course.startDate,
    end_date: course.endDate,
    meeting_times: course.meetingTimes,
    grade_weights: course.gradeWeights,
    policies: course.policies,
    created_at: course.createdAt,
  };
}

function assessmentToDomain(row: AssessmentRow): Assessment {
  return {
    id: row.id,
    courseId: row.course_id,
    title: row.title,
    kind: toKind(row.kind),
    dueDate: row.due_date,
    dueTime: row.due_time,
    weightPercent: toNumberOrNull(row.weight_percent),
    sourceText: row.source_text,
    confidence: toNumberOrNull(row.confidence) ?? 0,
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
    weight_percent: assessment.weightPercent,
    source_text: assessment.sourceText,
    confidence: assessment.confidence,
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
  if (patch.weightPercent !== undefined) row.weight_percent = patch.weightPercent;
  if (patch.sourceText !== undefined) row.source_text = patch.sourceText;
  if (patch.confidence !== undefined) row.confidence = patch.confidence;
  if (patch.notes !== undefined) row.notes = patch.notes;
  return row;
}

function calendarLinkToDomain(row: CalendarLinkRow): CalendarLink {
  return { googleEventId: row.google_event_id, calendarId: row.calendar_id };
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
  ): Promise<void> {
    const { error: courseError } = await client
      .from("notion_links")
      .delete()
      .eq("user_id", userId)
      .eq("kind", "course")
      .eq("entity_id", courseId);
    if (courseError) fail("deleteCourse notion course link", courseError);

    if (assessmentIds.length === 0) return;

    const { error: assessmentError } = await client
      .from("notion_links")
      .delete()
      .eq("user_id", userId)
      .eq("kind", "assessment")
      .in("entity_id", assessmentIds);
    if (assessmentError) {
      fail("deleteCourse notion assessment links", assessmentError);
    }

    // Session links can only be matched by prefix. Reading this user's session
    // links and filtering in JS beats hand-assembling an N-clause PostgREST
    // `or=(entity_id.like.*)` string, where one unescaped id would silently
    // widen the delete.
    const { data, error } = await client
      .from("notion_links")
      .select("entity_id")
      .eq("user_id", userId)
      .eq("kind", "session");
    if (error) fail("deleteCourse notion session links", error);

    const prefixes = assessmentIds.map(notionSessionLinkPrefix);
    const orphaned = ((data ?? []) as { entity_id: string }[])
      .map((r) => r.entity_id)
      .filter((id) => prefixes.some((prefix) => id.startsWith(prefix)));
    if (orphaned.length === 0) return;

    const { error: sessionError } = await client
      .from("notion_links")
      .delete()
      .eq("user_id", userId)
      .eq("kind", "session")
      .in("entity_id", orphaned);
    if (sessionError) fail("deleteCourse notion session links", sessionError);
  }

  return {
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
        .select("created_at, timezone")
        .eq("id", u.id)
        .maybeSingle();
      if (readError && readError.code !== NO_ROWS) fail("upsertUser read", readError);

      // `upsert` replaces the whole row, so anything the caller did not send has
      // to be carried forward here or it is silently lost.
      const stored = existing as
        | { created_at: string; timezone: string | null }
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

    async createCourse(userId, parsed: ParsedSyllabus) {
      const courseId = randomUUID();
      const course: Course = {
        id: courseId,
        userId,
        code: parsed.course.code,
        title: parsed.course.title,
        instructor: parsed.course.instructor,
        term: parsed.course.term,
        startDate: parsed.course.startDate,
        endDate: parsed.course.endDate,
        meetingTimes: parsed.course.meetingTimes,
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
        weightPercent: a.weightPercent,
        sourceText: a.sourceText,
        confidence: a.confidence,
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
      if (((data ?? []) as { id: string }[]).length === 0) return false;

      // Only after the delete succeeded: a caller who does not own the course
      // must not be able to clear anyone's links.
      await deleteNotionLinksForCourse(userId, courseId, assessmentIds);
      return true;
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

    async getCalendarLink(assessmentId) {
      const { data, error } = await client
        .from("calendar_links")
        .select("*")
        .eq("assessment_id", assessmentId)
        .maybeSingle();
      if (error && error.code !== NO_ROWS) fail("getCalendarLink", error);
      return data ? calendarLinkToDomain(data as CalendarLinkRow) : null;
    },

    async setCalendarLink(assessmentId, googleEventId, calendarId) {
      const row: CalendarLinkRow = {
        assessment_id: assessmentId,
        google_event_id: googleEventId,
        calendar_id: calendarId,
        updated_at: new Date().toISOString(),
      };
      const { error } = await client
        .from("calendar_links")
        .upsert(row, { onConflict: "assessment_id" });
      if (error) fail("setCalendarLink", error);
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

    async getNotionLink(kind, entityId) {
      const { data, error } = await client
        .from("notion_links")
        .select("*")
        .eq("kind", kind)
        .eq("entity_id", entityId)
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
  };
}
