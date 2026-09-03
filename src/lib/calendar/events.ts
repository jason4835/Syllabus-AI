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

import type {
  Assessment,
  CalendarPrefs,
  Course,
  MeetingKind,
  MeetingTime,
  StudyBlock,
} from "@/lib/types";
import { isSitting } from "@/lib/types";

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
  /**
   * What the user wants on their calendar. Required, and deliberately not
   * defaulted here: the planner is the one place that decides what exists, so a
   * caller that forgets to pass prefs must fail to compile rather than quietly
   * sync a category the student switched off. Pass `DEFAULT_CALENDAR_PREFS`
   * when there is no user to ask.
   */
  prefs: CalendarPrefs;
}

/**
 * `buildCalendarEvents` plus the bookkeeping the sync result needs. Kept apart
 * from the event list so the pure model stays a list of events, while callers
 * that report to a user can still say how many items went nowhere and why.
 */
export interface CalendarPlan {
  events: CalendarEvent[];
  /**
   * Items with no placeable date: undated assessments, unanchorable meetings.
   *
   * Deliberately NOT incremented for anything a preference or a section choice
   * filtered out. "Skipped" is shown to the user as work that went nowhere and
   * may need their attention; an office-hours block they asked us not to sync
   * went exactly where they wanted it.
   */
  skipped: number;
  /** Planning-time problems, e.g. a malformed date. Never thrown. */
  errors: string[];
  /**
   * Courses whose syllabus lists several sections while `course.section` is
   * still null. Their section-specific meetings are all withheld -- see
   * `buildMeetingEvents` -- and the UI uses this to ask which one the student
   * is in. Distinct, in the order the courses were given.
   */
  needsSection: string[];
}

/* -------------------------------------------------------------------------- */
/* Constants -- the planning rules, unchanged from the Google-only version      */
/* -------------------------------------------------------------------------- */

/**
 * How long a DEADLINE's timed event runs *before* its due moment.
 *
 * A deadline is a cutoff, so the block reads as "the hour before this is due".
 * A sitting is not a cutoff -- see `DEFAULT_SITTING_MINUTES`.
 */
const TIMED_EVENT_DURATION_MINUTES = 60;

/**
 * How long a sitting runs when the syllabus gives a start but no end.
 *
 * One hour, deliberately conservative. The value is a guess, and the two ways of
 * being wrong are not symmetric: a block that ends too early leaves time free
 * that the student can still see is theirs, while a longer default (two or three
 * hours, the length of a real final) paints over an afternoon that may not be
 * booked at all, and every "when am I free" glance is wrong for the rest of the
 * term. An hour also matches the shortest thing that is plausibly a sitting.
 * The moment the syllabus states a range, `endTime` replaces this outright.
 */
export const DEFAULT_SITTING_MINUTES = 60;

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

/**
 * The stated end of a sitting, when it is one we can actually use: a well-formed
 * "HH:MM" strictly after the start. Anything else -- missing, malformed, or not
 * after the start -- means the syllabus gave no usable range and the default
 * duration applies. One helper so the description can never claim a range the
 * event does not have.
 */
function sittingEndTime(a: Assessment): string | null {
  if (!isSitting(a) || !a.dueTime || !a.endTime) return null;
  if (!ISO_TIME.test(a.dueTime) || !ISO_TIME.test(a.endTime)) return null;
  // Both are zero-padded 24-hour times, so string order is clock order.
  return a.endTime > a.dueTime ? a.endTime : null;
}

interface Clock12 {
  hour: number;
  minute: string;
  meridiem: "AM" | "PM";
}

function parseClock(hhmm: string): Clock12 | null {
  const m = ISO_TIME.exec(hhmm);
  if (!m) return null;
  const h24 = Number(m[1]);
  if (h24 > 23 || Number(m[2]) > 59) return null;
  return {
    hour: h24 % 12 === 0 ? 12 : h24 % 12,
    minute: m[2],
    meridiem: h24 < 12 ? "AM" : "PM",
  };
}

function clockText(c: Clock12): string {
  return `${c.hour}:${c.minute} ${c.meridiem}`;
}

/**
 * The description's one line about when the thing happens.
 *
 * A sitting STARTS at its time ("Starts 12:30 PM", or "12:30-1:50 PM" when the
 * syllabus gave a range); a deadline IS its time ("Due 11:59 PM"). The wording
 * is the difference a student reads at a glance, and it has to agree with the
 * block the same item draws on the grid.
 */
