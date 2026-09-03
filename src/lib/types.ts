/**
 * Shared domain contracts for Syllabus AI.
 *
 * Every layer -- parsing, storage, planning, calendar sync, UI -- speaks these
 * types. Treat this file as the interface between modules: change it only with
 * a matching update everywhere it is consumed.
 */

/** A single graded item pulled out of a syllabus. */
export type AssessmentKind =
  | "assignment"
  | "exam"
  | "quiz"
  | "project"
  | "reading"
  | "lab"
  | "presentation"
  | "other";

export interface Assessment {
  id: string;
  courseId: string;
  title: string;
  kind: AssessmentKind;
  /** ISO date (YYYY-MM-DD). Null when the syllabus gave no resolvable date. */
  dueDate: string | null;
  /** Local time (HH:MM, 24h) when the syllabus specified one. */
  dueTime: string | null;
  /** Percentage of the final grade, when the syllabus states it. */
  weightPercent: number | null;
  /** Verbatim snippet the extractor based this item on -- powers "show source". */
  sourceText: string | null;
  /** 0..1 extractor confidence. Items below 0.6 are surfaced for review. */
  confidence: number;
  /**
   * When the user confirmed or edited this item; null until they have.
   * Kept apart from `confidence` on purpose: a reviewed item is treated as
   * certain everywhere, but the extractor's original score stays honest.
   */
  reviewedAt: string | null;
  notes: string | null;
}

/** The threshold below which an unreviewed item is flagged for review. */
export const REVIEW_CONFIDENCE_THRESHOLD = 0.6;

/** Single source of truth for "does this row need the user's eyes". */
export function needsReview(a: Pick<Assessment, "confidence" | "reviewedAt">): boolean {
  return !a.reviewedAt && a.confidence < REVIEW_CONFIDENCE_THRESHOLD;
}

/** A grading-scheme row, e.g. "Homework -- 30%". */
export interface GradeWeight {
  category: string;
  weightPercent: number;
}

/**
 * What a recurring meeting is. Titles, defaults and the user's sync choices
 * all key off this -- office hours must never be put on a calendar as "class".
 */
export type MeetingKind = "lecture" | "recitation" | "lab" | "office_hours" | "other";

/** Recurring class meeting, e.g. "MWF 10:00-10:50". */
export interface MeetingTime {
  kind: MeetingKind;
  /**
   * Section label exactly as the syllabus writes it ("A", "Section 3", "LEC
   * 01"), when the syllabus lists more than one section. Null when there is
   * only one, or the meeting applies to everyone (office hours, usually).
   * A big course's syllabus lists every section; the student is in one.
   */
  section: string | null;
  /** Who runs this meeting when the syllabus says (office hours especially). */
  instructor: string | null;
  /** 0 = Sunday .. 6 = Saturday */
  daysOfWeek: number[];
  startTime: string; // HH:MM
  endTime: string; // HH:MM
  /** Verbatim from the syllabus for THIS meeting. Never guessed or geocoded. */
  location: string | null;
}

/**
 * A stretch of the term when a course does not meet -- a holiday, a recess,
 * or everything after the stated last day of classes. Inclusive dates; a
 * single day has start === end. Drives which class meetings are NOT put on
 * the calendar.
 */
export interface NoClassPeriod {
  start: string;
  end: string;
  reason: string | null;
}

export interface Course {
  id: string;
  userId: string;
  /** e.g. "MATH 221" */
  code: string;
  title: string;
  instructor: string | null;
  term: string | null;
  /** ISO dates bounding the term, when derivable. */
  startDate: string | null;
  endDate: string | null;
  meetingTimes: MeetingTime[];
  /**
   * The section the student chose, matching a `MeetingTime.section`. Null
   * until chosen -- and while the syllabus lists several sections and this is
   * null, no section-specific meeting is synced, because guessing puts the
   * student in someone else's classroom.
   */
  section: string | null;
  /**
   * When the class does not meet. Empty means "meets every week of the
   * term" -- the honest default when a syllabus says nothing about breaks.
   */
  noClass: NoClassPeriod[];
  gradeWeights: GradeWeight[];
  /** Late work, attendance, academic-integrity policies worth remembering. */
  policies: CoursePolicy[];
  createdAt: string;
}

export interface CoursePolicy {
  category: "late_work" | "attendance" | "integrity" | "grading" | "other";
  summary: string;
  sourceText: string | null;
}

/** What the extractor returns for one uploaded syllabus, before persistence. */
export interface ParsedSyllabus {
  course: Omit<Course, "id" | "userId" | "createdAt">;
  assessments: Omit<Assessment, "id" | "courseId">[];
  /** Extractor-level warnings: ambiguous dates, missing weights, low OCR quality. */
  warnings: string[];
}

/** A recommended study session the planner generates (not from the syllabus). */
export interface StudyBlock {
  id: string;
  courseId: string;
  assessmentId: string;
  title: string;
  /** ISO datetime, local. */
  start: string;
  end: string;
  /** Why the planner scheduled this block -- shown in the UI. */
  rationale: string;
}

