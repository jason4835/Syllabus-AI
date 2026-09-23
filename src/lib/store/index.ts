/**
 * Storage facade for Syllabus Center.
 *
 * Routes never talk to Supabase or the filesystem directly: they talk to
 * `store`. That keeps the demo path (no keys, local JSON file) and the hosted
 * path (Supabase) behind one contract, so a route written against one works
 * unchanged against the other.
 *
 * Server-only. Nothing here may be imported from a client component.
 */

import { randomBytes } from "node:crypto";

import type {
  AcademicTerm,
  Assessment,
  CalendarPrefs,
  Course,
  MeetingKind,
  MeetingTime,
  NotionConnection,
  NotionLink,
  NotionLinkKind,
  ParsedSyllabus,
  PendingUpload,
  TermInput,
  User,
  UserProfile,
} from "@/lib/types";
import { DEFAULT_CALENDAR_PREFS } from "@/lib/types";
import type { Metrics } from "@/lib/metrics";
import { createLocalStore } from "@/lib/store/local";
import { createSupabaseStore } from "@/lib/store/supabase";

/**
 * What `upsertUser` accepts: `createdAt` is assigned on first write.
 *
 * `timezone` is optional because nothing in the sign-in flow knows it -- only
 * the browser does, and it arrives later on its own route. Omitting the key
 * therefore means "leave the stored zone alone"; passing an explicit `null`
 * clears it. Without that distinction every re-authentication would wipe a
 * zone the user had already reported.
 *
 * `calendarFeedToken` is optional for exactly the same reason, and the stakes
 * are higher: it is minted by `ensureCalendarFeedToken`, and a sign-in that
 * dropped it would break every calendar app already subscribed to that URL.
 * The callers that upsert a user (the OAuth callback, demo mode) do not know
 * the token and must not have to.
 *
 * `calendarPrefs` follows the same rule for the same reason: it is the user's
 * own choice about what reaches their calendar, made on a settings screen the
 * sign-in flow knows nothing about. Absent means "keep what is stored"; a first
 * create with no value gets `DEFAULT_CALENDAR_PREFS`.
 */
export type UserUpsert = Omit<
  User,
  "createdAt" | "timezone" | "calendarFeedToken" | "calendarPrefs"
> & {
  createdAt?: string;
  timezone?: string | null;
  calendarFeedToken?: string | null;
  calendarPrefs?: CalendarPrefs;
};

/**
 * A Google Calendar event we already created for something we sync. Persisting
 * it is what makes a re-sync an update instead of a duplicate event.
 */
export interface CalendarLink {
  googleEventId: string;
  calendarId: string;
}

/** A calendar link together with the key it is filed under. */
export interface KeyedCalendarLink extends CalendarLink {
  key: string;
}

/**
 * What `deleteCourse` hands back, so the events it orphans can still be found.
 *
 * The links are dropped from the store as part of the delete -- they name a
 * course that no longer exists -- but the Google events they point at are
 * still on the student's calendar, and once the rows are gone NOTHING can
 * reach them again: the next sync scopes its cleanup by course, and this
 * course is not in any sync's scope any more. So the rows are returned on
 * their way out and the caller is expected to delete the events (see
 * `deleteCalendarEvents` in `@/lib/google/calendar`).
 *
 * Returning them rather than calling Google from the store is deliberate: the
 * store is the one layer with no network in it, and a Google outage must not
 * be able to stop a student deleting their own course.
 */
export interface CourseDeletion {
  /**
   * The calendar links the delete dropped -- deadlines, study sessions and the
   * course's class series. Empty when the course was never synced.
   */
  calendarLinks: KeyedCalendarLink[];
  /**
   * The Notion pages the delete orphaned, for the same reason and with the same
   * expectation: the link rows are the only record of the page ids, and the
   * sync's own removal pass is scoped to the courses being synced, so a deleted
   * course can never reach its pages again.
   *
   * Deliberately narrower than the links dropped: this is the generated rows
   * only -- coursework and study sessions -- and never the course page. A row
   * describing a deadline that no longer exists is simply wrong data, but the
   * class page is where the student's own notes live, and deleting those is not
   * a decision this software makes for them (docs/NOTION.md).
   */
  notionPages: OrphanedNotionPage[];
}

