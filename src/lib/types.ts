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
  notes: string | null;
}

/** A grading-scheme row, e.g. "Homework -- 30%". */
export interface GradeWeight {
  category: string;
  weightPercent: number;
}

/** Recurring class meeting, e.g. "MWF 10:00-10:50". */
export interface MeetingTime {
  /** 0 = Sunday .. 6 = Saturday */
  daysOfWeek: number[];
  startTime: string; // HH:MM
  endTime: string; // HH:MM
  location: string | null;
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
  /** Estimated hours of work, used to color the heatmap. */
  estimatedHours: number;
  /** 0..3 -- calm, normal, busy, crunch. */
  intensity: 0 | 1 | 2 | 3;
  /** Human-readable heads-up, e.g. "3 exams in 5 days". */
  warning: string | null;
}

export interface SemesterPlan {
  weeks: WeekLoad[];
  studyBlocks: StudyBlock[];
  generatedAt: string;
}

/** Result of pushing items to Google Calendar. */
export interface CalendarSyncResult {
  created: number;
  updated: number;
  skipped: number;
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
  createdAt: string;
}

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
