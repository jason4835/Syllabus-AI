/**
 * Study-block scheduler.
 *
 * Two ideas do most of the work here:
 *
 * 1. **Back-scheduling.** Work is placed by counting backwards from the due
 *    date, not forwards from today. A deadline is the fixed point; the prep is
 *    what moves.
 * 2. **Spacing.** Exams get several short sessions on a widening ladder
 *    (roughly D-10 / D-6 / D-3 / D-1) instead of one block the night before.
 *    Spaced retrieval is the single best-supported finding in the study-skills
 *    literature, and it is also the thing students reliably fail to do on their
 *    own -- so it is exactly what a planner should be for.
 *
 * The scheduler then refuses to lie about the calendar: it will not put a block
 * on top of a class, outside waking study hours, past the daily cap, or in the
 * past. When a day is full it moves the block to a real free day and *says so*
 * in the rationale rather than quietly double-booking.
 *
 * Pure apart from the injectable `now`.
 */

import type {
  Assessment,
  AssessmentKind,
  Course,
  MeetingTime,
  StudyBlock,
  WeekLoad,
} from "@/lib/types";
import {
  addDays,
  dayOfWeek,
  daysBetween,
  estimatedHoursFor,
  formatShortDate,
  minutesOfDay,
  mondayOf,
  parseISODate,
  toISODate,
} from "@/lib/plan/workload";

export interface StudyOptions {
  /** Injected so the scheduler is testable. Defaults to `new Date()`. */
  now?: Date;
  /** Earliest hour a block may start. Nobody studies well at 6am on a plan. */
  dayStartHour?: number;
  /** Latest hour a block may end. */
  dayEndHour?: number;
  /** Hard ceiling on scheduled study hours in any one day. */
  maxHoursPerDay?: number;
  /** Blocks shorter than this are not worth the context switch. */
  minBlockHours?: number;
  /** Attention falls off a cliff past this; longer work is split. */
  maxBlockHours?: number;
}

export const DEFAULT_STUDY_OPTIONS = {
  dayStartHour: 9,
  dayEndHour: 21,
  maxHoursPerDay: 4,
  minBlockHours: 0.5,
  maxBlockHours: 2.5,
} as const;

/** Blocks are preferentially placed after this hour -- mornings are class time. */
const PREFERRED_EARLIEST_HOUR = 13;
/** How far earlier we will hunt for a free day before giving up. */
const EARLY_SEARCH_DAYS = 4;
/** ...extended when the ideal day sits inside a crunch week, to drain load out of it. */
const EARLY_SEARCH_DAYS_CRUNCH = 7;
/** How far *later* we will slide a block when everything earlier is in the past. */
const LATE_SEARCH_DAYS = 3;

/* -------------------------------------------------------------------------- */
/* Session ladders                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Days-before-due for each session, by kind.
 *
 * Ladders widen as the item gets heavier: a 6h exam fits in the canonical
 * four-session ladder, a 13h final does not, so it earns a longer runway rather
 * than four impossible 3.5h blocks.
 */
const EXAM_LADDERS: number[][] = [
  [10, 6, 3, 1], // the canonical spaced-repetition ladder
  [14, 10, 7, 5, 3, 1],
  [18, 14, 11, 8, 6, 4, 2, 1],
];
const PROJECT_LADDERS: number[][] = [
  [10, 5, 2],
  [14, 9, 5, 2],
  [21, 16, 12, 8, 5, 2],
];
const PRESENTATION_LADDERS: number[][] = [
  [7, 3, 1],
  [10, 7, 4, 1],
];
const SMALL_LADDERS: number[][] = [[2], [5, 2], [8, 5, 2]];
const QUIZ_LADDERS: number[][] = [[2], [4, 1]];
const READING_LADDERS: number[][] = [[1], [3, 1]];