function whenLine(a: Assessment): string | null {
  if (!a.dueTime) return null; // all-day: the date is the whole story
  const start = parseClock(a.dueTime);
  if (!start) return null;
  if (!isSitting(a)) return `Due ${clockText(start)}`;

  const endTime = sittingEndTime(a);
  const end = endTime ? parseClock(endTime) : null;
  if (!end) return `Starts ${clockText(start)}`;
  // Say the meridiem once when both halves share it: "12:30-1:50 PM".
  return end.meridiem === start.meridiem
    ? `${start.hour}:${start.minute}–${clockText(end)}`
    : `${clockText(start)}–${clockText(end)}`;
}

function describeAssessment(a: Assessment, courseTitle: string | null): string {
  const lines: string[] = [];
  lines.push(`Type: ${a.kind}`);
  if (courseTitle) lines.push(`Course: ${courseTitle}`);
  const when = whenLine(a);
  if (when) lines.push(when);
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

function describeMeeting(course: Course, meeting: MeetingTime): string {
  const lines: string[] = [];
  if (course.title) lines.push(course.title);
  // The section label is the answer to "is this the one I am enrolled in?", so
  // it goes in the body of every event that carries one -- a student looking at
  // a Tuesday 10am block should not have to reopen the syllabus to check.
  const section = meeting.section?.trim();
  if (section) lines.push(`Section: ${section}`);
  // The meeting's own instructor wins: office hours are frequently a TA's, and
  // naming the professor there sends the student to the wrong door.
  const instructor = meeting.instructor?.trim() || course.instructor;
  if (instructor) lines.push(`Instructor: ${instructor}`);
  lines.push("", PROVENANCE);
  return lines.join("\n");
}

/** Unknown/missing kinds read as a plain class -- the pre-`kind` default. */
function meetingKind(meeting: MeetingTime): MeetingKind {
  switch (meeting.kind) {
    case "lecture":
    case "recitation":
    case "lab":
    case "office_hours":
    case "other":
      return meeting.kind;
    default:
      return "lecture";
  }
}

/**
 * "MATH 221 class", "MATH 221 lab", "MATH 221 office hours - Prof. X".
 *
 * The word comes from `meeting.kind` and nothing else. It used to be sniffed
 * out of the room string, which is how a professor's office hours ended up on
 * ten students' calendars labelled "class": the location said "office", the
 * sniffer had no pattern for it, and "class" was the fallback. The extractor
 * knows what each meeting is; this only has to say it.
 */
function meetingTitle(course: Course, meeting: MeetingTime): string {
  const kind = meetingKind(meeting);
  let word: string;
  switch (kind) {
    case "recitation":
      word = "recitation";
      break;
    case "lab":
      word = "lab";
      break;
    case "office_hours":
      word = "office hours";
      break;
    case "other":
      word = "meeting";
      break;
    default:
      word = "class";
  }

  const code = course.code.trim();
  let title = code ? `${code} ${word}` : word;

  // Whose office hours, when the syllabus says. A course with three TAs' hours
  // otherwise produces three identically named events.
  if (kind === "office_hours") {
    const who = meeting.instructor?.trim();
    if (who) title += ` · ${who}`;
  }
  return title;
}

/** Does the user want this kind of meeting on their calendar? */
function meetingAllowedByPrefs(kind: MeetingKind, prefs: CalendarPrefs): boolean {
  switch (kind) {
    case "recitation":
    case "lab":
      return prefs.recitations;
    case "office_hours":
      return prefs.officeHours;
    default:
      // "lecture" and "other": anything the extractor could not classify is
      // treated as the main class, because that is the one a student cannot
      // afford to be missing from their calendar.
      return prefs.classes;
  }
}

/**
 * A section label reduced to what two spellings of the same section share:
 * case and surrounding/inner whitespace. "b ", "B" and " b" are one section.
 */
function normalizeSection(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
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

/**
 * Which of a course's meetings belong on THIS student's calendar, paired with
 * their original index in `course.meetingTimes` (the index the idempotency key
 * is built from, so it must survive the filtering).
 *
 * Two independent filters, in this order:
 *
 *  1. **Kind vs preferences.** Office hours are opt-in; recitations and labs
 *     travel together; lectures and unclassified meetings are "classes".
 *
 *  2. **Section gating**, the fix for the bug this module was rewritten for. A
 *     big course's syllabus lists every section, and syncing all of them put
 *     ten weekly series on one student's calendar. The rules:
 *
 *     - Meetings with `section: null` -- office hours, and every meeting of a
 *       single-section course -- are NEVER gated. They apply to everyone.
 *     - One distinct label or none: nothing to choose between, include all.
 *       (Also the safe answer when a stale `course.section` names a section the
 *       syllabus no longer lists: the student still gets the one real series.)
 *     - Several labels and `course.section` chosen: only that section's
 *       meetings. Matched exactly first, then case- and whitespace-insensitively,
 *       so "b " off a form still finds "B".
 *     - Several labels and no choice yet: NOTHING section-specific, and the
 *       course is reported in `needsSection`. Guessing would put the student in
 *       someone else's classroom at someone else's hour, and an empty calendar
 *       asks a question a wrong calendar does not.
 */
function selectMeetings(
  course: Course,
  prefs: CalendarPrefs,
  plan: CalendarPlan,
): { meeting: MeetingTime; index: number }[] {
  const all = course.meetingTimes ?? [];

  const byPrefs = all
    .map((meeting, index) => ({ meeting, index }))
    .filter(({ meeting }) => meetingAllowedByPrefs(meetingKind(meeting), prefs));

  // Labels are counted across EVERY meeting of the course, not just the ones
  // preferences left standing: whether a syllabus lists several sections is a
  // fact about the syllabus, and `needsSection` must not flicker when a student
  // toggles office hours.
  const labels = new Set<string>();
  for (const m of all) {
    const label = m.section?.trim();
    if (label) labels.add(normalizeSection(label));
  }
  if (labels.size <= 1) return byPrefs;

  const chosen = course.section?.trim();
  if (!chosen) {
    // Several sections, none chosen. Withhold the section-specific ones and say
    // so; anything unsectioned still syncs.
    if (!plan.needsSection.includes(course.id)) plan.needsSection.push(course.id);
    return byPrefs.filter(({ meeting }) => !meeting.section?.trim());
  }

  const chosenNormalized = normalizeSection(chosen);
  return byPrefs.filter(({ meeting }) => {
    const label = meeting.section?.trim();
    if (!label) return true; // applies to every section
    if (meeting.section === course.section || label === chosen) return true;
    return normalizeSection(label) === chosenNormalized;
  });
}

function buildMeetingEvents(
  course: Course,
  term: { start: string; end: string } | null,
  timeZone: string,
  prefs: CalendarPrefs,
  plan: CalendarPlan,
): void {
  const meetings = selectMeetings(course, prefs, plan);
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

  meetings.forEach(({ meeting, index }) => {
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
      // `index` is the meeting's position in the UNFILTERED `course.meetingTimes`,
      // so a key means the same thing whether or not preferences and the section
      // choice let this meeting through on a given sync. It shifts when the
      // array itself is edited -- the sync's reconciliation pass is what removes
      // the events the old keys pointed at.
      key: `mt_${course.id}_${index}`,
      kind: "meeting",
      title: meetingTitle(course, meeting),
      description: describeMeeting(course, meeting),
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
 *
 * `input.prefs` and the per-course section choice are applied HERE and nowhere
 * else: a category the student switched off, or a section they are not in,
 * simply produces no event, so every consumer -- Google, the feed, the dry-run
 * counts, and the sync's own "what should no longer exist" diff -- agrees by
 * construction rather than by each remembering to filter.
 */
export function buildCalendarPlan(input: BuildInput): CalendarPlan {
  const plan: CalendarPlan = { events: [], skipped: 0, errors: [], needsSection: [] };
  const { timeZone, prefs } = input;
  const coursesById = new Map(input.courses.map((c) => [c.id, c]));

  for (const a of prefs.deadlines ? input.assessments : []) {
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
      const timeMs = toEpochScaffold(a.dueDate, a.dueTime);
      if (timeMs === null) {
        plan.errors.push(`${a.title}: unparseable due date/time (${a.dueDate} ${a.dueTime})`);
        plan.skipped += 1;
        continue;
      }

      // The two kinds of timed item are drawn in opposite directions, and this
      // is the whole reason `isSitting` exists. An exam at 12:30 HAPPENS at
      // 12:30; drawing it as the hour ending then -- the deadline rule, applied
      // to everything -- put a student's 12:30-1:50 exam on the calendar as
      // 11:30-12:30, an hour before the room even opened.
      let startMs: number;
      let endMs: number;
      if (isSitting(a)) {
        startMs = timeMs;
        const endTime = sittingEndTime(a);
        const statedEndMs = endTime ? toEpochScaffold(a.dueDate, endTime) : null;
        // No stated end (or one we could not use) means the syllabus never said
        // how long it runs, so the conservative default stands in.
        endMs = statedEndMs ?? timeMs + DEFAULT_SITTING_MINUTES * 60 * 1000;
      } else {
        // A deadline's event *ends* at the due moment, so it reads as "the hour
        // before this is due" rather than starting when it is already too late.
        endMs = timeMs;
        startMs = timeMs - TIMED_EVENT_DURATION_MINUTES * 60 * 1000;
      }

      plan.events.push({
        key: a.id,
        kind: "assessment",
        title,
        description,
        location: null,
        allDay: false,
        start: formatLocalDateTime(startMs),
        end: formatLocalDateTime(endMs),
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

  for (const b of prefs.studySessions ? input.studyBlocks : []) {
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
    buildMeetingEvents(course, input.term, timeZone, prefs, plan);
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
