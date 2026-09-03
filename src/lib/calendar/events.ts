/**
 * Provider-neutral calendar model.
 *
 * Google Calendar and the ICS feed used to plan their events separately, which
 * meant two answers to every question that matters -- what an event is called,
 * which reminders it carries, whether a class meeting on Thanksgiving is on the
 * calendar. This module is the single answer. Both providers consume
 * `CalendarEvent` and do nothing but translate it into their own wire format.
 *
 * Everything here is PURE: no store, no network, no `new Date()` except inside
 * `toUtc`'s zone probing. That is what lets a dry run report exactly the counts
 * a real sync would produce, and what makes the DST behaviour testable.
 *
 * Two conventions run through the file:
 *
 *  - Datetimes are *floating local* (`YYYY-MM-DDTHH:MM`) paired with an IANA
 *    `timeZone`. A student's 23:59 deadline is 23:59 where they are, and the
 *    zone -- not the host's clock -- says what instant that is.
 *  - Recurrence is described, never expanded, until a provider asks for it.
 *    Google wants an RRULE; ICS wants concrete occurrences. `expandOccurrences`
 *    is the bridge, and it is the same walk for both, so the two providers
 *    cannot disagree about which Mondays a class meets.
 */

import type { Assessment, Course, MeetingTime, StudyBlock } from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* Model                                                                       */
/* -------------------------------------------------------------------------- */

export type CalendarEventKind = "assessment" | "study" | "meeting";

/** Weekly recurrence. The only shape a class schedule ever needs. */
export interface EventRecurrence {
  /** 0 = Sunday .. 6 = Saturday, ascending, deduplicated. */
  byDay: number[];
  /** Last date the series may occur on, INCLUSIVE (YYYY-MM-DD). */
  until: string;
  /** Occurrences that do not happen, as local `YYYY-MM-DDTHH:MM`. */
  exdates: string[];
}

export interface CalendarEvent {
  /**
   * Idempotency key: assessment id, study-block id, or `mt_<courseId>_<index>`.
   * The one thing about an event that must survive a re-parse -- titles, dates
   * and reminders can all change between syncs, this cannot, because it is what
   * the calendar-link table joins on.
   */
  key: string;
  kind: CalendarEventKind;
  title: string;
  description: string;
  location: string | null;
  allDay: boolean;
  /** `YYYY-MM-DD` when `allDay`, else floating local `YYYY-MM-DDTHH:MM`. */
  start: string;
  /** Same shape as `start`. For all-day events this is the INCLUSIVE last day. */
  end: string;
  /** IANA zone the local datetimes are anchored to. */
  timeZone: string;
  recurrence: EventRecurrence | null;
  /** Minutes-before values for popup reminders. Empty means none. */
  reminderMinutes: number[];
}

export interface BuildInput {
  courses: Course[];
  assessments: Assessment[];
  studyBlocks: StudyBlock[];
  timeZone: string;
  /** Resolved term window. Null means class meetings have nothing to anchor to. */
  term: { start: string; end: string } | null;
}

/**
 * `buildCalendarEvents` plus the bookkeeping the sync result needs. Kept apart
 * from the event list so the pure model stays a list of events, while callers
 * that report to a user can still say how many items went nowhere and why.
 */
export interface CalendarPlan {
  events: CalendarEvent[];
  /** Items with no placeable date: undated assessments, unanchorable meetings. */
  skipped: number;
  /** Planning-time problems, e.g. a malformed date. Never thrown. */
  errors: string[];
}

/* -------------------------------------------------------------------------- */
/* Constants -- the planning rules, unchanged from the Google-only version      */
/* -------------------------------------------------------------------------- */

/** How long an assessment's timed event runs *before* its due moment. */
const TIMED_EVENT_DURATION_MINUTES = 60;

const REMINDER_ONE_DAY = 24 * 60;
const REMINDER_ONE_WEEK = 7 * 24 * 60;
const REMINDER_STUDY_BLOCK = 30;

const PROVENANCE = "Created by Syllabus AI";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIME = /^(\d{2}):(\d{2})$/;
const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