/** One page a delete cut loose: enough to archive it, nothing more. */
export interface OrphanedNotionPage {
  kind: NotionLinkKind;
  entityId: string;
  pageId: string;
}

/**
 * What `deleteAssessment` hands back. The same two cleanups as `CourseDeletion`
 * narrowed to one row -- an assessment's deadline event and its study sessions'
 * are exactly as unreachable once its links are gone as a whole course's are.
 */
export type AssessmentDeletion = CourseDeletion;

/** Narrows a `listCalendarLinks` call to the keys a caller actually cares about. */
export interface CalendarLinkQuery {
  /** Exact keys. */
  keys?: string[];
  /** Key prefixes, e.g. `mt_<courseId>_` for one course's class series. */
  keyPrefixes?: string[];
}

/**
 * Prefix of every Notion link id belonging to one assessment's study sessions.
 *
 * Study sessions are the one synced entity that is never persisted: the planner
 * mints them on demand as `sb_<assessmentId>_<n>` (src/lib/plan/study.ts), so
 * when a course is deleted there is no row to join against and their links can
 * only be found by matching that prefix. Both drivers share this helper so the
 * two cascades cannot drift apart from each other or from the planner.
 */
export function notionSessionLinkPrefix(assessmentId: string): string {
  return studySessionKeyPrefix(assessmentId);
}

/**
 * Prefix of every key belonging to one assessment's study sessions.
 *
 * The planner mints sessions as `sb_<assessmentId>_<n>` (src/lib/plan/study.ts)
 * and never stores them, so a session's calendar link -- like its Notion link
 * -- can only ever be found by matching this prefix. One definition, shared by
 * both drivers and both sync paths, so they cannot drift from the planner.
 */
export function studySessionKeyPrefix(assessmentId: string): string {
  return `sb_${assessmentId}_`;
}

/**
 * Prefix of every key belonging to one course's recurring class series.
 *
 * Class meetings are not rows either: they come out of `Course.meetingTimes`,
 * so their calendar events are keyed `mt_<courseId>_<n>` by the same logic.
 */
export function classMeetingKeyPrefix(courseId: string): string {
  return `mt_${courseId}_`;
}

/**
 * Does a calendar link written BEFORE links carried an owner belong to `userId`?
 *
 * `calendar_links.user_id` is new and nullable, so every row written by an
 * older deploy has none. Those rows are still the user's, and the cleanup the
 * sync is gaining has to be able to find them -- an orphaned event that no
 * longer matches anything is exactly what the student sees on their calendar
 * and cannot explain. The key is the only evidence left: it is either an
 * assessment id of theirs, or one of the two generated prefixes above built
 * from an id of theirs.
 *
 * Attribution is deliberately narrow. A key that matches none of these is left
 * alone rather than guessed at: deleting somebody else's calendar event is a
 * worse outcome than leaving one of ours behind.
 */
export function isLegacyCalendarLinkOf(
  key: string,
  assessmentIds: ReadonlySet<string>,
  courseIds: ReadonlySet<string>,
): boolean {
  if (assessmentIds.has(key)) return true;
  for (const id of assessmentIds) {
    if (key.startsWith(studySessionKeyPrefix(id))) return true;
  }
  for (const id of courseIds) {
    if (key.startsWith(classMeetingKeyPrefix(id))) return true;
  }
  return false;
}

/**
 * The `keys`/`keyPrefixes` filter, as a union: a link matches if it is one of
 * the named keys OR sits under one of the named prefixes. An empty query
 * matches everything, so "all of this user's links" needs no special case.
 */
export function calendarLinkMatchesQuery(key: string, query?: CalendarLinkQuery): boolean {
  const keys = query?.keys;
  const prefixes = query?.keyPrefixes;
  if (!keys && !prefixes) return true;
  if (keys?.includes(key)) return true;
  return prefixes?.some((prefix) => key.startsWith(prefix)) ?? false;
}

