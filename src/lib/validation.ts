/**
 * Field validation shared by every route that accepts user-typed course or
 * assessment data.
 *
 * These rules used to live inside `PATCH /api/assessments/[id]`, which was fine
 * while that was the only route a person could type into. It is not any more:
 * `POST /api/courses/[id]/assessments` creates the same shape, and
 * `PATCH /api/courses/[id]` edits the term window the whole heatmap is numbered
 * from. Three copies of "is this a real date" is how an app ends up accepting
 * `2026-02-30` on one route and rejecting it on another.
 *
 * Everything here is PURE: no I/O, no store, no `next/*`. Each function either
 * returns the normalised value or throws `Invalid` carrying a message that
 * names the offending field, which routes turn into a 422 `detail`. Composing
 * the request-shaped rules (which keys are allowed, which are required, what
 * "nothing to change" means) is deliberately left to the routes -- those differ
 * per route, the field rules do not.
 */

import type { Assessment, AssessmentKind, Course } from "@/lib/types";
import type { MeetingKind, MeetingTime } from "@/lib/types";

/**
 * A field-level rejection. Carries the sentence shown to the user, so a route's
 * catch is `fail("Invalid change.", 422, err.message)` and nothing else.
 */
export class Invalid extends Error {}

/**
 * The `AssessmentKind` union as runtime data -- the single list every layer
 * checks against. The check constraint in supabase/schema.sql, the store's
 * `toKind` coercion and the two assessment routes all have to name the same
 * eight strings, so they all read this one.
 */
export const ASSESSMENT_KINDS: readonly AssessmentKind[] = [
  "assignment",
  "exam",
  "quiz",
  "project",
  "reading",
  "lab",
  "presentation",
  "other",
];

/** The assessment fields a person may set on create or edit. */
export const ASSESSMENT_FIELD_KEYS = [
  "title",
  "kind",
  "dueDate",
  "dueTime",
  "endTime",
  "weightPercent",
  "notes",
] as const;

/** The course fields a person may edit. */
export const COURSE_FIELD_KEYS = [
  "code",
  "title",
  "instructor",
  "term",
  "startDate",
  "endDate",
  "section",
  "meetingTimes",
] as const;

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * True only for a calendar date that actually exists. The regex alone accepts
 * `2026-02-30`, which `Date` silently reads as March 2 -- round-tripping through
 * the parser is what catches it.
 */
export function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** 24-hour `HH:MM`. Anchored, so "9:00" and "24:00" are both rejected. */
export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isRealTime(s: string): boolean {
  return TIME_PATTERN.test(s);
}

/**
 * A `YYYY-MM-DD` string or null, named by field so the message is actionable
 * ("endDate must be ..." rather than "invalid date").
 */
export function validateDateField(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value === "string" && isRealDate(value)) return value;
  throw new Invalid(`${field} must be YYYY-MM-DD or null`);
}

/**
 * Trims, then enforces a length window. Used for the required text fields,
 * where an all-whitespace value is an empty one.
 */
function requiredText(
  value: unknown,
  field: string,
  min: number,
  max: number,
): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (s.length < min || s.length > max) {
    throw new Invalid(`${field} must be ${min}-${max} characters`);
  }
  return s;
}

/**
 * Trims, then enforces a maximum -- or passes null through. An empty (or
 * all-whitespace) string becomes null rather than `""`: the rest of the app
 * already branches on null for "not stated", and storing a blank string would
 * make "no instructor" render as an empty line instead of being skipped.
 */
function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Invalid(`${field} must be text or null`);
  }
  const s = value.trim();
  if (s.length > max) throw new Invalid(`${field} must be at most ${max} characters`);
  return s.length === 0 ? null : s;
}

/* -------------------------------------------------------------------------- */
/* Assessment fields                                                           */
/* -------------------------------------------------------------------------- */

export function validateAssessmentTitle(value: unknown): string {
  return requiredText(value, "title", 1, 200);
}