/** One week of the semester in the workload view. */
export interface WeekLoad {
  /** ISO date of that week's Monday. */
  weekStart: string;
  weekNumber: number;
  assessmentIds: string[];
  /**
   * Hours of work that actually land in this week: planned study sessions
   * plus the sitting/submitting cost of anything due. Scoring by deadline
   * week alone showed 0h for the weeks a student is supposed to be studying,
   * which made the heatmap read as broken.
   */
  estimatedHours: number;
  /** The two halves of estimatedHours, so the UI can say "8h study - 2h due". */
  studyHours: number;
  dueHours: number;
  /** 0..3 -- calm, normal, busy, crunch. */
  intensity: 0 | 1 | 2 | 3;
  /** Human-readable heads-up, e.g. "3 exams in 5 days". */
  warning: string | null;
}

export interface SemesterPlan {
  weeks: WeekLoad[];
  studyBlocks: StudyBlock[];
  generatedAt: string;
  /**
   * The window the weeks are numbered from. Week 1 is the week containing
   * `start`, never the week of the first deadline. `source` says how sure to
   * be: stated in a syllabus, inferred from a term label like "Fall 2026", or
   * -- last resort -- the span of the deadlines themselves.
   */
  term: {
    start: string;
    end: string;
    source: "syllabus" | "inferred" | "deadlines";
  } | null;
}

/** Result of pushing items to Google Calendar. */
export interface CalendarSyncResult {
  created: number;
  updated: number;
  skipped: number;
  /** Recurring class-meeting series written, one per meeting pattern. */
  classSeries: number;
  /** Events removed because their source no longer exists or is deselected. */
  removed: number;
  /** Course ids whose syllabus lists several sections and none is chosen yet. */
  needsSection: string[];
  calendarId: string;
  errors: string[];
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  /** Google OAuth refresh token, when calendar access was granted. */
  googleRefreshToken: string | null;
  /**
   * IANA zone (e.g. "America/New_York") captured from the user's browser.
   *
   * Calendar events are built as floating local datetimes, so SOMETHING has to
   * say which zone "23:59" means. Using the server's zone puts a New York
   * student's midnight deadline at 7pm when the server runs in UTC, so the
   * value has to come from the user, not the host. Null until the browser
   * reports it; callers fall back to the server zone.
   */
  timezone: string | null;
  /**
   * Secret in the user's private calendar-feed URL. Anyone holding it can
   * read the feed, so it is random, never logged, and resettable. Null until
   * the user asks for a feed.
   */
  calendarFeedToken: string | null;
  /** What the calendar sync and feed include. Office hours are opt-in. */
  calendarPrefs: CalendarPrefs;
  createdAt: string;
}

export interface CalendarPrefs {
  classes: boolean;      // lectures
  recitations: boolean;  // recitations and labs
  officeHours: boolean;
  deadlines: boolean;    // assessments: assignments, exams, ...
  studySessions: boolean;
}

export const DEFAULT_CALENDAR_PREFS: CalendarPrefs = {
  classes: true,
  recitations: true,
  officeHours: false,
  deadlines: true,
  studySessions: true,
};

/** Envelope every API route returns, so the client has one shape to handle. */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; detail?: string };

/* ------------------------------------------------------------------------- */
/* Notion                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * One user's link to their Notion workspace. Lives apart from `User` because
 * it carries a bearer secret and a handful of ids that only the Notion layer
 * cares about -- keeping it separate means a `User` can be handed to the
 * client without a redaction step.
 */
export interface NotionConnection {
  userId: string;
  /** Notion access tokens do not expire; this is revoked, never refreshed. */
  accessToken: string;
  workspaceId: string;
  workspaceName: string | null;
  botId: string | null;
  /** The page the user shared during consent. Null until one is chosen. */
  parentPageId: string | null;
  /** The "Syllabus AI" hub page and its three databases. Null until built. */
  hubPageId: string | null;
  hubUrl: string | null;
  coursesDbId: string | null;
  assignmentsDbId: string | null;
  sessionsDbId: string | null;
  /**
   * `needs_parent`: token in hand, no page to build under yet.
   * `revoked`: a request came back 401 -- the user removed the integration.
   */
  status: "connected" | "needs_parent" | "revoked";
  connectedAt: string;
}

/** Which of our entities a Notion page was created for. */
export type NotionLinkKind = "course" | "assessment" | "session";

/** Result of pushing a semester into Notion, mirroring CalendarSyncResult. */
export interface NotionSyncResult {
  created: { courses: number; assignments: number; sessions: number };
  updated: { courses: number; assignments: number; sessions: number };
  skipped: number;
  hubUrl: string | null;
  /** courseId -> Notion page URL, for "Open in Notion" links. */
  coursePages: Record<string, string>;
  errors: string[];
}

/** A Notion page we created for one of our entities -- the idempotency key. */
export interface NotionLink {
  userId: string;
  kind: NotionLinkKind;
  entityId: string;
  pageId: string;
  url: string | null;
}
