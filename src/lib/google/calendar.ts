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
 * 4. WHAT goes on the calendar is decided in `@/lib/calendar/events`, not here.
 *    This file is a translator: `CalendarEvent` in, Google's wire format out.
 *    The ICS feed reads the same model, so a downloaded .ics and a synced
 *    calendar cannot disagree about a title, a reminder, or which Monday a
 *    class meets.
 *
 * Class meetings are written as ONE recurring event per meeting pattern rather
 * than as forty-five singles: it is one API call instead of forty-five, it is
 * one row in the user's calendar settings, and cancelling a break is an EXDATE
 * rather than a diff. `classSeries` counts those series.
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
import {
  addDays,
  buildCalendarPlan,
  endOfDayUtc,
  type CalendarEvent,
  type CalendarPlan,
} from "@/lib/calendar/events";
import { resolveTerm } from "@/lib/plan";
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
/* Planning -- delegated to the provider-neutral model                         */
/* -------------------------------------------------------------------------- */

/**
 * Builds the event list this sync intends to write.
 *
 * All the actual planning rules -- what a deadline event is called, how long it
 * runs, which reminders it carries, which class meetings a holiday cancels --
 * live in `@/lib/calendar/events`, so the ICS feed and this file cannot drift.
 * What is left here is Google's wire format, and nothing else.
 *
 * The term window comes from the same `resolveTerm` the semester plan uses, so
 * a class series is anchored to exactly the weeks the workload chart numbers.
 */
function planEvents(opts: SyncOptions, timeZone: string): CalendarPlan {
  return buildCalendarPlan({
    courses: opts.courses,
    assessments: opts.assessments,
    studyBlocks: opts.studyBlocks ?? [],
    timeZone,
    term: resolveTerm(opts.courses, opts.assessments),
  });
}

/* -------------------------------------------------------------------------- */
/* CalendarEvent -> Google                                                     */
/* -------------------------------------------------------------------------- */

/** RFC 5545 day abbreviations, indexed by `Date`'s 0 = Sunday numbering. */
const RRULE_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** `Date` -> "YYYYMMDDTHHMMSSZ", the only UNTIL form Google accepts here. */
function utcStamp(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`
  );
}

/** Local "YYYY-MM-DDTHH:MM" -> "YYYYMMDDTHHMMSS" (no Z: this one is local). */
function localStamp(localDateTime: string): string {
  return `${localDateTime.slice(0, 10).replace(/-/g, "")}T${localDateTime
    .slice(11, 16)
    .replace(":", "")}00`;
}

/**
 * The RRULE/EXDATE lines for a recurring event.
 *
 * Two Google rules that are easy to get wrong and fail quietly:
 *
 *  - When DTSTART carries a TZID, `UNTIL` must be in UTC. A local UNTIL is
 *    rejected outright, and an UNTIL at midnight of the last day drops the
 *    final class -- so it is the last *instant* of that day, converted through
 *    the zone, which is why it moves with DST.
 *  - EXDATE values must match DTSTART's form. Ours is local-with-TZID, so the
 *    exclusions are local-with-the-same-TZID. A `Z`-suffixed EXDATE against a
 *    TZID DTSTART is accepted and then silently excludes nothing, which shows
 *    up as a class meeting on Thanksgiving.
 */
function toRecurrence(event: CalendarEvent): string[] | undefined {
  if (!event.recurrence) return undefined;
  const { byDay, until, exdates } = event.recurrence;

  const days = byDay.map((d) => RRULE_DAYS[d]).join(",");
  const untilStamp = utcStamp(endOfDayUtc(until, event.timeZone));
  const lines = [`RRULE:FREQ=WEEKLY;BYDAY=${days};UNTIL=${untilStamp}`];

  // Omit the line entirely when there is nothing to exclude: an empty EXDATE
  // is a malformed property, not a no-op.
  if (exdates.length > 0) {
    lines.push(
      `EXDATE;TZID=${event.timeZone}:${exdates.map(localStamp).join(",")}`,
    );
  }
  return lines;
}

function toEventBody(event: CalendarEvent): calendar_v3.Schema$Event {
  const body: calendar_v3.Schema$Event = {
    summary: event.title,
    description: event.description,
    start: event.allDay
      ? { date: event.start }
      : // Seconds are re-attached here: Google wants a full RFC 3339 local
        // datetime, the model carries minute precision.
        { dateTime: `${event.start}:00`, timeZone: event.timeZone },
    end: event.allDay
      ? // All-day events use an EXCLUSIVE end date, so a one-day event ends the
        // next morning. A zone on a date-only event is what makes Google shift
        // it into the neighbouring day, so there is none.
        { date: addDays(event.end, 1) ?? event.end }
      : { dateTime: `${event.end}:00`, timeZone: event.timeZone },
    reminders: {
      // The calendar's own defaults would add noise on top of ours.
      useDefault: false,
      overrides: event.reminderMinutes.map((minutes) => ({
        method: "popup",
        minutes,
      })),
    },
  };

  if (event.location) body.location = event.location;
  const recurrence = toRecurrence(event);
  if (recurrence) body.recurrence = recurrence;

  return body;
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
    classSeries: 0,
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

  for (const event of plan.events) {
    try {
      // `event.key` is an assessment id, a study-block id, or `mt_<course>_<n>`.
      // The link table's key column is plain text and has never cared which --
      // a class series is linked, patched and re-created exactly like a
      // deadline, so recurring events inherit the whole idempotency story for
      // free instead of growing a second one.
      const link = await store.getCalendarLink(event.key);

      if (link) {
        let relinked = false;

        if (!dryRun && api) {
          const calendar = api;
          try {
            await withRetry(() =>
              calendar.events.patch({
                calendarId: link.calendarId,
                eventId: link.googleEventId,
                requestBody: toEventBody(event),
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
                requestBody: toEventBody(event),
              }),
            );
            const eventId = inserted.data.id;
            if (!eventId) throw new Error("Google returned no event id on insert.");
            await store.setCalendarLink(event.key, eventId, result.calendarId);
            relinked = true;
          }
        }

        if (relinked) result.created += 1;
        else result.updated += 1;
        if (event.recurrence) result.classSeries += 1;
        continue;
      }

      if (!dryRun && api) {
        const inserted = await withRetry(() =>
          api.events.insert({
            calendarId: result.calendarId,
            requestBody: toEventBody(event),
          }),
        );
        const eventId = inserted.data.id;
        if (!eventId) throw new Error("Google returned no event id on insert.");
        await store.setCalendarLink(event.key, eventId, result.calendarId);
      }

      result.created += 1;
      // Counted only after the write succeeded, so a failed series is not
      // reported as "3 class schedules added".
      if (event.recurrence) result.classSeries += 1;
    } catch (err) {
      result.errors.push(`${event.title}: ${describeGoogleError(err).message}`);
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