export function validateAssessmentKind(value: unknown): AssessmentKind {
  if (!(ASSESSMENT_KINDS as readonly unknown[]).includes(value)) {
    throw new Invalid(`kind must be one of: ${ASSESSMENT_KINDS.join(", ")}`);
  }
  return value as AssessmentKind;
}

export function validateDueDate(value: unknown): string | null {
  return validateDateField(value, "dueDate");
}

export function validateDueTime(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "string" && isRealTime(value)) return value;
  throw new Invalid("dueTime must be HH:MM (24h) or null");
}

export function validateEndTime(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "string" && isRealTime(value)) return value;
  throw new Invalid("endTime must be HH:MM (24h) or null");
}

/**
 * 0-100, rounded to two decimals -- the same precision `applyGradeWeights`
 * stores, so a hand-typed weight and a derived one look alike.
 */
export function validateWeightPercent(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Invalid("weightPercent must be a number from 0 to 100, or null");
  }
  return Math.round(value * 100) / 100;
}

/** Notes are free text; the cap only stops a pasted PDF from becoming a row. */
export function validateNotes(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 2000) {
    throw new Invalid("notes must be at most 2000 characters, or null");
  }
  return value;
}

/** A time with no date has no meaning -- 23:59 of *what*? */
export function requireDateForTime(
  dueDate: string | null,
  dueTime: string | null,
): void {
  if (dueTime && !dueDate) throw new Invalid("dueTime requires a dueDate");
}

/**
 * An end without a start is meaningless, and an end before the start is a
 * typo -- the one that would draw an exam as ending before it began.
 */
export function requireStartForEnd(dueTime: string | null, endTime: string | null): void {
  if (!endTime) return;
  if (!dueTime) throw new Invalid("endTime requires a dueTime");
  if (endTime <= dueTime) throw new Invalid("endTime must be after dueTime");
}

/** The user-settable half of an assessment, after validation. */
export type AssessmentFields = Partial<
  Pick<Assessment, "title" | "kind" | "dueDate" | "dueTime" | "endTime" | "weightPercent" | "notes">
>;

/**
 * Validates whichever of the six assessment fields are present in `body`, and
 * only those: an absent key means "leave alone" (PATCH) or "use the default"
 * (POST), which is the caller's decision, not this function's.
 *
 * Key allow-listing, required-field checks and the date/time cross-check are
 * the routes' job, because PATCH and POST genuinely differ there.
 */
export function collectAssessmentFields(
  body: Record<string, unknown>,
): AssessmentFields {
  const fields: AssessmentFields = {};
  if ("title" in body) fields.title = validateAssessmentTitle(body.title);
  if ("kind" in body) fields.kind = validateAssessmentKind(body.kind);
  if ("dueDate" in body) fields.dueDate = validateDueDate(body.dueDate);
  if ("dueTime" in body) fields.dueTime = validateDueTime(body.dueTime);
  if ("endTime" in body) fields.endTime = validateEndTime(body.endTime);
  if ("weightPercent" in body) {
    fields.weightPercent = validateWeightPercent(body.weightPercent);
  }
  if ("notes" in body) fields.notes = validateNotes(body.notes);
  return fields;
}

/* -------------------------------------------------------------------------- */
/* Course patch                                                                */
/* -------------------------------------------------------------------------- */

/** Exactly what `store.updateCourse` accepts. */
export type CoursePatch = Partial<
  Pick<Course, "code" | "title" | "instructor" | "term" | "startDate" | "endDate" | "section" | "meetingTimes">
>;

/**
 * Turns an untrusted body into a course patch, or throws `Invalid` naming the
 * first bad field.
 *
 * `current` matters for the date ordering check: a request that moves only
 * `startDate` still has to be judged against the `endDate` already stored, or a
 * two-step edit could park the term window backwards -- and the heatmap numbers
 * every week from that window.
 *
 * Unknown keys are rejected rather than ignored: a typo like `startdate`
 * silently doing nothing is worse than an error.
 */