const MEETING_KINDS: readonly string[] = [
  "lecture",
  "recitation",
  "lab",
  "office_hours",
  "other",
];

/**
 * Fills in the fields `MeetingTime` gained when office hours and sections
 * became first-class.
 *
 * `meetingTimes` is jsonb / free-form JSON in both drivers, so rows written
 * before those fields existed read back without them. `undefined` is not the
 * same as "a lecture in the only section": it would reach the calendar layer
 * as a missing property and decide nothing, so every row that leaves a driver
 * is completed here instead. Shared so the two drivers cannot disagree about
 * what a legacy row means.
 */
export function normalizeMeetingTimes(value: unknown): MeetingTime[] {
  if (!Array.isArray(value)) return [];
  const out: MeetingTime[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const m = raw as Partial<MeetingTime>;
    if (!Array.isArray(m.daysOfWeek) || typeof m.startTime !== "string") continue;
    out.push({
      kind:
        typeof m.kind === "string" && MEETING_KINDS.includes(m.kind)
          ? (m.kind as MeetingKind)
          : "lecture",
      section: typeof m.section === "string" ? m.section : null,
      instructor: typeof m.instructor === "string" ? m.instructor : null,
      daysOfWeek: m.daysOfWeek.filter((d): d is number => typeof d === "number"),
      startTime: m.startTime,
      endTime: typeof m.endTime === "string" ? m.endTime : m.startTime,
      location: typeof m.location === "string" ? m.location : null,
    });
  }
  return out;
}

/**
 * A stored preferences value laid over the defaults.
 *
 * The column defaults to `{}` and older rows have nothing at all, so a plain
 * read would hand the sync a `CalendarPrefs` with missing keys -- and
 * `prefs.officeHours` reading `undefined` is silently "off" while
 * `prefs.deadlines` reading `undefined` is silently "do not sync the student's
 * deadlines". Merging over `DEFAULT_CALENDAR_PREFS` makes every key present
 * and every absent one mean the documented default.
 */
export function mergeCalendarPrefs(value: unknown): CalendarPrefs {
  const merged: CalendarPrefs = { ...DEFAULT_CALENDAR_PREFS };
  if (typeof value !== "object" || value === null) return merged;
  const partial = value as Partial<Record<keyof CalendarPrefs, unknown>>;
  for (const key of Object.keys(merged) as Array<keyof CalendarPrefs>) {
    if (typeof partial[key] === "boolean") merged[key] = partial[key];
  }
  return merged;
}

/**
 * Mints a calendar-feed secret: 32 random bytes, base64url.
 *
 * 256 bits from a CSPRNG, because this token is the ONLY thing standing between
 * a URL and a student's whole semester -- there is no session, no cookie and no
 * second factor on a feed request, since the calendar app polling it cannot
 * present one. base64url so it can sit in a path segment unescaped.
 *
 * Shared by both drivers so the two cannot drift into different token strengths.
 */
export function newCalendarFeedToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The shortest string worth a database lookup.
 *
 * A minted token is 43 characters; this only has to reject the empty string and
 * the obviously truncated, so a hand-typed "abc" costs no query and cannot get
 * anywhere near a row.
 */
const MIN_FEED_TOKEN_LENGTH = 20;

/** Cheap shape check shared by both drivers, so neither queries on a junk token. */
export function isFeedTokenShaped(token: string | null | undefined): token is string {
  return typeof token === "string" && token.trim().length >= MIN_FEED_TOKEN_LENGTH;
}

export interface Store {
  /**
   * Deployment-wide counts for the operator's `/admin` page: signups, paying
   * members, passes sold. The only method here that is not scoped to one user,
   * and deliberately the only one -- it answers with numbers, never rows, so
   * there is no path from it to somebody's email address.
   */
  metrics(): Promise<Metrics>;

