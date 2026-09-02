/**
 * Google Calendar sync.
 *
 * Two design decisions drive this file:
 *
 * 1. We never write to the user's primary calendar. Everything lands in a
 *    dedicated secondary calendar named "Syllabus AI", so a student can hide
 *    or delete the whole thing in one click without collateral damage.
 *
 * 2. Sync is idempotent. Every event we create is recorded in the store
 *    against the id of the assessment or study block that produced it, so a
 *    second sync PATCHes instead of duplicating. Re-syncing is the normal
 *    case (a syllabus gets re-parsed, a date gets corrected), not the edge.
 *
 * 3. Every timed event carries the *user's* IANA zone explicitly. Leaving the
 *    datetimes floating makes Google resolve them in the calendar's zone, and
 *    the calendar is created once -- a user who travels, or who corrects a zone
 *    we guessed wrong, would keep getting every deadline in the old one. On a
 *    UTC host that put a New York student's 23:59 deadline at 19:59.
 *
 * The dry-run path walks the exact same loop and skips only the network calls,
 * which is what lets demo mode report counts that match what a real sync would
 * do.
 *
 * Server-only.
 */

import { google, type calendar_v3 } from "googleapis";
import { store } from "@/lib/store";
import { getAuthedClient } from "@/lib/google/oauth";
import type {
  Assessment,
  CalendarSyncResult,
  Course,
  StudyBlock,
} from "@/lib/types";

/** Summary we look the dedicated calendar up by, and create it with. */
const CALENDAR_NAME = "Syllabus AI";

/**
 * Placeholder returned by a dry run. It is deliberately not a real calendar
 * id so a caller that tries to use it fails loudly instead of writing
 * somewhere unexpected.
 */
export const DRY_RUN_CALENDAR_ID = "dry-run";

/** How long an assessment's timed event runs before its due moment. */
const TIMED_EVENT_DURATION_MINUTES = 60;

const REMINDER_ONE_DAY = 24 * 60;
const REMINDER_ONE_WEEK = 7 * 24 * 60;
const REMINDER_STUDY_BLOCK = 30;

/**
 * Last-resort zone: what the host process is in. Correct only for a user who
 * happens to share it, which is why it is a fallback and not the source.
 */
function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * The zone every datetime in this sync is anchored to. The stored value comes
 * from the user's own browser, so it beats anything the server can infer.
 */
async function resolveTimeZone(userId: string): Promise<string> {
  const user = await store.getUser(userId);
  return user?.timezone ?? serverTimeZone();
}