const DAY_MS = 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Date arithmetic -- UTC used purely as scaffolding, never as a zone           */
/* -------------------------------------------------------------------------- */

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * "YYYY-MM-DD" (+ optional "HH:MM") as UTC-epoch milliseconds.
 *
 * The components are treated as UTC purely as arithmetic scaffolding: it lets
 * us add and subtract days and hours without a DST-aware library, and the value
 * is always formatted straight back into a floating local string, so no
 * timezone is ever actually applied. Use `toUtc` when a real instant is wanted.
 */
function toEpochScaffold(date: string, time = "00:00"): number | null {
  const d = ISO_DATE.exec(date);
  const t = ISO_TIME.exec(time);
  if (!d || !t) return null;
  const ms = Date.UTC(
    Number(d[1]),
    Number(d[2]) - 1,
    Number(d[3]),
    Number(t[1]),
    Number(t[2]),
  );
  // Date.UTC happily normalises 2026-02-31 into March. Reject instead: a
  // syllabus date that does not exist is a parse bug, not a March deadline.
  return Number.isNaN(ms) ? null : ms;
}

/** Scaffold milliseconds back to a floating local "YYYY-MM-DDTHH:MM". */
function formatLocalDateTime(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
  );
}

/** Scaffold milliseconds back to a "YYYY-MM-DD". */
function formatLocalDate(ms: number): string {
  return formatLocalDateTime(ms).slice(0, 10);
}

/** `date` shifted by whole days, as "YYYY-MM-DD". Null on an unparseable date. */
export function addDays(date: string, days: number): string | null {
  const ms = toEpochScaffold(date);
  if (ms === null) return null;
  return formatLocalDate(ms + days * DAY_MS);
}

/** 0 = Sunday .. 6 = Saturday for a "YYYY-MM-DD". Null when unparseable. */
export function dayOfWeek(date: string): number | null {
  const ms = toEpochScaffold(date);
  if (ms === null) return null;
  return new Date(ms).getUTCDay();
}

/** The date half of a local datetime (or of a date). */
function datePart(value: string): string {
  return value.slice(0, 10);
}

/** The "HH:MM" half of a local datetime, or null when there is none. */
function timePart(value: string): string | null {
  const m = LOCAL_DATETIME.exec(value);
  return m ? `${m[4]}:${m[5]}` : null;
}

/** Normalises a planner datetime ("...T14:00:00") to the model's "...T14:00". */
function normalizeLocalDateTime(value: string): string | null {
  const m = LOCAL_DATETIME.exec(value);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
}

/* -------------------------------------------------------------------------- */
/* toUtc -- the one place a real timezone is applied                            */
/* -------------------------------------------------------------------------- */

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

function offsetFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = offsetFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    offsetFormatters.set(timeZone, fmt);
  }
  return fmt;
}

/**
 * The zone's UTC offset in milliseconds at a given instant.
 *
 * Read by formatting the instant in the zone and re-reading the wall clock as
 * if it were UTC: the difference between the two is the offset. This is the
 * portable way to ask Intl a question it has no direct API for, and it is exact
 * for every zone the runtime knows, including half-hour and 45-minute ones.
 */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const parts = offsetFormatter(timeZone).formatToParts(new Date(instantMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  // Some engines still render midnight as hour 24 under h23; fold it back.
  const hour = get("hour") % 24;
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second"),
  );
  return asUtc - instantMs;
}

/**
 * A floating local datetime + an IANA zone -> the instant it names.
 *
 * Correct across DST because the offset is probed twice: once with the naive
 * guess, and again at the instant that guess implies. Only the second probe is
 * right on the days the offset itself changes -- on 2026-11-01 in New York,
 * a 10:00 local time probed as if UTC lands before the fall-back and reports
 * -04:00, while the instant it implies is already -05:00.
 *
 * Times inside a spring-forward gap do not exist; they resolve to the instant
 * one hour later, which is what every calendar client does with them.
 */
