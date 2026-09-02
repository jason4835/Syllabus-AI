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
  ParsedSyllabus,
  User,
} from "@/lib/types";
import type { CalendarLink, Store, UserUpsert } from "@/lib/store";

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
      // The user_id predicate is the ownership check: another user's id simply
      // matches no rows, so it is indistinguishable from "no such course".
      const { data, error } = await client
        .from("courses")
        .delete()
        .eq("id", courseId)
        .eq("user_id", userId)
        .select("id");
      if (error) fail("deleteCourse", error);
      return ((data ?? []) as { id: string }[]).length > 0;
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
  };
}