export interface SyncOptions {
  courses: Course[];
  assessments: Assessment[];
  studyBlocks?: StudyBlock[];
  /** Compute the plan and the counts without touching the network. Powers demo mode. */
  dryRun?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Planning -- pure, shared by the real and dry-run paths                      */
/* -------------------------------------------------------------------------- */

type EventDateTime =
  | { date: string }
  | { dateTime: string; timeZone?: string };

interface PlannedEvent {
  /**
   * Assessment id or study block id. This is the key both the calendar link
   * table and this planner agree on -- everything else about an event can
   * change between syncs, this cannot.
   */
  sourceId: string;
  summary: string;
  description: string;
  start: EventDateTime;
  end: EventDateTime;
  /** Minutes-before values for popup reminders. */
  reminderMinutes: number[];
}

interface SyncPlan {
  events: PlannedEvent[];
  /** Items we could not place on a calendar at all (no resolvable date). */
  skipped: number;
  /** Planning-time problems, e.g. a malformed date. Merged into the result. */
  errors: string[];
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIME = /^(\d{2}):(\d{2})$/;

/**
 * Parses "YYYY-MM-DD" (+ optional "HH:MM") into UTC-epoch milliseconds.
 *
 * We treat the components as if they were UTC purely as arithmetic scaffolding
 * -- it lets us add and subtract hours without a DST-aware library. The value
 * is formatted straight back into a floating local datetime string, so no
 * timezone is ever actually applied.
 */
function toEpochScaffold(date: string, time: string): number | null {
  const d = ISO_DATE.exec(date);
  const t = ISO_TIME.exec(time);
  if (!d || !t) return null;
  return Date.UTC(
    Number(d[1]),
    Number(d[2]) - 1,
    Number(d[3]),
    Number(t[1]),
    Number(t[2]),
  );
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Formats scaffold milliseconds back to a floating local "YYYY-MM-DDTHH:MM:SS". */
function formatLocalDateTime(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`
  );
}

/** All-day events use an exclusive end date, so a one-day event ends the next day. */
function nextDay(date: string): string | null {
  const ms = toEpochScaffold(date, "00:00");
  if (ms === null) return null;
  return formatLocalDateTime(ms + 24 * 60 * 60 * 1000).slice(0, 10);
}

function describeAssessment(a: Assessment, courseTitle: string | null): string {
  const lines: string[] = [];
  lines.push(`Type: ${a.kind}`);
  if (courseTitle) lines.push(`Course: ${courseTitle}`);
  if (a.weightPercent !== null) {
    lines.push(`Worth: ${a.weightPercent}% of the final grade`);
  }
  if (a.notes) lines.push("", a.notes);
  // Trailing provenance line: makes it obvious in the user's calendar where an
  // event came from, and lets them search for ours.
  lines.push("", "Created by Syllabus AI");
  return lines.join("\n");
}

function describeStudyBlock(b: StudyBlock): string {
  return ["Study session", "", b.rationale, "", "Created by Syllabus AI"].join("\n");
}

/**
 * Turns courses + assessments + study blocks into the exact list of events we
 * intend to have on the calendar. Pure: no store, no network. Both sync paths
 * call this, so dry-run counts cannot drift from real ones.
 */
function planEvents(opts: SyncOptions, timeZone: string): SyncPlan {
  const events: PlannedEvent[] = [];
  const errors: string[] = [];
  let skipped = 0;

  const coursesById = new Map(opts.courses.map((c) => [c.id, c]));

  for (const a of opts.assessments) {
    const course = coursesById.get(a.courseId) ?? null;
    // Fall back to the bare title rather than printing a placeholder code: an
    // orphaned assessment is still more useful on the calendar than not.
    const summary = course ? `${course.code}: ${a.title}` : a.title;
    const description = describeAssessment(a, course ? course.title : null);

    if (a.dueDate === null) {
      // Nothing to schedule against. The UI surfaces these for manual dating.
      skipped += 1;
      continue;
    }

    // Exams get a second, week-out nudge -- that is the one deadline where a
    // 24-hour warning is already too late to act on.
    const reminderMinutes =
      a.kind === "exam"
        ? [REMINDER_ONE_WEEK, REMINDER_ONE_DAY]
        : [REMINDER_ONE_DAY];

    if (a.dueTime) {
      const dueMs = toEpochScaffold(a.dueDate, a.dueTime);
      if (dueMs === null) {
        errors.push(`${a.title}: unparseable due date/time (${a.dueDate} ${a.dueTime})`);
        skipped += 1;
        continue;
      }
      // The event *ends* at the due moment, so it reads as "the hour before
      // this is due" on the calendar rather than starting when it is too late.
      const startMs = dueMs - TIMED_EVENT_DURATION_MINUTES * 60 * 1000;
      events.push({
        sourceId: a.id,
        summary,
        description,
        start: { dateTime: formatLocalDateTime(startMs), timeZone },
        end: { dateTime: formatLocalDateTime(dueMs), timeZone },
        reminderMinutes,
      });
      continue;
    }

    const end = nextDay(a.dueDate);
    if (!ISO_DATE.test(a.dueDate) || end === null) {
      errors.push(`${a.title}: unparseable due date (${a.dueDate})`);
      skipped += 1;
      continue;
    }
    // All-day: `date` with no timeZone. A zone on a date-only event is what
    // makes Google shift it into the neighbouring day.
    events.push({
      sourceId: a.id,
      summary,
      description,
      start: { date: a.dueDate },
      end: { date: end },
      reminderMinutes,
    });
  }

  for (const b of opts.studyBlocks ?? []) {
    const course = coursesById.get(b.courseId) ?? null;
    events.push({
      sourceId: b.id,
      summary: course ? `Study: ${course.code}: ${b.title}` : `Study: ${b.title}`,
      description: describeStudyBlock(b),
      // Planner output is already a local ISO datetime, per types.ts.
      start: { dateTime: b.start, timeZone },
      end: { dateTime: b.end, timeZone },
      reminderMinutes: [REMINDER_STUDY_BLOCK],
    });
  }

  return { events, skipped, errors };
}

function toEventBody(planned: PlannedEvent): calendar_v3.Schema$Event {
  return {
    summary: planned.summary,
    description: planned.description,
    start: planned.start,
    end: planned.end,
    reminders: {
      // The calendar's own defaults would add noise on top of ours.
      useDefault: false,
      overrides: planned.reminderMinutes.map((minutes) => ({
        method: "popup",
        minutes,
      })),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Google error handling                                                       */
/* -------------------------------------------------------------------------- */

interface GoogleErrorInfo {
  status: number | null;
  reason: string | null;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Pulls status/reason out of a Gaxios error without asserting its shape. */
function describeGoogleError(err: unknown): GoogleErrorInfo {
  let status: number | null = null;
  let reason: string | null = null;
  let message = err instanceof Error ? err.message : String(err);

  if (isRecord(err)) {
    if (typeof err.status === "number") status = err.status;
    if (typeof err.code === "number") status = status ?? err.code;

    const response = err.response;
    if (status === null && isRecord(response) && typeof response.status === "number") {
      status = response.status;
    }

    const errors = err.errors;
    if (Array.isArray(errors) && errors.length > 0 && isRecord(errors[0])) {
      const first = errors[0];
      if (typeof first.reason === "string") reason = first.reason;
      if (typeof first.message === "string") message = first.message;
    }
  }

  return { status, reason, message };
}

const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "backendError",
]);

function isRetryable({ status, reason }: GoogleErrorInfo): boolean {
  if (reason && RATE_LIMIT_REASONS.has(reason)) return true;
  if (status === 429) return true;
  if (status !== null && status >= 500 && status < 600) return true;
  return false;
}

const MAX_ATTEMPTS = 4;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bounded exponential backoff with jitter. Bounded, not unbounded, because a
 * sync runs inside a request: better to report a handful of failed events than
 * to hold the response open indefinitely.
 */
async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (!isRetryable(describeGoogleError(err)) || attempt === MAX_ATTEMPTS - 1) {
        throw err;
      }
      // Jitter keeps a batch of events from retrying in lockstep.
      await delay(2 ** attempt * 400 + Math.floor(Math.random() * 250));
    }
  }
  throw lastError;
}

/* -------------------------------------------------------------------------- */
/* Calendar resolution                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The user's "Syllabus AI" calendar list entry, or null if they have none.
 *
 * We match on summary rather than storing the id because the user may delete
 * the calendar between syncs; looking it up every time means the next sync
 * quietly recreates it instead of failing.
 *
 * Split out of `resolveCalendarId` so account deletion can ask the same
 * question without the create-on-miss half -- `deleteSyllabusCalendar` must
 * not conjure a calendar just to delete it. One name constant and one search
 * for both callers: the definition of "ours" cannot be allowed to drift
 * between the code that writes to a calendar and the code that destroys one.
 *
 * The whole entry comes back rather than just the id, because the caller that
 * deletes needs to re-check what it is holding (see below).
 */
async function findSyllabusCalendar(
  api: calendar_v3.Calendar,
): Promise<calendar_v3.Schema$CalendarListEntry | null> {
  let pageToken: string | undefined;
  do {
    const list = await withRetry(() =>
      api.calendarList.list({ maxResults: 250, pageToken, showHidden: true }),
    );
    for (const entry of list.data.items ?? []) {
      if (entry.summary === CALENDAR_NAME && entry.id) return entry;
    }
    pageToken = list.data.nextPageToken ?? undefined;
  } while (pageToken);
  return null;
}

/** Finds the "Syllabus AI" calendar, creating it on first sync. */
async function resolveCalendarId(
  api: calendar_v3.Calendar,
  timeZone: string,
): Promise<string> {
  const existing = await findSyllabusCalendar(api);
  if (existing?.id) return existing.id;

  const created = await withRetry(() =>
    api.calendars.insert({
      requestBody: {
        summary: CALENDAR_NAME,
        description: "Deadlines and study blocks synced from your syllabi by Syllabus AI.",
        // A sensible default for the calendar itself. Events carry their own
        // zone regardless, so this is presentation, not correctness.
        timeZone,
      },
    }),
  );
  const id = created.data.id;
  if (!id) throw new Error('Google created the "Syllabus AI" calendar but returned no id.');
  return id;
}

/* -------------------------------------------------------------------------- */
/* Sync                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Pushes assessments and study blocks to the user's "Syllabus AI" calendar.
 *
 * Per-event failures are collected in `errors` and never abort the run: one
 * bad date should not cost a student the other twenty deadlines.
 */
export async function syncToCalendar(
  userId: string,
  opts: SyncOptions,
): Promise<CalendarSyncResult> {
  const dryRun = opts.dryRun === true;
  // Resolved before the dryRun branch so a dry run plans against exactly the
  // zone a real sync would use.
  const timeZone = await resolveTimeZone(userId);
  const plan = planEvents(opts, timeZone);

  const result: CalendarSyncResult = {
    created: 0,
    updated: 0,
    skipped: plan.skipped,
    calendarId: DRY_RUN_CALENDAR_ID,
    errors: [...plan.errors],
  };

  let api: calendar_v3.Calendar | null = null;

  if (!dryRun) {
    try {
      const auth = await getAuthedClient(userId);
      api = google.calendar({ version: "v3", auth });
      result.calendarId = await resolveCalendarId(api, timeZone);
    } catch (err) {
      // Nothing can be synced without a calendar, so this is the one failure
      // that legitimately ends the run -- reported, not thrown.
      result.errors.push(`Calendar unavailable: ${describeGoogleError(err).message}`);
      result.skipped += plan.events.length;
      return result;
    }
  }

  for (const planned of plan.events) {
    try {
      const link = await store.getCalendarLink(planned.sourceId);

      if (link) {
        let relinked = false;

        if (!dryRun && api) {
          const calendar = api;
          try {
            await withRetry(() =>
              calendar.events.patch({
                calendarId: link.calendarId,
                eventId: link.googleEventId,
                requestBody: toEventBody(planned),
              }),
            );
          } catch (err) {
            const info = describeGoogleError(err);
            // 404/410: the user deleted (or permanently removed) the event.
            // Recreate it and repoint the link rather than failing forever.
            if (info.status !== 404 && info.status !== 410) throw err;
            const inserted = await withRetry(() =>
              calendar.events.insert({
                calendarId: result.calendarId,
                requestBody: toEventBody(planned),
              }),
            );
            const eventId = inserted.data.id;
            if (!eventId) throw new Error("Google returned no event id on insert.");
            await store.setCalendarLink(planned.sourceId, eventId, result.calendarId);
            relinked = true;
          }
        }

        if (relinked) result.created += 1;
        else result.updated += 1;
        continue;
      }

      if (!dryRun && api) {
        const inserted = await withRetry(() =>
          api.events.insert({
            calendarId: result.calendarId,
            requestBody: toEventBody(planned),
          }),
        );
        const eventId = inserted.data.id;
        if (!eventId) throw new Error("Google returned no event id on insert.");
        await store.setCalendarLink(planned.sourceId, eventId, result.calendarId);
      }

      result.created += 1;
    } catch (err) {
      result.errors.push(`${planned.summary}: ${describeGoogleError(err).message}`);
    }
  }

  return result;
}

/**
 * The exact event bodies a sync would send, without a Google account.
 *
 * Which zone an event ends up in is otherwise only observable in what Google
 * received, so this is the one seam that makes the timezone behaviour testable.
 * It shares `resolveTimeZone` and `planEvents` with `syncToCalendar`, so it
 * cannot report a payload the real path would not send.
 */
export async function planCalendarPayloads(
  userId: string,
  opts: SyncOptions,
): Promise<calendar_v3.Schema$Event[]> {
  const plan = planEvents(opts, await resolveTimeZone(userId));
  return plan.events.map(toEventBody);
}

/* -------------------------------------------------------------------------- */
/* Deletion                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Removes the user's "Syllabus AI" calendar from their Google account. Returns
 * false when there was none to remove.
 *
 * This is the ONLY destructive call this app makes against someone's Google
 * account, and `calendars.delete` is not undoable -- it takes the calendar and
 * every event on it. Aimed at the wrong id it is a catastrophe rather than a
 * bug: `calendars.delete({ calendarId: "primary" })` erases a person's entire
 * personal calendar, years of appointments this app never created and has no
 * business touching.
 *
 * So the id is never supplied by a caller. It comes from `findSyllabusCalendar`
 * -- the same summary match the sync uses -- and is then re-checked here, on
 * the entry actually about to be deleted, against `primary` and against the
 * exact calendar name. That re-check is deliberately redundant with the
 * lookup: the lookup is shared code that a future change could loosen (a
 * case-insensitive match, a fallback to the first calendar, a "" summary
 * meaning primary), and none of those edits should be able to turn this
 * function into a primary-calendar wipe. A guard is cheap; the failure it
 * prevents is not recoverable.
 *
 * Throws on a real API failure so the caller can report it -- account deletion
 * treats this as best effort and continues regardless.
 */
export async function deleteSyllabusCalendar(userId: string): Promise<boolean> {
  const auth = await getAuthedClient(userId);
  const api = google.calendar({ version: "v3", auth });

  const entry = await findSyllabusCalendar(api);
  if (!entry?.id) return false;
  const calendarId = entry.id;

  // Google treats the literal "primary" as an alias for the account's own
  // calendar, and flags that entry with `primary: true`. Refuse both spellings.
  if (entry.primary === true || calendarId === "primary") {
    throw new Error(
      `Refusing to delete the primary Google calendar: the "${CALENDAR_NAME}" lookup returned it.`,
    );
  }
  // Only a calendar carrying our exact name is ours to destroy. Anything else
  // is a calendar the user made, or one we mis-identified.
  if (entry.summary !== CALENDAR_NAME) {
    throw new Error(
      `Refusing to delete Google calendar "${entry.summary ?? "(unnamed)"}": only "${CALENDAR_NAME}" is ours to remove.`,
    );
  }

  try {
    // `calendars.delete`, not `calendarList.delete`: the latter only
    // unsubscribes the user from a calendar that then keeps existing, which is
    // not what "delete my data" means.
    await withRetry(() => api.calendars.delete({ calendarId }));
  } catch (err) {
    const info = describeGoogleError(err);
    // Already gone -- the user deleted it themselves between the list and now.
    // The end state is the one that was asked for, so this is not a failure,
    // but we did not remove anything either.
    if (info.status === 404 || info.status === 410) return false;
    throw err;
  }
  return true;
}