  getUser(id: string): Promise<User | null>;
  /**
   * Merges onboarding answers into the user's profile. A patch, so answering
   * one question later does not blank the others; `completedAt` is what marks
   * the card as done. Null when the user does not exist.
   */
  setUserProfile(userId: string, patch: Partial<UserProfile>): Promise<User | null>;

  /**
   * Keeps a parse the student could not keep yet -- see `PendingUpload`.
   *
   * Written by the upload route on a paywall refusal and read back by the same
   * route with `pendingId` once the term is unlocked. Scoped by owner like
   * everything else: a stranger's id reads as "no such upload".
   */
  savePendingUpload(
    userId: string,
    termId: string | null,
    fileName: string,
    parsed: ParsedSyllabus,
  ): Promise<PendingUpload>;
  getPendingUpload(userId: string, id: string): Promise<PendingUpload | null>;
  /** Newest first, so "the one waiting on this term" is the first match. */
  listPendingUploads(userId: string): Promise<PendingUpload[]>;
  deletePendingUpload(userId: string, id: string): Promise<boolean>;
  getUserByEmail(email: string): Promise<User | null>;
  upsertUser(u: UserUpsert): Promise<User>;
  /**
   * Records the IANA zone the browser reported. Separate from `upsertUser` so
   * the one caller that actually knows the zone cannot accidentally overwrite
   * the rest of the profile. Null when the user does not exist.
   */
  setUserTimezone(userId: string, timezone: string): Promise<User | null>;
  /**
   * Records what the user wants synced. A PATCH, not a replace: a settings
   * screen that only knows about one toggle must not be able to reset the
   * others, and a partial value stored today must still read back complete
   * once another preference is added. Null when the user does not exist.
   */
  setCalendarPrefs(userId: string, patch: Partial<CalendarPrefs>): Promise<User | null>;
  /**
   * The user's calendar-feed secret, minting one on first use. Null when the
   * user does not exist.
   *
   * Idempotent on purpose: the feed URL is pasted into Google/Apple Calendar
   * and then polled forever, so asking for it twice must not invalidate the
   * subscription somebody already made.
   */
  ensureCalendarFeedToken(userId: string): Promise<string | null>;
  /**
   * Replaces the token with a fresh one, revoking every URL handed out so far.
   * This is the "I shared that link by mistake" button, so it always rotates --
   * never returns the existing value. Null when the user does not exist.
   */
  resetCalendarFeedToken(userId: string): Promise<string | null>;
  /**
   * The user a feed token belongs to, or null.
   *
   * This is an unauthenticated lookup -- the token IS the credential -- so the
   * match is exact and whole-value. No prefix, no LIKE, no "starts with":
   * anything that could match more than one stored token turns a guessable
   * prefix into someone else's calendar.
   */
  getUserByFeedToken(token: string): Promise<User | null>;
  /**
   * The account-deletion primitive: erases the user and everything that
   * belongs to them -- courses, assessments, academic terms, calendar links,
   * Notion links, the Notion connection, and the user row itself. False when
   * there was no such user.
   *
   * This must stay TOTAL. Anything a future feature stores per user has to be
   * covered here too, in every driver. A partial delete is worse than no
   * delete feature at all: the user is told their data is gone, the rows are
   * still there, and nothing in the product will ever surface them again for
   * anyone to notice. Adding a per-user table without extending this method is
   * the bug, not an omission to fix later.
   *
   * Deleting our own rows is the whole contract -- pages this app created in
   * someone else's product (Notion) are the user's own notes and are left
   * alone; see docs/NOTION.md.
   */
  deleteUser(userId: string): Promise<boolean>;