function laddersFor(kind: AssessmentKind): number[][] {
  switch (kind) {
    case "exam":
      return EXAM_LADDERS;
    case "project":
      return PROJECT_LADDERS;
    case "presentation":
      return PRESENTATION_LADDERS;
    case "quiz":
      return QUIZ_LADDERS;
    case "reading":
      return READING_LADDERS;
    default:
      return SMALL_LADDERS;
  }
}

/** Smallest ladder that can carry `totalHours` without exceeding `maxBlock`. */
function chooseLadder(kind: AssessmentKind, totalHours: number, maxBlock: number): number[] {
  const ladders = laddersFor(kind);
  for (const l of ladders) {
    if (l.length * maxBlock >= totalHours) return l;
  }
  return ladders[ladders.length - 1];
}

/**
 * Effort distribution across a ladder.
 *
 * Ramps up as the deadline nears -- early sessions are orientation, later ones
 * are real work. The final session is deliberately *lighter* for exams: the
 * night before should be a confidence pass, not the heaviest lift of the week.
 * Projects invert that, because a project genuinely does end in a push.
 */
function sessionWeights(n: number, lighterFinish: boolean): number[] {
  if (n <= 1) return [1];
  const raw = Array.from({ length: n }, (_, i) => 1 + 0.5 * (i / (n - 1)));
  if (lighterFinish) raw[n - 1] *= 0.75;
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((w) => w / sum);
}

/* -------------------------------------------------------------------------- */
/* Calendar bookkeeping                                                        */
/* -------------------------------------------------------------------------- */

interface Interval {
  start: number; // minutes since local midnight
  end: number;
}

function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.slice().sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ ...iv });
  }
  return out;
}

/**
 * Class time, keyed by weekday, merged across *all* the student's courses --
 * they cannot be in a MATH lecture and a CS lab at once, so every course's
 * meetings block every course's study time.
 */
function classBusyByWeekday(courses: Course[]): Map<number, Interval[]> {
  const byDay = new Map<number, Interval[]>();
  const push = (day: number, m: MeetingTime) => {
    const start = minutesOfDay(m.startTime);
    const end = minutesOfDay(m.endTime);
    if (start === null || end === null || end <= start) return;
    const list = byDay.get(day) ?? [];
    list.push({ start, end });
    byDay.set(day, list);
  };
  for (const c of courses) {
    for (const m of c.meetingTimes ?? []) {
      for (const day of m.daysOfWeek ?? []) push(day, m);
    }
  }
  for (const [day, list] of byDay) byDay.set(day, mergeIntervals(list));
  return byDay;
}