export function validateCoursePatch(
  body: Record<string, unknown>,
  current: Pick<Course, "startDate" | "endDate">,
): CoursePatch {
  const allowed = new Set<string>(COURSE_FIELD_KEYS);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new Invalid(`${key} is not an editable field`);
  }

  const patch: CoursePatch = {};
  if ("code" in body) patch.code = requiredText(body.code, "code", 1, 20);
  if ("title" in body) patch.title = requiredText(body.title, "title", 1, 200);
  if ("instructor" in body) {
    patch.instructor = optionalText(body.instructor, "instructor", 120);
  }
  if ("term" in body) patch.term = optionalText(body.term, "term", 40);
  if ("startDate" in body) {
    patch.startDate = validateDateField(body.startDate, "startDate");
  }
  if ("endDate" in body) {
    patch.endDate = validateDateField(body.endDate, "endDate");
  }
  if ("section" in body) patch.section = validateSection(body.section);
  if ("meetingTimes" in body) patch.meetingTimes = validateMeetingTimes(body.meetingTimes);

  if (Object.keys(patch).length === 0) throw new Invalid("nothing to change");

  // Checked against the values the patch LEAVES IN PLACE, not just the ones it
  // carries -- see the doc comment above.
  const start = "startDate" in patch ? patch.startDate : current.startDate;
  const end = "endDate" in patch ? patch.endDate : current.endDate;
  if (start && end && end < start) {
    throw new Invalid("endDate must not be before startDate");
  }

  return patch;
}

/* ------------------------------------------------------------------------- */
/* Course section + meeting times                                             */
/* ------------------------------------------------------------------------- */


export const MEETING_KINDS: readonly MeetingKind[] = [
  "lecture", "recitation", "lab", "office_hours", "other",
];

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;


export function validateSection(value: unknown): string | null {
  return optionalText(value, "section", 40);
}

/**
 * The whole array is replaced on edit, so every row is checked from scratch.
 * Locations are kept verbatim -- the one thing this must never do is "fix" a
 * room string the student typed to match what the syllabus said.
 */
export function validateMeetingTimes(value: unknown): MeetingTime[] {
  if (!Array.isArray(value)) throw new Invalid("meetingTimes must be an array");
  if (value.length > 20) throw new Invalid("meetingTimes: at most 20 meetings");
  return value.map((row, i) => {
    const at = `meetingTimes[${i}]`;
    if (!row || typeof row !== "object") throw new Invalid(`${at} must be an object`);
    const r = row as Record<string, unknown>;
    const kind = (r.kind ?? "lecture") as MeetingKind;
    if (!MEETING_KINDS.includes(kind)) throw new Invalid(`${at}.kind must be one of: ${MEETING_KINDS.join(", ")}`);
    const days = r.daysOfWeek;
    if (!Array.isArray(days) || days.length === 0) throw new Invalid(`${at}.daysOfWeek needs at least one day`);
    const daysOfWeek = [...new Set(days.map((d) => Number(d)))].sort((a, b) => a - b);
    if (daysOfWeek.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new Invalid(`${at}.daysOfWeek must be 0-6`);
    const startTime = typeof r.startTime === "string" ? r.startTime : "";
    const endTime = typeof r.endTime === "string" ? r.endTime : "";
    if (!TIME_RE.test(startTime)) throw new Invalid(`${at}.startTime must be HH:MM`);
    if (!TIME_RE.test(endTime)) throw new Invalid(`${at}.endTime must be HH:MM`);
    if (endTime <= startTime) throw new Invalid(`${at}: endTime must be after startTime`);
    return {
      kind,
      section: optionalText(r.section, `${at}.section`, 40),
      instructor: optionalText(r.instructor, `${at}.instructor`, 120),
      daysOfWeek,
      startTime,
      endTime,
      location: optionalText(r.location, `${at}.location`, 120),
    };
  });
}