  /**
   * The user's terms, oldest first. Ordered by creation rather than by date so
   * a term with no dates yet (inferred from a syllabus that stated none) still
   * has a place in the list.
   */
  listTerms(userId: string): Promise<AcademicTerm[]>;
  /**
   * Scoped by owner: null when the term is not this user's, which is
   * indistinguishable from "no such term" on purpose. Every term route starts
   * here, including the one that creates a Checkout Session.
   */
  getTerm(userId: string, id: string): Promise<AcademicTerm | null>;
  /**
   * Creates a term. Premium is never set here -- it is granted by the verified
   * webhook and nowhere else -- so a create takes only the fields a person (or
   * `suggestTerm`) supplies.
   *
   * `freeCourses` defaults to `FREE_COURSES_PER_TERM`; the backfill passes the
   * number of courses it is migrating in, so a user who had three courses keeps
   * all three. `confirmedAt` defaults to null, which is what marks a term as
   * inferred and still waiting on the student.
   */
  createTerm(
    userId: string,
    input: TermInput & { freeCourses?: number; confirmedAt?: string | null },
  ): Promise<AcademicTerm>;
  /**
   * Edits a term and bumps `updatedAt`. Null when the term is not this user's.
   *
   * The patch is narrow for the same reason `updateCourse`'s is: `premium`,
   * `premiumStartedAt`, `paidEndDate` and the payment ids are the webhook's to
   * write (`grantTermPremium`), and `freeCourses` is the product's allowance,
   * not a field. `premiumExpiresAt` IS reachable, because shortening a paid
   * term moves the expiry earlier with it -- the policy for that lives in
   * `premiumEndDateAllowed`, not here.
   */
  updateTerm(
    userId: string,
    id: string,
    patch: Partial<
      Pick<
        AcademicTerm,
        | "name"
        | "termType"
        | "startDate"
        | "endDate"
        | "confirmedAt"
        | "premiumExpiresAt"
        | "stripeCheckoutSessionId"
      >
    >,
  ): Promise<AcademicTerm | null>;
  /**
   * Removes a term. Courses that referenced it keep everything except the
   * reference: `termId` becomes null, and their `term` text still says what the
   * syllabus called it. Deleting a term must never delete a student's
   * coursework, so this is `on delete set null` in SQL and explicit in the
   * local driver.
   *
   * False when there was no such term, including when it belongs to someone
   * else.
   */
  deleteTerm(userId: string, id: string): Promise<boolean>;
  /**
   * Turns a paid Checkout Session into premium on one term. The ONLY writer of
   * `premium`, called from the signature-verified webhook and nowhere else --
   * the success redirect polls `listTerms` and activates nothing.
   *
   * `premiumExpiresAt` is computed by the caller through `premiumExpiresAt()`
   * in `@/lib/terms`, so the grace period has exactly one definition, and
   * `paidEndDate` records the end date as it stood at purchase so a later edit
   * can be bounded against what was actually bought.
   *
   * Null when the term is not this user's -- the webhook reads both ids from
   * Stripe's copy of the metadata, so this is the check that a session cannot
   * grant premium on a stranger's term.
   */
  grantTermPremium(
    userId: string,
    id: string,
    grant: {
      premiumStartedAt: string;
      premiumExpiresAt: string;
      paidEndDate: string | null;
      stripeCheckoutSessionId: string | null;
      stripePaymentIntentId: string | null;
      stripeCustomerId: string | null;
    },
  ): Promise<AcademicTerm | null>;
  /**
   * Webhook idempotency: true when this event id was recorded just now, false
   * when it was already there.
   *
   * The insert IS the lock. Stripe retries deliveries and can deliver the same
   * event twice, so the handler asks this first and does nothing on false --
   * which is why the answer has to come from the write itself rather than from
   * a read followed by a write, where two concurrent deliveries both read
   * "absent".
   */
  recordStripeEvent(id: string, type: string): Promise<boolean>;
  /**
   * Releases a claim made by `recordStripeEvent` whose handler then failed, so
   * Stripe's retry of that event is processed rather than answered as a
   * duplicate. A no-op for an id that is not on file.
   */
  forgetStripeEvent(id: string): Promise<void>;