export function toUtc(localDateTime: string, timeZone: string): Date {
  const m = LOCAL_DATETIME.exec(localDateTime);
  if (!m) throw new Error(`toUtc: not a local datetime: "${localDateTime}"`);
  const naive = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
  );

  const firstOffset = zoneOffsetMs(naive, timeZone);
  const firstGuess = naive - firstOffset;
  const secondOffset = zoneOffsetMs(firstGuess, timeZone);
  if (secondOffset === firstOffset) return new Date(firstGuess);

  // The offset changed between the guess and the instant it implies, so we are
  // on a transition day. The refined guess is right *if* it round-trips back to
  // the wall clock we were given.
  const secondGuess = naive - secondOffset;
  if (zoneOffsetMs(secondGuess, timeZone) === secondOffset) return new Date(secondGuess);

  // It does not, which means the wall clock never happens: 02:30 on a
  // spring-forward morning is skipped by the zone itself. Shift forward past
  // the gap (02:30 -> 03:30) rather than backward, matching what Temporal's
  // "compatible" disambiguation and every calendar client do with it -- a
  // meeting nudged later still happens, one nudged earlier can be missed.
  return new Date(firstGuess);
}

/**
 * The last instant of a local day in a zone (23:59:59), used for RRULE `UNTIL`.
 *
 * `UNTIL` is inclusive, so it has to land *after* the last occurrence's start
 * on the final day -- naming midnight of that day would drop the last class.
 */
export function endOfDayUtc(date: string, timeZone: string): Date {
  return new Date(toUtc(`${date}T23:59`, timeZone).getTime() + 59_000);
}

/* -------------------------------------------------------------------------- */
/* Descriptions                                                                */
/* -------------------------------------------------------------------------- */

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
  lines.push("", PROVENANCE);
  return lines.join("\n");
}

function describeStudyBlock(b: StudyBlock): string {
  return ["Study session", "", b.rationale, "", PROVENANCE].join("\n");
}

function describeMeeting(course: Course): string {
  const lines: string[] = [];
  if (course.title) lines.push(course.title);
  if (course.instructor) lines.push(`Instructor: ${course.instructor}`);
  lines.push("", PROVENANCE);
  return lines.join("\n");
}

/**
 * "MATH 221 class", or lab/recitation when the room says so.
 *
 * Deliberately conservative: a syllabus that does not distinguish its sections
 * gets the honest generic word rather than a guess a student would have to
 * correct on every one of forty-five occurrences.
 */
function meetingTitle(course: Course, meeting: MeetingTime): string {
  const haystack = (meeting.location ?? "").toLowerCase();
  let word = "class";
  if (/\blabs?\b|\blaboratory\b/.test(haystack)) word = "lab";
  else if (/\brecitation\b|\brecit\b|\bdiscussion\b/.test(haystack)) word = "recitation";
  const code = course.code.trim();
  return code ? `${code} ${word}` : word;
}

/* -------------------------------------------------------------------------- */
/* Building                                                                    */
/* -------------------------------------------------------------------------- */

/** 0..6, ascending, deduplicated. Anything else is not a day of the week. */
function normalizeDays(days: number[]): number[] {
  const seen = new Set<number>();
  for (const d of days) {
    if (Number.isInteger(d) && d >= 0 && d <= 6) seen.add(d);
  }
  return [...seen].sort((a, b) => a - b);
}

/** Is `date` inside any of the course's no-class ranges? Inclusive both ends. */
function inNoClassPeriod(date: string, course: Course): boolean {
  for (const p of course.noClass ?? []) {
    if (!ISO_DATE.test(p.start) || !ISO_DATE.test(p.end)) continue;
    // Lexicographic comparison is exact for zero-padded ISO dates.
    const from = p.start <= p.end ? p.start : p.end;
    const to = p.start <= p.end ? p.end : p.start;
    if (date >= from && date <= to) return true;
  }
  return false;
}