type PlacementFailure = "past" | "cap" | "no-slot";
type Placement =
  | { ok: true; startMin: number; endMin: number; hours: number }
  | { ok: false; reason: PlacementFailure };

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function toLocalDateTime(dayIso: string, minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${dayIso}T${pad2(h)}:${pad2(m)}:00`;
}

function localISODate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const ORDINALS = [
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
];
function ordinal(i: number): string {
  return ORDINALS[i] ?? `${i + 1}th`;
}
const COUNT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"];
function countWord(n: number): string {
  return COUNT_WORDS[n] ?? String(n);
}

function roundQuarter(h: number): number {
  return Math.round(h * 4) / 4;
}

/* -------------------------------------------------------------------------- */
/* The scheduler                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Build recommended study blocks for every dated assessment.
 *
 * `weeks` is not decoration: when a session's ideal day falls inside a crunch
 * week the scheduler widens its earlier-day search, which pulls prep *out* of
 * the week that is already over budget instead of piling onto it.
 *
 * Assessments are scheduled in due-date order so the nearest deadline gets
 * first claim on scarce days -- the alternative (whoever is first in the array
 * wins) makes the output depend on database ordering, which is not a plan.
 */
export function buildStudyBlocks(
  courses: Course[],
  assessments: Assessment[],
  weeks: WeekLoad[],
  opts: StudyOptions = {},
): StudyBlock[] {
  const now = opts.now ?? new Date();
  const dayStart = (opts.dayStartHour ?? DEFAULT_STUDY_OPTIONS.dayStartHour) * 60;
  const dayEnd = (opts.dayEndHour ?? DEFAULT_STUDY_OPTIONS.dayEndHour) * 60;
  const maxPerDay = opts.maxHoursPerDay ?? DEFAULT_STUDY_OPTIONS.maxHoursPerDay;
  const minBlock = opts.minBlockHours ?? DEFAULT_STUDY_OPTIONS.minBlockHours;
  const maxBlock = opts.maxBlockHours ?? DEFAULT_STUDY_OPTIONS.maxBlockHours;

  const todayIso = localISODate(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  const courseById = new Map(courses.map((c) => [c.id, c]));
  const classBusy = classBusyByWeekday(courses);
  const intensityByWeek = new Map(weeks.map((w) => [w.weekStart, w.intensity]));

  // Mutable calendar state, shared across every assessment.
  const bookedByDay = new Map<string, Interval[]>();
  const hoursByDay = new Map<string, number>();

  function place(dayIso: string, desiredHours: number): Placement {
    if (dayIso < todayIso) return { ok: false, reason: "past" };

    const used = hoursByDay.get(dayIso) ?? 0;
    const remainingBudget = maxPerDay - used;
    if (remainingBudget < minBlock) return { ok: false, reason: "cap" };

    let hours = Math.min(desiredHours, remainingBudget, maxBlock);

    // Earliest legal start: the study window, and on today also the clock.
    let earliest = dayStart;
    if (dayIso === todayIso) {
      // Round up to the next half hour so we never propose "start 4 minutes ago".
      earliest = Math.max(earliest, Math.ceil(nowMinutes / 30) * 30);
    }
    if (earliest >= dayEnd) return { ok: false, reason: "no-slot" };

    const busy = mergeIntervals([
      ...(classBusy.get(dayOfWeek(dayIso)) ?? []),
      ...(bookedByDay.get(dayIso) ?? []),
    ]);

    // Free gaps inside [earliest, dayEnd].
    const gaps: Interval[] = [];
    let cursor = earliest;
    for (const b of busy) {
      if (b.end <= cursor) continue;
      if (b.start > cursor) gaps.push({ start: cursor, end: Math.min(b.start, dayEnd) });
      cursor = Math.max(cursor, b.end);
      if (cursor >= dayEnd) break;
    }
    if (cursor < dayEnd) gaps.push({ start: cursor, end: dayEnd });

    const usable = gaps.filter((g) => g.end - g.start >= minBlock * 60);
    if (usable.length === 0) return { ok: false, reason: "no-slot" };

    const needed = () => hours * 60;
    // Prefer an afternoon/evening slot; mornings belong to class and commuting.
    const afternoon = usable.find(
      (g) => Math.max(g.start, PREFERRED_EARLIEST_HOUR * 60) + needed() <= g.end,
    );
    if (afternoon) {
      const start = Math.max(afternoon.start, PREFERRED_EARLIEST_HOUR * 60);
      return { ok: true, startMin: start, endMin: start + needed(), hours };
    }
    const anySlot = usable.find((g) => g.end - g.start >= needed());
    if (anySlot) {
      return { ok: true, startMin: anySlot.start, endMin: anySlot.start + needed(), hours };
    }
    // Nothing fits at full length -- take the biggest gap if it still clears the
    // minimum, so a squeezed day yields a short real session, not nothing.
    const biggest = usable.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
    hours = roundQuarter((biggest.end - biggest.start) / 60);
    if (hours < minBlock) return { ok: false, reason: "no-slot" };
    return { ok: true, startMin: biggest.start, endMin: biggest.start + hours * 60, hours };
  }

  function commit(dayIso: string, p: { startMin: number; endMin: number; hours: number }) {
    const list = bookedByDay.get(dayIso) ?? [];
    list.push({ start: p.startMin, end: p.endMin });
    bookedByDay.set(dayIso, list);
    hoursByDay.set(dayIso, (hoursByDay.get(dayIso) ?? 0) + p.hours);
  }

  const blocks: StudyBlock[] = [];
  const dated = assessments
    .filter((a): a is Assessment & { dueDate: string } => Boolean(a.dueDate))
    .slice()
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  for (const a of dated) {
    const course = courseById.get(a.courseId) ?? null;
    const total = estimatedHoursFor(a);
    const ladder = chooseLadder(a.kind, total, maxBlock);
    const lighterFinish = a.kind === "exam" || a.kind === "quiz";
    const weights = sessionWeights(ladder.length, lighterFinish);

    const usedDays = new Set<string>();

    ladder.forEach((daysBefore, idx) => {
      const idealDay = addDays(a.dueDate, -daysBefore);
      const wantHours = Math.max(minBlock, roundQuarter(total * weights[idx]));

      // A crunch week gets a longer leash to shed work into calmer days.
      const crunch = intensityByWeek.get(mondayOf(idealDay)) === 3;
      const earlyReach = crunch ? EARLY_SEARCH_DAYS_CRUNCH : EARLY_SEARCH_DAYS;

      let firstFailure: PlacementFailure | null = null;
      let chosen: { day: string; p: { startMin: number; endMin: number; hours: number } } | null =
        null;

      // Earlier first: an over-budget day should push work forward in time, not
      // backwards into the deadline.
      const candidates: string[] = [idealDay];
      for (let d = 1; d <= earlyReach; d++) candidates.push(addDays(idealDay, -d));
      for (let d = 1; d <= LATE_SEARCH_DAYS; d++) candidates.push(addDays(idealDay, d));

      for (const day of candidates) {
        if (usedDays.has(day)) continue;
        if (day >= a.dueDate) continue; // prep happens before the thing, always
        const p = place(day, wantHours);
        if (p.ok) {
          chosen = { day, p };
          break;
        }
        if (firstFailure === null) firstFailure = p.reason;
      }

      if (!chosen) return; // No honest slot exists; better to omit than to fake one.

      commit(chosen.day, chosen.p);
      usedDays.add(chosen.day);

      const shift = daysBetween(idealDay, chosen.day);
      blocks.push({
        id: `sb_${a.id}_${idx + 1}`,
        courseId: a.courseId,
        assessmentId: a.id,
        title: blockTitle(a, idx, ladder.length, course?.code ?? null),
        start: toLocalDateTime(chosen.day, chosen.p.startMin),
        end: toLocalDateTime(chosen.day, chosen.p.endMin),
        rationale: buildRationale({
          assessment: a,
          courseCode: course?.code ?? null,
          index: idx,
          total: ladder.length,
          daysOut: daysBetween(chosen.day, a.dueDate),
          hours: chosen.p.hours,
          shift,
          idealDay,
          failure: firstFailure,
          maxPerDay,
          dayEndHour: opts.dayEndHour ?? DEFAULT_STUDY_OPTIONS.dayEndHour,
        }),
      });
    });
  }

  return blocks.sort((x, y) => x.start.localeCompare(y.start));
}

/* -------------------------------------------------------------------------- */
/* Copy                                                                        */
/* -------------------------------------------------------------------------- */

function milestoneLabel(index: number, total: number): string {
  if (index === 0) return "Kickoff";
  if (index === total - 1) return "Final push";
  return "Build";
}

function blockTitle(
  a: Assessment,
  index: number,
  total: number,
  courseCode: string | null,
): string {
  const prefix = courseCode ? `${courseCode} ` : "";
  if (total === 1) return `${prefix}${a.title}`;
  if (a.kind === "project" || a.kind === "presentation") {
    return `${prefix}${a.title} -- ${milestoneLabel(index, total)} (${index + 1}/${total})`;
  }
  return `${prefix}${a.title} -- Review ${index + 1}/${total}`;
}

interface RationaleInput {
  assessment: Assessment;
  courseCode: string | null;
  index: number;
  total: number;
  daysOut: number;
  hours: number;
  shift: number;
  idealDay: string;
  failure: PlacementFailure | null;
  maxPerDay: number;
  dayEndHour: number;
}

/**
 * The rationale is the product. If a student cannot read it and agree, the
 * block is noise -- so it names the item, where this session sits in the
 * sequence, how far out it is, and (when we had to move it) exactly why.
 */
function buildRationale(input: RationaleInput): string {
  const {
    assessment: a,
    courseCode,
    index,
    total,
    daysOut,
    hours,
    shift,
    idealDay,
    failure,
    maxPerDay,
    dayEndHour,
  } = input;

  const name = courseCode ? `${courseCode} ${a.title}` : a.title;
  const out =
    daysOut === 0 ? "due today" : daysOut === 1 ? "it's due tomorrow" : `you're ${daysOut} days out`;
  const len = hours === 1 ? "1h" : `${hours}h`;

  let core: string;
  if (total === 1) {
    core = `A single ${len} block for ${name} -- ${out}. At this size one focused sitting is enough; anything longer is padding.`;
  } else if (a.kind === "exam" || a.kind === "quiz") {
    core = `${capitalize(ordinal(index))} of ${countWord(total)} spaced sessions before ${name} -- ${out}. ${len} here; splitting the review across days beats one long cram because each pass re-tests what the last one let slip.`;
  } else if (a.kind === "project" || a.kind === "presentation") {
    const label = milestoneLabel(index, total).toLowerCase();
    core = `${capitalize(label)} milestone (${index + 1} of ${total}) on ${name} -- ${out}. ${len} now keeps the ${index === total - 1 ? "last day from becoming the whole project" : "final week from becoming the whole project"}.`;
  } else {
    core = `${capitalize(ordinal(index))} of ${countWord(total)} work sessions on ${name} -- ${out}. ${len} here so the last day is a review, not a first draft.`;
  }

  if (shift === 0) return core;

  const magnitude = Math.abs(shift);
  const dayWord = magnitude === 1 ? "day" : "days";
  const ideal = formatShortDate(idealDay);
  let why: string;
  switch (failure) {
    case "cap":
      why = `${ideal} was already at your ${maxPerDay}h daily study cap`;
      break;
    case "past":
      why = `the ideal ${ideal} slot has already passed`;
      break;
    default:
      why = `${ideal} had no free window between classes before ${dayEndHour}:00`;
  }
  const direction = shift < 0 ? `Moved ${magnitude} ${dayWord} earlier` : `Pushed ${magnitude} ${dayWord} later`;
  return `${core} ${direction} -- ${why}.`;
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/* -------------------------------------------------------------------------- */
/* Read helpers for the UI and the chat layer                                  */
/* -------------------------------------------------------------------------- */

export function blocksForAssessment(blocks: StudyBlock[], assessmentId: string): StudyBlock[] {
  return blocks.filter((b) => b.assessmentId === assessmentId);
}

/** Total scheduled study hours on one local date -- used by tests and the UI. */
export function scheduledHoursOnDay(blocks: StudyBlock[], dayIso: string): number {
  return roundQuarter(
    blocks
      .filter((b) => b.start.slice(0, 10) === dayIso)
      .reduce((sum, b) => {
        const s = minutesOfDay(b.start.slice(11, 16)) ?? 0;
        const e = minutesOfDay(b.end.slice(11, 16)) ?? 0;
        return sum + (e - s) / 60;
      }, 0),
  );
}

/** Exposed so callers can render a "term to date" axis without re-deriving it. */
export function studyDaySpan(blocks: StudyBlock[]): { first: string; last: string } | null {
  if (blocks.length === 0) return null;
  const days = blocks.map((b) => b.start.slice(0, 10)).sort();
  return { first: days[0], last: days[days.length - 1] };
}

/** Re-exported for callers that only import from this module. */
export { parseISODate, toISODate };