  listCourses(userId: string): Promise<Course[]>;
  getCourse(id: string): Promise<Course | null>;
  /**
   * `termId` is the term the upload flow resolved for this syllabus -- the
   * student's choice, or `suggestTerm`'s. Null (the default) is a course with
   * no term row, which is what every course written before terms existed looks
   * like until the backfill runs.
   */
  createCourse(
    userId: string,
    parsed: ParsedSyllabus,
    termId?: string | null,
  ): Promise<{ course: Course; assessments: Assessment[] }>;
  /**
   * Edits the details a person can correct after an upload. Scoped by owner
   * like its neighbours: null when the course is not this user's, which is
   * indistinguishable from "no such course" on purpose.
   *
   * The patch is deliberately narrow. `gradeWeights`, `policies` and
   * `noClass` come from the parser and `createdAt`/`userId` are identity, so
   * none of them are reachable from an API body.
   *
   * `sections` and `meetingTimes` ARE reachable, because both are things only
   * the student can settle. A syllabus for a big course lists every section
   * and the extractor keeps them all; picking the ones the student actually
   * attends -- one per question the syllabus asks -- is `sections`, and
   * correcting a room or a time the extractor read wrong is `meetingTimes` --
   * a whole-array replace, since editing one entry of a list by index over
   * HTTP is a race waiting to happen. Both are replaced whole for the same
   * reason; the route reconciles `sections` against the syllabus first.
   *
   * `termId` is reachable too: moving a course between terms is an edit a
   * student makes, and it is how the backfill files an old course under the term
   * it created for it. Whether the id names a term the caller owns is the
   * route's check, not this one's -- and moving a course into a full free term
   * hits the same paywall an upload does.
   */
  updateCourse(
    userId: string,
    id: string,
    patch: Partial<
      Pick<
        Course,
        | "code"
        | "title"
        | "instructor"
        | "term"
        | "termId"
        | "startDate"
        | "endDate"
        | "sections"
        | "meetingTimes"
      >
    >,
  ): Promise<Course | null>;
  /**
   * Removes one course and everything keyed on it -- its assessments, their
   * calendar links, the course's own class-series links, and the Notion links
   * for all of the above.
   *
   * Returns the calendar links it dropped, or null when there was nothing to
   * delete (including when the course belongs to someone else -- the two are
   * indistinguishable on purpose). Null rather than `false` because the caller
   * has one more job to do: the dropped links are the last record of Google
   * events that would otherwise sit on the student's calendar forever, so a
   * caller that ignores the return value is leaving orphans behind.
   */
  deleteCourse(userId: string, courseId: string): Promise<CourseDeletion | null>;

  listAssessments(userId: string): Promise<Assessment[]>;
  /**
   * Adds one item the extractor missed. Null when the course is not this
   * user's -- ownership is inherited through the course, so it is checked
   * before anything is written rather than after.
   */
  createAssessment(
    userId: string,
    courseId: string,
    assessment: Omit<Assessment, "id" | "courseId">,
  ): Promise<Assessment | null>;
  updateAssessment(
    userId: string,
    id: string,
    patch: Partial<Assessment>,
  ): Promise<Assessment | null>;
  /**
   * Removes one assessment and everything keyed on it: its calendar link, its
   * own Notion link, and the Notion links for the study sessions the planner
   * minted from it (`sb_<id>_*` -- see `notionSessionLinkPrefix`).
   *
   * The same cascade `deleteCourse` performs, narrowed to one row. Leaving a
   * session link behind would point a later sync at a page describing work for
   * a deadline that no longer exists. Null when there was nothing to delete,
   * including when the item belongs to someone else -- and, like `deleteCourse`,
   * the orphaned links come back out on their way to being forgotten so the
   * caller can delete what they name.
   */
  deleteAssessment(userId: string, id: string): Promise<AssessmentDeletion | null>;