function buildMeetingEvents(
  course: Course,
  term: { start: string; end: string } | null,
  timeZone: string,
  plan: CalendarPlan,
): void {
  const meetings = course.meetingTimes ?? [];
  if (meetings.length === 0) return;

  if (term === null) {
    // Nothing to anchor a weekly series to. Reported rather than guessed: a
    // series pinned to the wrong week is worse than no series at all.
    plan.skipped += meetings.length;
    return;
  }
  if (!ISO_DATE.test(term.start) || !ISO_DATE.test(term.end) || term.end < term.start) {
    plan.errors.push(`${course.code}: unusable term window (${term.start} to ${term.end})`);
    plan.skipped += meetings.length;
    return;
  }

  meetings.forEach((meeting, index) => {
    const days = normalizeDays(meeting.daysOfWeek ?? []);
    if (days.length === 0 || !ISO_TIME.test(meeting.startTime) || !ISO_TIME.test(meeting.endTime)) {
      plan.errors.push(
        `${course.code}: unusable meeting pattern (${meeting.startTime}-${meeting.endTime})`,
      );
      plan.skipped += 1;
      return;
    }

    // Walk forward from the first day of term to the first day the class
    // actually meets. At most seven steps, and exact -- no modular arithmetic
    // to get wrong at a year boundary.
    let first: string | null = null;
    for (let d: string | null = term.start; d !== null && d <= term.end; d = addDays(d, 1)) {
      const dow = dayOfWeek(d);
      if (dow !== null && days.includes(dow)) {
        first = d;
        break;
      }
    }
    if (first === null) {
      plan.errors.push(`${course.code}: no meeting day falls inside the term`);
      plan.skipped += 1;
      return;
    }

    // Every occurrence that lands in a break. Walked day by day across the
    // whole term rather than intersected cleverly: the clever version is where
    // an off-by-one silently deletes a week of class.
    const exdates: string[] = [];
    for (let d: string | null = first; d !== null && d <= term.end; d = addDays(d, 1)) {
      const dow = dayOfWeek(d);
      if (dow === null || !days.includes(dow)) continue;
      if (inNoClassPeriod(d, course)) exdates.push(`${d}T${meeting.startTime}`);
    }

    plan.events.push({
      key: `mt_${course.id}_${index}`,
      kind: "meeting",
      title: meetingTitle(course, meeting),
      description: describeMeeting(course),
      location: meeting.location,
      allDay: false,
      start: `${first}T${meeting.startTime}`,
      end: `${first}T${meeting.endTime}`,
      timeZone,
      recurrence: { byDay: days, until: term.end, exdates },
      // No reminders on a class the student is already walking to. Forty-five
      // popups a semester is how a calendar gets muted.
      reminderMinutes: [],
    });
  });
}

/**
 * Courses + assessments + study blocks -> the exact set of events we intend to
 * have on a calendar, with the bookkeeping a sync result needs.
 *
 * Pure. Both the Google path and the ICS feed call this, so a dry run, a real
 * sync and a downloaded .ics can never disagree about what is on the calendar.
 */
export function buildCalendarPlan(input: BuildInput): CalendarPlan {
  const plan: CalendarPlan = { events: [], skipped: 0, errors: [] };
  const { timeZone } = input;
  const coursesById = new Map(input.courses.map((c) => [c.id, c]));

  for (const a of input.assessments) {
    const course = coursesById.get(a.courseId) ?? null;
    // Fall back to the bare title rather than printing a placeholder code: an
    // orphaned assessment is still more useful on the calendar than not.
    const title = course ? `${course.code}: ${a.title}` : a.title;
    const description = describeAssessment(a, course ? course.title : null);

    if (a.dueDate === null) {
      // Nothing to schedule against. The UI surfaces these for manual dating.
      plan.skipped += 1;
      continue;
    }

    // Exams get a second, week-out nudge -- that is the one deadline where a
    // 24-hour warning is already too late to act on.
    const reminderMinutes =
      a.kind === "exam" ? [REMINDER_ONE_WEEK, REMINDER_ONE_DAY] : [REMINDER_ONE_DAY];

    if (a.dueTime) {
      const dueMs = toEpochScaffold(a.dueDate, a.dueTime);
      if (dueMs === null) {
        plan.errors.push(`${a.title}: unparseable due date/time (${a.dueDate} ${a.dueTime})`);
        plan.skipped += 1;
        continue;
      }
      // The event *ends* at the due moment, so it reads as "the hour before
      // this is due" on the calendar rather than starting when it is too late.
      const startMs = dueMs - TIMED_EVENT_DURATION_MINUTES * 60 * 1000;
      plan.events.push({
        key: a.id,
        kind: "assessment",
        title,
        description,
        location: null,
        allDay: false,
        start: formatLocalDateTime(startMs),
        end: formatLocalDateTime(dueMs),
        timeZone,
        recurrence: null,
        reminderMinutes,
      });
      continue;
    }

    if (!ISO_DATE.test(a.dueDate) || toEpochScaffold(a.dueDate) === null) {
      plan.errors.push(`${a.title}: unparseable due date (${a.dueDate})`);
      plan.skipped += 1;
      continue;
    }
    // All-day. `start`/`end` are both the due date: the model carries the
    // INCLUSIVE last day, and each provider applies its own end convention.
    plan.events.push({
      key: a.id,
      kind: "assessment",
      title,
      description,
      location: null,
      allDay: true,
      start: a.dueDate,
      end: a.dueDate,
      timeZone,
      recurrence: null,
      reminderMinutes,
    });
  }

  for (const b of input.studyBlocks) {
    const course = coursesById.get(b.courseId) ?? null;
    const start = normalizeLocalDateTime(b.start);
    const end = normalizeLocalDateTime(b.end);
    const title = course ? `Study: ${course.code}: ${b.title}` : `Study: ${b.title}`;
    if (start === null || end === null) {
      plan.errors.push(`${b.title}: unparseable study block window (${b.start} to ${b.end})`);
      plan.skipped += 1;
      continue;
    }
    plan.events.push({
      key: b.id,
      kind: "study",
      title,
      description: describeStudyBlock(b),
      location: null,
      allDay: false,
      start,
      end,
      timeZone,
      recurrence: null,
      reminderMinutes: [REMINDER_STUDY_BLOCK],
    });
  }

  for (const course of input.courses) {
    buildMeetingEvents(course, input.term, timeZone, plan);
  }

  return plan;
}

