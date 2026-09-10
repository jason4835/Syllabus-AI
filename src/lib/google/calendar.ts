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
 *    case (a syllabus gets re-parsed, a date gets corrected), not the edge --
 *    and it is a two-way street: a link whose event is no longer in the plan is
 *    deleted from Google, so the calendar converges on the plan instead of
 *    accumulating everything the app has ever believed.
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
import { buildSemesterPlan, resolveTerm } from "@/lib/plan";
import type { KeyedCalendarLink } from "@/lib/store";
import { DEFAULT_CALENDAR_PREFS } from "@/lib/types";
import type {
  Assessment,
  CalendarPrefs,
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
 * Everything about the *user* that planning depends on, read in one go.
 *
 * The zone comes from the user's own browser, so it beats anything the server
 * can infer. The preferences come from the same row, and an explicit
 * `opts.prefs` beats both -- that is how a preview screen asks "what would this
 * sync look like if I turned office hours on?" without saving anything first.
 */
async function resolveSyncContext(
  userId: string,
  opts: SyncOptions,
): Promise<{ timeZone: string; prefs: CalendarPrefs }> {
  const user = await store.getUser(userId);
  return {
    timeZone: user?.timezone ?? serverTimeZone(),
    prefs: opts.prefs ?? user?.calendarPrefs ?? DEFAULT_CALENDAR_PREFS,
  };
}

export interface SyncOptions {
  courses: Course[];
  assessments: Assessment[];
  studyBlocks?: StudyBlock[];
  /**
   * What to put on the calendar. Defaults to the user's stored preferences,
   * and to `DEFAULT_CALENDAR_PREFS` when they have none.
   */
  prefs?: CalendarPrefs;
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
function planEvents(
  opts: SyncOptions,
  timeZone: string,
  prefs: CalendarPrefs,
): CalendarPlan {
  return buildCalendarPlan({
    courses: opts.courses,
    assessments: opts.assessments,
    studyBlocks: opts.studyBlocks ?? [],
    timeZone,
    term: resolveTerm(opts.courses, opts.assessments),
    prefs,
  });
}

/* -------------------------------------------------------------------------- */
/* Reconciliation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The link keys this sync is allowed to delete: everything that could belong to
 * the courses being synced, and nothing else.
 *
 * This scope is the whole safety story of the cleanup pass. "Delete every link
 * that is not in the plan" would be correct only if every sync planned every
 * course -- and syncing one course after editing it does not. Scoped by key
 * shape instead:
 *
 *  - an assessment's own id (its link key IS the id);
 *  - `sb_<assessmentId>_` for the study sessions the planner mints from it,
 *    which exist only in memory and can be found no other way;
 *  - `mt_<courseId>_` for the course's meeting series, whose trailing index
 *    shifts the moment `meetingTimes` is edited -- which is exactly why the old
 *    keys need removing rather than updating.
 *
 * A course absent from `opts.courses` contributes no key and no prefix, so its
 * events cannot be touched by someone else's sync.
 */
function reconciliationScope(opts: SyncOptions): {
  keys: string[];
  keyPrefixes: string[];
} {
  const courseIds = new Set(opts.courses.map((c) => c.id));
  const assessments = opts.assessments.filter((a) => courseIds.has(a.courseId));

  return {
    keys: assessments.map((a) => a.id),
    keyPrefixes: [
      ...assessments.map((a) => `sb_${a.id}_`),
      ...opts.courses.map((c) => `mt_${c.id}_`),
    ],
  };
}

/**
 * Today, as the student's calendar shows it. "In the past" is a question only
 * a zone can answer: on a UTC host, a New York student's Tuesday evening is
 * already Wednesday.
 */
function todayIn(timeZone: string): string {
  try {
    // en-CA formats as YYYY-MM-DD, which is the shape the rest of the app uses.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    // An unusable stored zone must not decide that everything is in the past.
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * The earliest day the semester touches, minus a month of runway -- a clock to
 * plan against for the sessions that have already happened. Null when there is
 * no dated work at all, in which case there is nothing to protect.
 */
function semesterStart(opts: SyncOptions): Date | null {
  const days = [
    ...opts.courses.map((c) => c.startDate),
    ...opts.assessments.map((a) => a.dueDate),
  ].filter((d): d is string => typeof d === "string" && d.length >= 10);
  if (days.length === 0) return null;

  const earliest = days.reduce((a, b) => (a < b ? a : b));
  const ms = Date.parse(`${earliest.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return new Date(ms - 30 * 24 * 60 * 60 * 1000);
}

/**
 * The study sessions the student has already done.
 *
 * `buildStudyBlocks` refuses to schedule a day that has passed, so a session
 * planned in week 2 is simply absent from the plan by week 3 -- and the
 * reconciliation pass below reads "absent from the plan" as "delete it from
 * Google and tell the student it is no longer in their syllabus". Over a
 * semester that quietly erases twenty to forty sessions the student actually
 * sat through, which is not a tidy-up: it is the record of their work.
 *
 * A session's date is nowhere in its key (`sb_<assessmentId>_<n>`) and nowhere
 * in the link row, so it is recovered the only honest way there is -- by
 * running the same planner against a clock set before the semester started,
 * which yields the whole ladder, past sessions included, with their dates.
 * Pure and offline, so a dry run reaches the identical answer with no calls.
 *
 * Two cases deliberately fall through to deletion:
 *  - an assessment that no longer exists contributes no sessions here, so its
 *    orphans are still cleaned up;
 *  - study sessions switched off in preferences are not protected either --
 *    "stop putting these on my calendar" means all of them, not just the ones
 *    still to come.
 */
function pastStudySessionKeys(
  opts: SyncOptions,
  timeZone: string,
  prefs: CalendarPrefs,
): Set<string> {
  const keys = new Set<string>();
  if (!prefs.studySessions) return keys;

  const before = semesterStart(opts);
  if (!before) return keys;

  const today = todayIn(timeZone);
  const asPlannedThen = buildSemesterPlan(opts.courses, opts.assessments, {
    now: before,
    timeZone,
  });
  for (const block of asPlannedThen.studyBlocks) {
    if (block.start.slice(0, 10) < today) keys.add(block.id);
  }
  return keys;
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
 * Pushes assessments, study blocks and class meetings to the user's
 * "Syllabus AI" calendar, and removes the ones that should no longer be there.
 *
 * The sync is a RECONCILIATION, not an append. It used to only ever insert and
 * patch, which meant nothing the app had put on a calendar could ever be taken
 * off it: a multi-section syllabus wrote a weekly series for every section --
 * plus office hours mislabelled "class" -- and choosing the right section
 * afterwards added the right series next to the ten wrong ones, with no way
 * out but deleting them by hand. So the plan is now the whole truth: whatever
 * we have a link for, inside the scope of this sync, and that the plan no
 * longer contains, is deleted from Google and unlinked.
 *
 * Per-event failures are collected in `errors` and never abort the run: one
 * bad date should not cost a student the other twenty deadlines, and one
 * undeletable event should not strand the other nine.
 */
export async function syncToCalendar(
  userId: string,
  opts: SyncOptions,
): Promise<CalendarSyncResult> {
  const dryRun = opts.dryRun === true;
  // Resolved before the dryRun branch so a dry run plans against exactly the
  // zone and preferences a real sync would use.
  const { timeZone, prefs } = await resolveSyncContext(userId, opts);
  const plan = planEvents(opts, timeZone, prefs);

  const result: CalendarSyncResult = {
    created: 0,
    updated: 0,
    skipped: plan.skipped,
    classSeries: 0,
    removed: 0,
    removedItems: [],
    // Straight through from the planner: the UI's prompt to pick a section is
    // driven by the same pass that withheld the meetings.
    needsSection: [...plan.needsSection],
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
            await store.setCalendarLinkForUser(userId, event.key, eventId, result.calendarId);
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
        await store.setCalendarLinkForUser(userId, event.key, eventId, result.calendarId);
      }

      result.created += 1;
      // Counted only after the write succeeded, so a failed series is not
      // reported as "3 class schedules added".
      if (event.recurrence) result.classSeries += 1;
    } catch (err) {
      result.errors.push(`${event.title}: ${describeGoogleError(err).message}`);
    }
  }

  // Computed from the plan and the clock alone -- no network -- so the dry run
  // and the real run protect exactly the same sessions. Lazy because most syncs
  // have no stale session key at all and never need to ask.
  let completed: ReadonlySet<string> | null = null;
  const completedSessions = () =>
    (completed ??= pastStudySessionKeys(opts, timeZone, prefs));

  await removeStaleEvents(userId, opts, plan, dryRun ? null : api, result, completedSessions);

  return result;
}

/**
 * Deletes the events this sync's plan no longer contains.
 *
 * Runs after the writes, over the links belonging to the courses in this sync
 * (see `reconciliationScope`). A link whose key is not among the planned keys
 * describes an event whose reason to exist is gone: a section the student is
 * not in, a meeting the syllabus no longer lists, a category they switched off,
 * an assessment that lost its due date. The one exception is a study session
 * that has already happened (`pastStudySessionKeys`): it is absent from the
 * plan because the day is over, not because its reason to exist is gone.
 * Google first, then the link -- an
 * orphaned link is recoverable (the next sync deletes it) while an orphaned
 * Google event is exactly the bug this exists to fix, and would be unreachable.
 *
 * A dry run walks the identical diff and reports the identical `removed`,
 * without a single network call, so demo mode can honestly say "would remove
 * 10". That is only true because the diff is computed from the plan and the
 * store, and the network is used solely to carry it out.
 */
async function removeStaleEvents(
  userId: string,
  opts: SyncOptions,
  plan: CalendarPlan,
  api: calendar_v3.Calendar | null,
  result: CalendarSyncResult,
  completedSessions: () => ReadonlySet<string>,
): Promise<void> {
  const desired = new Set(plan.events.map((e) => e.key));
  const { keys, keyPrefixes } = reconciliationScope(opts);
  if (keys.length === 0 && keyPrefixes.length === 0) return;

  let links: { key: string; googleEventId: string; calendarId: string }[];
  try {
    links = await store.listCalendarLinks(userId, { keys, keyPrefixes });
  } catch (err) {
    // Never fatal: the events we just wrote are correct either way, and a
    // cleanup that cannot read its own links simply has nothing to do.
    result.errors.push(`Could not list existing calendar links: ${describeGoogleError(err).message}`);
    return;
  }

  /**
   * Turns a stale key back into something a person recognises. "9 removed"
   * gives a student no way to tell a tidy-up from a mistake; a list of titles
   * does. Derived from the key rather than the planner, because the whole
   * point is that these events are no longer in the plan.
   */
  const describe = (key: string): CalendarSyncResult["removedItems"][number] => {
    const assessmentTitle = (id: string) => {
      const a = opts.assessments.find((x) => x.id === id);
      if (!a) return null;
      const code = opts.courses.find((c) => c.id === a.courseId)?.code;
      return {
        title: code ? `${code}: ${a.title}` : a.title,
        start: a.dueDate,
      };
    };

    const session = /^sb_(.+)_\d+$/.exec(key);
    if (session) {
      const found = assessmentTitle(session[1]);
      return { key, title: found ? `Study session — ${found.title}` : "Study session", start: found?.start ?? null };
    }

    const meeting = /^mt_(.+)_\d+$/.exec(key);
    if (meeting) {
      const course = opts.courses.find((c) => c.id === meeting[1]);
      return { key, title: course ? `${course.code} class meetings` : "Class meetings", start: null };
    }

    const found = assessmentTitle(key);
    return { key, title: found?.title ?? key, start: found?.start ?? null };
  };

  for (const link of links) {
    if (desired.has(link.key)) continue;
    // A session the student already sat through is not stale, it is history.
    // The link stays too, so a later sync still knows the event is ours.
    if (link.key.startsWith("sb_") && completedSessions().has(link.key)) continue;

    if (api === null) {
      // Dry run: same diff, no calls.
      result.removed += 1;
      result.removedItems.push(describe(link.key));
      continue;
    }

    try {
      const calendar = api;
      try {
        await withRetry(() =>
          calendar.events.delete({
            calendarId: link.calendarId,
            eventId: link.googleEventId,
          }),
        );
      } catch (err) {
        const info = describeGoogleError(err);
        // 404/410: already gone -- the student deleted it themselves, or a
        // previous run got as far as Google and no further. The end state is
        // the one we wanted, so this counts as removed and the link still goes.
        if (info.status !== 404 && info.status !== 410) throw err;
      }
      await store.deleteCalendarLink(link.key);
      result.removed += 1;
      result.removedItems.push(describe(link.key));
    } catch (err) {
      // The link is deliberately left in place so the next sync retries it.
      result.errors.push(
        `Could not remove a calendar event (${link.key}): ${describeGoogleError(err).message}`,
      );
    }
  }
}

/**
 * The exact event bodies a sync would send, without a Google account.
 *
 * Which zone an event ends up in is otherwise only observable in what Google
 * received, so this is the one seam that makes the timezone behaviour testable.
 * It shares `resolveSyncContext` and `planEvents` with `syncToCalendar`, so it
 * cannot report a payload the real path would not send -- including which
 * meetings the user's preferences and section choice leave out.
 */
export async function planCalendarPayloads(
  userId: string,
  opts: SyncOptions,
): Promise<calendar_v3.Schema$Event[]> {
  const { timeZone, prefs } = await resolveSyncContext(userId, opts);
  const plan = planEvents(opts, timeZone, prefs);
  return plan.events.map(toEventBody);
}

/* -------------------------------------------------------------------------- */
/* Deletion                                                                    */
/* -------------------------------------------------------------------------- */

/** What `deleteCalendarEvents` managed to do, and what it could not. */
export interface CalendarEventRemoval {
  removed: number;
  errors: string[];
}

/**
 * Deletes specific events we created, given the links that named them.
 *
 * This is the other half of `store.deleteCourse`. Deleting a course drops its
 * calendar links, and those rows are the ONLY record of the Google event ids:
 * the sync's cleanup pass is scoped to the courses being synced, so a deleted
 * course contributes no keys and no prefixes and can never reach its own
 * events again. Every deadline, study session and class series it wrote would
 * sit on the student's calendar for the rest of the term, unremovable by
 * anything but hand. Hence: the links come back out of the store, and land
 * here on their way to being forgotten.
 *
 * Best effort by construction. It never throws, and a caller is expected to
 * report the count rather than act on it -- the student asked for the course
 * to go, and a Google outage is not a reason to refuse them. What is lost when
 * Google is down is the cleanup, not the delete.
 *
 * A 404/410 counts as removed, exactly as it does in the reconciliation pass:
 * the event is not there, which is the end state that was asked for.
 */
export async function deleteCalendarEvents(
  userId: string,
  links: readonly KeyedCalendarLink[],
): Promise<CalendarEventRemoval> {
  const result: CalendarEventRemoval = { removed: 0, errors: [] };
  if (links.length === 0) return result;

  let api: calendar_v3.Calendar;
  try {
    const auth = await getAuthedClient(userId);
    api = google.calendar({ version: "v3", auth });
  } catch (err) {
    // No account, no token, no network: nothing to do and nothing to fail.
    result.errors.push(`Calendar unavailable: ${describeGoogleError(err).message}`);
    return result;
  }

  for (const link of links) {
    try {
      await withRetry(() =>
        api.events.delete({
          calendarId: link.calendarId,
          eventId: link.googleEventId,
        }),
      );
      result.removed += 1;
    } catch (err) {
      const info = describeGoogleError(err);
      if (info.status === 404 || info.status === 410) {
        result.removed += 1;
        continue;
      }
      // Collected, never thrown: one undeletable event must not strand the
      // other nine.
      result.errors.push(
        `Could not remove a calendar event (${link.key}): ${info.message}`,
      );
    }
  }

  return result;
}

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