  /**
   * The event we last wrote for `key`, or null.
   *
   * A key is an assessment id, `sb_<assessmentId>_<n>` for a study session, or
   * `mt_<courseId>_<n>` for a class series -- only the first is a row id, which
   * is why this table has no foreign key to join through.
   */
  /**
   * Scoped by owner. The key space makes cross-tenant collision unlikely rather
   * than impossible -- an assessment id is a randomUUID, but `sb_<id>_<n>` and
   * `mt_<id>_<n>` are constructed strings -- and "unlikely" is the wrong
   * guarantee for the function that decides which Google event to overwrite.
   */
  getCalendarLink(userId: string, key: string): Promise<CalendarLink | null>;
  /**
   * Records an event without an owner. Kept for callers that predate
   * `user_id`; new code should use `setCalendarLinkForUser`, because a link
   * with no owner cannot be found by `listCalendarLinks` unless its key
   * happens to name one of the user's own ids.
   */
  setCalendarLink(
    key: string,
    googleEventId: string,
    calendarId: string,
  ): Promise<void>;
  /**
   * Upserts a link by key and records who it belongs to.
   *
   * Ownership is what makes cleanup possible: to remove the events for a
   * course a student deleted -- or the nine sections they never attended --
   * the sync has to be able to ask "which events did I write for this user?",
   * and the key alone cannot answer that for anything that is not a row.
   */
  setCalendarLinkForUser(
    userId: string,
    key: string,
    googleEventId: string,
    calendarId: string,
  ): Promise<void>;
  /**
   * Every link belonging to `userId`, optionally narrowed by `keys` /
   * `keyPrefixes` (matched as a union -- see `calendarLinkMatchesQuery`).
   *
   * Ownership is `user_id = userId` OR, for a row written before that column
   * existed, a key attributable to the user (`isLegacyCalendarLinkOf`). A row
   * owned by somebody else is never returned, whatever its key looks like.
   */
  listCalendarLinks(
    userId: string,
    opts?: CalendarLinkQuery,
  ): Promise<KeyedCalendarLink[]>;
  /**
   * Forgets one link. The Google event itself is the sync's business; this
   * only drops our record that we created it.
   */
  deleteCalendarLink(key: string): Promise<void>;

  getNotionConnection(userId: string): Promise<NotionConnection | null>;
  /** Upsert keyed by userId. Replaces the whole record. */
  setNotionConnection(conn: NotionConnection): Promise<NotionConnection>;
  /** Also removes that user's notion links. False when there was nothing to delete. */
  deleteNotionConnection(userId: string): Promise<boolean>;

  /**
   * Scoped by owner, for the same reason `getCalendarLink` is: this decides
   * which Notion page a sync patches, and `entityId` for a study session is a
   * constructed string rather than a row id.
   */
  getNotionLink(
    userId: string,
    kind: NotionLinkKind,
    entityId: string,
  ): Promise<NotionLink | null>;
  /** Upsert keyed by (kind, entityId): a re-link after a 404 must update in place, never duplicate. */
  setNotionLink(link: NotionLink): Promise<void>;
  listNotionLinks(userId: string): Promise<NotionLink[]>;
  /**
   * Forgets one link. The Notion page itself is the sync's business (it
   * archives it first); this only drops our record that we created it.
   */
  deleteNotionLink(kind: NotionLinkKind, entityId: string): Promise<void>;
}

let instance: Store | null = null;

/**
 * Resolved lazily rather than at module load: Next evaluates modules during the
 * build, when the deployment's env vars are not necessarily present yet.
 */
export function getStore(): Store {
  if (instance) return instance;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (url && serviceRoleKey) {
    instance = createSupabaseStore(url, serviceRoleKey);
    console.log("[store] driver=supabase");
  } else {
    instance = createLocalStore();
    const dir = (process.env.DATA_DIR ?? "").trim();
    // Say plainly whether this data survives a redeploy. "driver=local" alone
    // reads the same whether it is a durable volume or a disk about to vanish.
    console.log(
      dir
        ? `[store] driver=local dir=${dir} (persistent volume) -- set SUPABASE_* to use Postgres instead`
        : "[store] driver=local dir=.data (EPHEMERAL -- lost on redeploy) -- mount a volume and set DATA_DIR, or set SUPABASE_*",
    );
  }

  return instance;
}