/** The event list on its own -- the shape both providers actually consume. */
export function buildCalendarEvents(input: BuildInput): CalendarEvent[] {
  return buildCalendarPlan(input).events;
}

/* -------------------------------------------------------------------------- */
/* Expansion                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A recurring event -> the concrete single events it stands for.
 *
 * Walks day by day from the first occurrence through `until`, emitting every
 * matching weekday that is not excluded. Deliberately literal: a term is a few
 * hundred iterations, and the arithmetic-shortcut version of this is where a
 * class silently vanishes for a week.
 *
 * Each occurrence gets `key` = `<key>_<date>` so that downstream UIDs are
 * unique and stable, and `recurrence: null` so an expanded event cannot be
 * expanded twice. Non-recurring events pass through unchanged.
 *
 * `window` (inclusive `YYYY-MM-DD` bounds) filters by occurrence start date.
 */
export function expandOccurrences(
  event: CalendarEvent,
  window?: { from: string; to: string },
): CalendarEvent[] {
  const inWindow = (date: string): boolean =>
    !window || (date >= window.from && date <= window.to);

  if (event.recurrence === null) {
    return inWindow(datePart(event.start)) ? [event] : [];
  }

  const { byDay, until, exdates } = event.recurrence;
  const days = normalizeDays(byDay);
  const excluded = new Set(exdates);
  const startDate = datePart(event.start);
  const startTime = timePart(event.start);
  const endTime = timePart(event.end);

  // How many days the event spans, so an occurrence that runs past midnight
  // keeps its shape. Zero for every real class meeting.
  const startMs = toEpochScaffold(startDate);
  const endMs = toEpochScaffold(datePart(event.end));
  const spanDays =
    startMs !== null && endMs !== null ? Math.round((endMs - startMs) / DAY_MS) : 0;

  const out: CalendarEvent[] = [];
  if (days.length === 0) return out;

  for (let d: string | null = startDate; d !== null && d <= until; d = addDays(d, 1)) {
    const dow = dayOfWeek(d);
    if (dow === null || !days.includes(dow)) continue;

    const occurrenceStart = event.allDay || startTime === null ? d : `${d}T${startTime}`;
    if (excluded.has(occurrenceStart) || excluded.has(d)) continue;
    if (!inWindow(d)) continue;

    const endDate = addDays(d, spanDays) ?? d;
    const occurrenceEnd = event.allDay || endTime === null ? endDate : `${endDate}T${endTime}`;

    out.push({
      ...event,
      key: `${event.key}_${d}`,
      start: occurrenceStart,
      end: occurrenceEnd,
      recurrence: null,
    });
  }

  return out;
}

/** Every event, with recurring ones replaced by their occurrences. */
export function expandAll(
  events: CalendarEvent[],
  window?: { from: string; to: string },
): CalendarEvent[] {
  return events.flatMap((e) => expandOccurrences(e, window));
}