/**
 * Delegating literal rather than a Proxy so the driver choice still happens on
 * first use, but callers get plain, fully typed methods.
 */
export const store: Store = {
  metrics: () => getStore().metrics(),
  getUser: (id) => getStore().getUser(id),
  setUserProfile: (userId, patch) => getStore().setUserProfile(userId, patch),
  savePendingUpload: (userId, termId, fileName, parsed) =>
    getStore().savePendingUpload(userId, termId, fileName, parsed),
  getPendingUpload: (userId, id) => getStore().getPendingUpload(userId, id),
  listPendingUploads: (userId) => getStore().listPendingUploads(userId),
  deletePendingUpload: (userId, id) => getStore().deletePendingUpload(userId, id),
  getUserByEmail: (email) => getStore().getUserByEmail(email),
  upsertUser: (u) => getStore().upsertUser(u),
  setUserTimezone: (userId, timezone) =>
    getStore().setUserTimezone(userId, timezone),
  setCalendarPrefs: (userId, patch) => getStore().setCalendarPrefs(userId, patch),
  ensureCalendarFeedToken: (userId) => getStore().ensureCalendarFeedToken(userId),
  resetCalendarFeedToken: (userId) => getStore().resetCalendarFeedToken(userId),
  getUserByFeedToken: (token) => getStore().getUserByFeedToken(token),
  deleteUser: (userId) => getStore().deleteUser(userId),
  listTerms: (userId) => getStore().listTerms(userId),
  getTerm: (userId, id) => getStore().getTerm(userId, id),
  createTerm: (userId, input) => getStore().createTerm(userId, input),
  updateTerm: (userId, id, patch) => getStore().updateTerm(userId, id, patch),
  deleteTerm: (userId, id) => getStore().deleteTerm(userId, id),
  grantTermPremium: (userId, id, grant) =>
    getStore().grantTermPremium(userId, id, grant),
  recordStripeEvent: (id, type) => getStore().recordStripeEvent(id, type),
  forgetStripeEvent: (id) => getStore().forgetStripeEvent(id),
  listCourses: (userId) => getStore().listCourses(userId),
  getCourse: (id) => getStore().getCourse(id),
  createCourse: (userId, parsed, termId) =>
    getStore().createCourse(userId, parsed, termId),
  updateCourse: (userId, id, patch) => getStore().updateCourse(userId, id, patch),
  deleteCourse: (userId, courseId) => getStore().deleteCourse(userId, courseId),
  listAssessments: (userId) => getStore().listAssessments(userId),
  createAssessment: (userId, courseId, assessment) =>
    getStore().createAssessment(userId, courseId, assessment),
  updateAssessment: (userId, id, patch) =>
    getStore().updateAssessment(userId, id, patch),
  deleteAssessment: (userId, id) => getStore().deleteAssessment(userId, id),
  getCalendarLink: (userId, key) => getStore().getCalendarLink(userId, key),
  setCalendarLink: (key, googleEventId, calendarId) =>
    getStore().setCalendarLink(key, googleEventId, calendarId),
  setCalendarLinkForUser: (userId, key, googleEventId, calendarId) =>
    getStore().setCalendarLinkForUser(userId, key, googleEventId, calendarId),
  listCalendarLinks: (userId, opts) => getStore().listCalendarLinks(userId, opts),
  deleteCalendarLink: (key) => getStore().deleteCalendarLink(key),
  getNotionConnection: (userId) => getStore().getNotionConnection(userId),
  setNotionConnection: (conn) => getStore().setNotionConnection(conn),
  deleteNotionConnection: (userId) => getStore().deleteNotionConnection(userId),
  getNotionLink: (userId, kind, entityId) =>
    getStore().getNotionLink(userId, kind, entityId),
  setNotionLink: (link) => getStore().setNotionLink(link),
  listNotionLinks: (userId) => getStore().listNotionLinks(userId),
  deleteNotionLink: (kind, entityId) => getStore().deleteNotionLink(kind, entityId),
};

export default store;
