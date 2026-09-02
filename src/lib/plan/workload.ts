/**
 * Workload model: turns a flat list of assessments into a week-by-week picture
 * of how hard the semester actually gets.
 *
 * The whole point of this file is that the numbers are *defensible*. A heatmap
 * that colors a week red because it contains three items is a lie -- three
 * readings is a quiet week and one 30%-weight final is not. So every number
 * here traces back to an estimate in hours, and every estimate is explainable
 * to the student ("8h base for an exam, x1.6 because it's worth 30%").
 *
 * Everything in this file is pure: data in, data out. No clock, no network.
 */

import { termWindowFromLabel } from "@/lib/parse/dates";
import type {
  Assessment,
  AssessmentKind,
  Course,
  SemesterPlan,
  StudyBlock,
  WeekLoad,
} from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* Date helpers                                                                */
/* -------------------------------------------------------------------------- */
/*
 * No date library is installed and we do not want one: all we need is
 * calendar-day arithmetic on "YYYY-MM-DD" strings. We anchor every parsed date
 * at UTC midnight so that adding days can never be knocked sideways by a DST
 * transition in the user's local zone -- a bug that would silently shift a
 * study block onto the wrong day twice a year.
 */

/** Parse "YYYY-MM-DD" (or the date half of an ISO datetime) to UTC midnight. */
export function parseISODate(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
}

export function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const d = parseISODate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toISODate(d);
}

/** 0 = Sunday .. 6 = Saturday -- same convention as `MeetingTime.daysOfWeek`. */
export function dayOfWeek(iso: string): number {
  return parseISODate(iso).getUTCDay();
}

/** Whole days from `a` to `b`; negative when `b` is earlier. */
export function daysBetween(a: string, b: string): number {
  const ms = parseISODate(b).getTime() - parseISODate(a).getTime();
  return Math.round(ms / 86_400_000);
}

/** Monday of the ISO week containing `iso`. Weeks start Monday, not Sunday. */
export function mondayOf(iso: string): string {
  const dow = dayOfWeek(iso);
  // Sunday (0) belongs to the week that started six days earlier, not the one
  // about to start -- that is the ISO-8601 rule and what students expect.
  const backUp = dow === 0 ? 6 : dow - 1;
  return addDays(iso, -backUp);
}

/** "Oct 12" -- short, unambiguous, and locale-stable because we pin the zone. */
export function formatShortDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(parseISODate(iso));
}

/** Minutes since midnight for "HH:MM". Returns null for unparseable input. */
export function minutesOfDay(hhmm: string | null): number | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/* -------------------------------------------------------------------------- */
/* The hour-cost model                                                         */
/* -------------------------------------------------------------------------- */

/**
 * One row of the published cost table. The UI renders these verbatim next to an
 * estimate so a student can argue with the model instead of distrusting it.
 */
export interface HourCost {
  /** Hours of out-of-class work a *typical* item of this kind costs. */
  baseHours: number;
  /**
   * The grade weight `baseHours` assumes. Weight scaling is measured against
   * this, so a 15%-weight exam scores exactly `baseHours` and a 30% one scores
   * more. Without a reference point "scale by weight" has no meaning.
   */
  referenceWeightPercent: number;
  /** Shown in the "how did you get this number?" popover. */
  note: string;
}

/**
 * Base cost per assessment kind, in hours of work outside class.
 *
 * These are deliberately conservative mid-range numbers for a 3-4 credit
 * undergraduate course. They are not guesses dressed up as science -- they are
 * a starting prior that the weight scaler then adjusts, and that a future
 * version can personalise from a student's own logged hours.
 */
export const ASSESSMENT_HOUR_COSTS: Record<AssessmentKind, HourCost> = {
  exam: {
    baseHours: 8,
    referenceWeightPercent: 15,
    note: "Review, practice problems and a final pass -- spread over several days, not one night.",
  },
  project: {
    baseHours: 12,
    referenceWeightPercent: 20,
    note: "Scoping, build/write, and revision. The single largest line item most semesters.",
  },
  presentation: {
    baseHours: 5,
    referenceWeightPercent: 10,
    note: "Slides plus at least two rehearsals; delivery is what gets graded.",
  },
  assignment: {
    baseHours: 3,
    referenceWeightPercent: 5,
    note: "A typical problem set or short paper.",
  },
  lab: {
    baseHours: 2.5,
    referenceWeightPercent: 5,
    note: "Pre-lab prep plus the write-up; bench time itself is scheduled class time.",
  },
  quiz: {
    baseHours: 1.5,
    referenceWeightPercent: 3,
    note: "A focused review of one or two lectures.",
  },
  reading: {
    baseHours: 1,
    referenceWeightPercent: 2,
    note: "One assigned reading with notes.",
  },
  other: {
    baseHours: 2,
    referenceWeightPercent: 5,
    note: "Unclassified item -- estimated as a small assignment.",
  },
};

/**
 * What it costs to *deliver* an item, in the week it is actually due.
 *
 * This is deliberately not the same table as `ASSESSMENT_HOUR_COSTS`: that one
 * is the preparation, which the scheduler spreads over the weeks leading up to
 * the deadline. This one is the irreducible hour the deadline itself eats --
 * sitting the exam, uploading the paper, the last read-through. Without it a
 * week whose only content is "the final is Thursday" would score zero, and the
 * heatmap would go pale on the single week the student most needs it dark.
 *
 * Deliberately small numbers. If delivery cost were large it would drag the
 * heaviest week back onto the deadline, which is exactly the distortion this
 * whole change exists to remove.
 */
export const ASSESSMENT_DUE_HOUR_COSTS: Record<AssessmentKind, number> = {
  exam: 2, // a sitting is usually a full period plus getting there
  project: 1, // submission, demo setup, the final read-through
  presentation: 1, // your slot plus the run-up
  assignment: 0.5, // hand-in and the last pass over it
  lab: 0.5, // write-up hand-in; bench time is scheduled class time
  quiz: 0.5,
  reading: 0, // nothing is "delivered" -- the cost is all in the reading itself
  other: 0.5,
};

/** Delivery cost of one assessment in the week it is due. */
export function dueHoursFor(a: Assessment): number {
  return ASSESSMENT_DUE_HOUR_COSTS[a.kind] ?? ASSESSMENT_DUE_HOUR_COSTS.other;
}

/**
 * How hard weight pulls the estimate around.
 *
 * `WEIGHT_EXPONENT` is below 1 on purpose: doubling what an exam is worth does
 * not double how long it takes to prepare for. Effort has real diminishing
 * returns, and a linear scaler produces absurd 40-hour finals.
 *
 * The clamp exists so a mislabelled 0.5% item cannot collapse to zero hours and
 * a 60%-weight capstone cannot swallow the whole heatmap.
 */
export const WEIGHT_EXPONENT = 0.7;
export const WEIGHT_SCALE_MIN = 0.5;
export const WEIGHT_SCALE_MAX = 2.5;

/** A single estimate, with its own derivation attached. */
export interface HourEstimate {
  assessmentId: string;
  hours: number;
  baseHours: number;
  kind: AssessmentKind;
  weightPercent: number | null;
  weightScale: number;
  /** One sentence the UI can show under the number. */
  explanation: string;
}

function roundQuarter(h: number): number {
  return Math.round(h * 4) / 4;
}

/**
 * Estimate the out-of-class hours one assessment costs, and show the working.
 *
 * hours = baseHours(kind) x clamp((weight / referenceWeight) ^ 0.7, 0.5, 2.5)
 *
 * A missing weight scores 1.0 rather than 0 -- an unstated weight is missing
 * information, not evidence that the item is free.
 */
export function estimateAssessmentHours(a: Assessment): HourEstimate {
  const cost = ASSESSMENT_HOUR_COSTS[a.kind] ?? ASSESSMENT_HOUR_COSTS.other;
  const weight =
    typeof a.weightPercent === "number" && a.weightPercent > 0
      ? a.weightPercent
      : null;

  let scale = 1;
  if (weight !== null) {
    const raw = Math.pow(weight / cost.referenceWeightPercent, WEIGHT_EXPONENT);
    scale = Math.min(WEIGHT_SCALE_MAX, Math.max(WEIGHT_SCALE_MIN, raw));
  }

  const hours = Math.max(0.5, roundQuarter(cost.baseHours * scale));
  const kindPhrase = `${article(a.kind)} ${a.kind}`;
  const explanation =
    weight === null
      ? `${cost.baseHours}h base for ${kindPhrase}; no weight stated in the syllabus, so no adjustment. ${cost.note}`
      : `${cost.baseHours}h base for ${kindPhrase}, scaled x${scale.toFixed(2)} because it is worth ${weight}% (a typical ${a.kind} is ~${cost.referenceWeightPercent}%). ${cost.note}`;

  return {
    assessmentId: a.id,
    hours,
    baseHours: cost.baseHours,
    kind: a.kind,
    weightPercent: weight,
    weightScale: Number(scale.toFixed(2)),
    explanation,
  };
}

/** Convenience wrapper when only the number is needed. */
export function estimatedHoursFor(a: Assessment): number {
  return estimateAssessmentHours(a).hours;
}

/* -------------------------------------------------------------------------- */
/* Intensity                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Hours of out-of-class work per week a full-time student can absorb before it
 * stops being sustainable. Roughly 2h per credit hour on a 12-15 credit load,
 * which is the number most advising offices quote.
 */
export const DEFAULT_WEEKLY_BUDGET_HOURS = 15;

/**
 * Intensity is a fraction of that budget, never a count of items:
 *
 *   0 calm   <= 35% of budget  (<= ~5h)   -- room to get ahead
 *   1 normal <= 70% of budget  (<= ~10.5h)-- an ordinary week
 *   2 busy   <= 100% of budget (<= ~15h)  -- full, but it fits
 *   3 crunch  > 100% of budget ( > ~15h)  -- does not fit; something must move
 *
 * The thresholds are ratios rather than absolute hours so that a student who
 * sets a 25h budget gets a heatmap calibrated to their own life.
 */
export const INTENSITY_THRESHOLDS = {
  calm: 0.35,
  normal: 0.7,
  busy: 1.0,
} as const;

export function intensityForHours(
  hours: number,
  weeklyBudgetHours: number = DEFAULT_WEEKLY_BUDGET_HOURS,
): 0 | 1 | 2 | 3 {
  const budget = weeklyBudgetHours > 0 ? weeklyBudgetHours : DEFAULT_WEEKLY_BUDGET_HOURS;
  const ratio = hours / budget;
  if (ratio <= INTENSITY_THRESHOLDS.calm) return 0;
  if (ratio <= INTENSITY_THRESHOLDS.normal) return 1;
  if (ratio <= INTENSITY_THRESHOLDS.busy) return 2;
  return 3;
}

/* -------------------------------------------------------------------------- */
/* Week building                                                               */
/* -------------------------------------------------------------------------- */

export interface WorkloadOptions {
  /** ISO date; overrides whatever the courses claim. */
  termStart?: string;
  termEnd?: string;
  /** Out-of-class hours per week the student is budgeting. Default 15. */
  weeklyBudgetHours?: number;
}

/** Due instant used for ordering: a stated time, else end of day. */
function dueMinutes(a: Assessment): number {
  return minutesOfDay(a.dueTime) ?? 23 * 60 + 59;
}

function dueTimestamp(a: Assessment): number {
  if (!a.dueDate) return Number.POSITIVE_INFINITY;
  return parseISODate(a.dueDate).getTime() + dueMinutes(a) * 60_000;
}

/** Assessments that actually landed on a date -- undated ones cannot be planned. */
export function datedAssessments(assessments: Assessment[]): Assessment[] {
  return assessments
    .filter((a): a is Assessment & { dueDate: string } => Boolean(a.dueDate))
    .slice()
    .sort((x, y) => dueTimestamp(x) - dueTimestamp(y));
}

/* -------------------------------------------------------------------------- */
/* The term window                                                             */
/* -------------------------------------------------------------------------- */

export type TermSource = NonNullable<SemesterPlan["term"]>["source"];

export interface ResolvedTerm {
  start: string;
  end: string;
  source: TermSource;
}

/** Where one bound came from, weakest last. Drives `TermSource`. */
type BoundSource = "syllabus" | "label" | "deadlines";

/**
 * How far back the deadline-only fallback reaches behind the first due date.
 *
 * A term that starts on the day the first thing is due has nowhere to put the
 * preparation for it, so week 1 is instantly a crunch week and every study
 * block falls off the front of the chart.
 */
const DEADLINE_FALLBACK_LEAD_DAYS = 14;

/**
 * Realistic US academic windows, keyed by the month a season starts in.
 *
 * `termWindowFromLabel` is built for a different job -- it exists so the parser
 * can decide whether a bare "Jan 20" in a Fall syllabus means January of the
 * following year -- so it returns a deliberately *generous* envelope: "Fall
 * 2026" comes back as Aug 1 - Dec 31. That is right for year inference and
 * wrong for numbering weeks: it would make week 1 the week of Jul 27 and hand
 * the student a 23-week semester. So we take the season and year from it and
 * narrow the envelope here, in the caller, to the window a registrar would
 * recognise. Keyed by start month so this keeps working if that function is
 * later tightened.
 */
const ACADEMIC_WINDOWS: Record<number, { start: [number, number]; end: [number, number] }> = {
  8: { start: [8, 26], end: [12, 18] }, // fall: late Aug -> finals week in mid-Dec
  1: { start: [1, 20], end: [5, 15] }, // spring: mid/late Jan -> mid-May
  5: { start: [5, 20], end: [8, 15] }, // summer session
  11: { start: [1, 3], end: [3, 20] }, // winter: dated into the envelope's *end* year
};

function isoOf(year: number, month: number, day: number): string {
  const p = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${year}-${p(month)}-${p(day)}`;
}

/**
 * The academic window a term label like "Fall 2026" implies, or null when the
 * label says nothing we can date.
 */
export function termWindowFromTermLabel(label: string | null): { start: string; end: string } | null {
  const envelope = termWindowFromLabel(label);
  if (!envelope.termStart || !envelope.termEnd) return null;

  const startYear = Number(envelope.termStart.slice(0, 4));
  const startMonth = Number(envelope.termStart.slice(5, 7));
  const endYear = Number(envelope.termEnd.slice(0, 4));
  const window = ACADEMIC_WINDOWS[startMonth];
  // An envelope we do not recognise is still better than nothing; using it raw
  // beats pretending the label was unreadable.
  if (!window) return { start: envelope.termStart, end: envelope.termEnd };

  // A window that straddles New Year (winter) is anchored to the year the
  // envelope *ends* in, which is the year its classes actually meet.
  const anchor = startMonth === 11 ? endYear : startYear;
  const start = isoOf(anchor, window.start[0], window.start[1]);
  const end = isoOf(
    window.end[0] < window.start[0] ? anchor + 1 : anchor,
    window.end[0],
    window.end[1],
  );
  return { start, end };
}

/**
 * Resolve the window the weeks are numbered from, and say how sure to be.
 *
 * Order, best evidence first:
 *
 *  1. `"syllabus"` -- a course states its own dates. Earliest start, latest end.
 *  2. `"inferred"` -- no dates, but a term label ("Fall 2026") we can turn into
 *     a real academic window. Also covers "start stated, end from the label".
 *  3. `"deadlines"` -- nothing to go on, so the deadlines have to stand in for
 *     the calendar. Padded back two weeks, because a term that begins on the
 *     first due date has nowhere to put the prep for it.
 *  4. `null` -- no dated assessments at all, so there is no semester to draw.
 *
 * This ordering is the fix for the bug where a syllabus with no stated dates
 * produced a heatmap whose week 1 was the week of the first deadline -- Oct 5,
 * for a fall term. Deadlines describe the work, not the calendar.
 */
export function resolveTerm(
  courses: Course[],
  assessments: Assessment[],
  opts: WorkloadOptions = {},
): ResolvedTerm | null {
  const dated = datedAssessments(assessments);
  const firstDue = dated.length ? (dated[0].dueDate as string) : null;
  const lastDue = dated.length ? (dated[dated.length - 1].dueDate as string) : null;

  const courseStarts = courses.map((c) => c.startDate).filter((d): d is string => Boolean(d));
  const courseEnds = courses.map((c) => c.endDate).filter((d): d is string => Boolean(d));
  const statedStart = opts.termStart ?? (courseStarts.length ? courseStarts.slice().sort()[0] : null);
  const statedEnd =
    opts.termEnd ?? (courseEnds.length ? courseEnds.slice().sort().slice(-1)[0] : null);

  // Widest window any course's label implies -- students on one term rarely
  // disagree, but a cross-listed course occasionally carries a longer session.
  const labelWindows = courses
    .map((c) => termWindowFromTermLabel(c.term))
    .filter((w): w is { start: string; end: string } => w !== null);
  const labelStart = labelWindows.length
    ? labelWindows.map((w) => w.start).sort()[0]
    : null;
  const labelEnd = labelWindows.length
    ? labelWindows.map((w) => w.end).sort().slice(-1)[0]
    : null;

  // With no dated work there is nothing to plan, and a window drawn around zero
  // assessments would be a confident-looking chart of nothing. The one
  // exception is a caller that explicitly asked for a window.
  if (dated.length === 0) {
    if (opts.termStart && opts.termEnd) {
      return { start: opts.termStart, end: opts.termEnd, source: "syllabus" };
    }
    return null;
  }

  let start: string;
  let startFrom: BoundSource;
  if (statedStart) {
    start = statedStart;
    startFrom = "syllabus";
  } else if (labelStart) {
    start = labelStart;
    startFrom = "label";
  } else {
    start = firstDue as string;
    startFrom = "deadlines";
  }

  let end: string;
  let endFrom: BoundSource;
  if (statedEnd) {
    end = statedEnd;
    endFrom = "syllabus";
  } else if (labelEnd) {
    end = labelEnd;
    endFrom = "label";
  } else {
    end = lastDue as string;
    endFrom = "deadlines";
  }

  // Only pad when the *start* itself was guessed from a deadline. A stated
  // start is the registrar's answer and does not need our help.
  if (startFrom === "deadlines" && firstDue) {
    const padded = mondayOf(addDays(firstDue, -DEADLINE_FALLBACK_LEAD_DAYS));
    if (padded < start) start = padded;
  }
  if (end < start) end = start;

  const source: TermSource =
    startFrom === "syllabus" && endFrom === "syllabus"
      ? "syllabus"
      : startFrom === "deadlines" || endFrom === "deadlines"
        ? "deadlines"
        : "inferred";

  return { start, end, source };
}

/**
 * Back-compatible view of `resolveTerm` for callers that only want the bounds.
 *
 * Note the behaviour change: the window is no longer stretched to swallow every
 * dated assessment. A stated term is the truth about the calendar, and one
 * item dated outside it is a typo or a make-up, not a reason to add six empty
 * weeks. Such items are clamped into the nearest real week by `buildWeeks`,
 * which also says so in that week's warning.
 */
export function resolveTermBounds(
  courses: Course[],
  assessments: Assessment[],
  opts: WorkloadOptions = {},
): { termStart: string; termEnd: string } | null {
  const term = resolveTerm(courses, assessments, opts);
  return term ? { termStart: term.start, termEnd: term.end } : null;
}

/** Every Monday from the term's first week through the week containing its end. */
export function weekStartsBetween(termStart: string, termEnd: string): string[] {
  const first = mondayOf(termStart);
  const last = mondayOf(termEnd);
  const out: string[] = [];
  for (let w = first; w <= last; w = addDays(w, 7)) out.push(w);
  return out;
}

/**
 * Runs of >= 3 deadlines packed into any 48-hour window.
 *
 * This is computed across the whole term rather than per week, because the
 * nastiest pileups straddle a weekend -- three things due Sunday night through
 * Tuesday morning is exactly the case a per-week scan would miss.
 */
interface DeadlineCluster {
  count: number;
  firstDate: string;
  lastDate: string;
}

function findClusters(dated: Assessment[]): DeadlineCluster[] {
  const WINDOW_MS = 48 * 3_600_000;
  const clusters: DeadlineCluster[] = [];
  let i = 0;
  while (i < dated.length) {
    let j = i;
    while (j + 1 < dated.length && dueTimestamp(dated[j + 1]) - dueTimestamp(dated[i]) <= WINDOW_MS) {
      j++;
    }
    const count = j - i + 1;
    if (count >= 3) {
      clusters.push({
        count,
        firstDate: dated[i].dueDate as string,
        lastDate: dated[j].dueDate as string,
      });
      i = j + 1; // Don't report overlapping windows over and over.
    } else {
      i++;
    }
  }
  return clusters;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** "an exam" / "a project" -- generated copy is read by students, so it reads. */
export function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

/** "2 exams and a project", "an exam, a project and a presentation". */
function describeMix(items: Assessment[]): string | null {
  const majorKinds: AssessmentKind[] = ["exam", "project", "presentation"];
  const counts = new Map<AssessmentKind, number>();
  for (const a of items) {
    if (majorKinds.includes(a.kind)) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
  }
  const majorTotal = [...counts.values()].reduce((s, n) => s + n, 0);

  if (majorTotal >= 2) {
    const phrases = majorKinds
      .filter((k) => counts.has(k))
      .map((k) => {
        const n = counts.get(k) as number;
        return n === 1 ? `${article(k)} ${k}` : plural(n, k);
      });
    const list =
      phrases.length === 1
        ? phrases[0]
        : `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;
    return `${list} due in the same week`;
  }
  // No pileup of big-ticket items, but sheer volume can still be the problem.
  if (items.length >= 4) return `${items.length} deadlines in one week`;
  return null;
}

/** Length of one study block in hours; 0 for anything unparseable. */
function blockHours(b: StudyBlock): number {
  const s = minutesOfDay(b.start.slice(11, 16));
  const e = minutesOfDay(b.end.slice(11, 16));
  if (s === null || e === null || e <= s) return 0;
  return (e - s) / 60;
}

/**
 * Study hours per week, keyed by the Monday of the week each block *starts* in.
 *
 * Blocks that fall outside the term -- prep for an early deadline that reaches
 * back before day one, most often -- are clamped onto the nearest real week
 * rather than dropped, so the totals on the chart always add up to the plan.
 */
export function studyHoursByWeek(blocks: StudyBlock[], weekStarts: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (weekStarts.length === 0) return out;
  for (const s of weekStarts) out.set(s, 0);

  const first = weekStarts[0];
  const last = weekStarts[weekStarts.length - 1];
  for (const b of blocks) {
    const raw = mondayOf(b.start.slice(0, 10));
    const key = raw < first ? first : raw > last ? last : raw;
    out.set(key, (out.get(key) ?? 0) + blockHours(b));
  }
  return out;
}

/**
 * Bucket assessments into ISO weeks and score each week.
 *
 * `weekNumber` is 1-based from the Monday of the term's first week, so "week 7"
 * means the same thing here as it does on the registrar's calendar. Weeks are
 * contiguous across the whole window, empty ones included -- the gaps are the
 * information: they are where a student can get ahead.
 *
 * Without `blocks` -- the mode for callers that only have assessments, and the
 * provisional pass the scheduler itself reads -- `studyHours` is reported as 0
 * because nobody has scheduled anything yet, `dueHours` is the real delivery
 * cost, and `estimatedHours` falls back to charging every item's whole prep
 * estimate to its deadline week. That approximation is what makes the
 * scheduler's crunch weeks visible before there are blocks to measure.
 *
 * With `blocks`, a week scores exactly the work that lands in it:
 * `estimatedHours = studyHours + dueHours`.
 */
export function buildWeeks(
  courses: Course[],
  assessments: Assessment[],
  opts: WorkloadOptions = {},
): WeekLoad[] {
  return buildWeeksFromBlocks(courses, assessments, null, opts);
}

/** `buildWeeks`, scored against real study blocks. See the note there. */
export function buildWeeksFromBlocks(
  courses: Course[],
  assessments: Assessment[],
  blocks: StudyBlock[] | null,
  opts: WorkloadOptions = {},
): WeekLoad[] {
  const term = resolveTerm(courses, assessments, opts);
  if (!term) return [];

  const budget = opts.weeklyBudgetHours ?? DEFAULT_WEEKLY_BUDGET_HOURS;
  const dated = datedAssessments(assessments);
  const starts = weekStartsBetween(term.start, term.end);
  const firstWeek = starts[0];
  const lastWeek = starts[starts.length - 1];

  const byWeek = new Map<string, Assessment[]>();
  for (const s of starts) byWeek.set(s, []);
  // Items dated outside the window are clamped onto the nearest week instead of
  // being dropped or allowed to stretch the term. A single mis-parsed "Jan 5"
  // must not silently disappear, and must not add three empty weeks either.
  const strayByWeek = new Map<string, Assessment[]>();
  for (const a of dated) {
    const raw = mondayOf(a.dueDate as string);
    const key = raw < firstWeek ? firstWeek : raw > lastWeek ? lastWeek : raw;
    (byWeek.get(key) as Assessment[]).push(a);
    if (key !== raw) {
      const strays = strayByWeek.get(key) ?? [];
      strays.push(a);
      strayByWeek.set(key, strays);
    }
  }

  const studyByWeek = blocks ? studyHoursByWeek(blocks, starts) : null;

  // Clusters are attributed to the week their first deadline falls in.
  const clusterByWeek = new Map<string, DeadlineCluster>();
  for (const c of findClusters(dated)) {
    const key = mondayOf(c.firstDate);
    const existing = clusterByWeek.get(key);
    if (!existing || c.count > existing.count) clusterByWeek.set(key, c);
  }

  const draft = starts.map((weekStart, i) => {
    const items = byWeek.get(weekStart) ?? [];
    const dueHours = roundQuarter(items.reduce((sum, a) => sum + dueHoursFor(a), 0));
    const studyHours = studyByWeek
      ? roundQuarter(studyByWeek.get(weekStart) ?? 0)
      : 0;
    const estimatedHours = studyByWeek
      ? roundQuarter(studyHours + dueHours)
      : roundQuarter(items.reduce((sum, a) => sum + estimatedHoursFor(a), 0));
    return {
      weekStart,
      weekNumber: i + 1,
      assessmentIds: items.map((a) => a.id),
      estimatedHours,
      studyHours,
      dueHours,
      intensity: intensityForHours(estimatedHours, budget),
      items,
    };
  });

  const peak = draft.reduce((m, w) => Math.max(m, w.estimatedHours), 0);
  const peakCount = draft.filter((w) => w.estimatedHours === peak).length;
  const scoredByBlocks = studyByWeek !== null;

  return draft.map((w): WeekLoad => {
    const cluster = clusterByWeek.get(w.weekStart);
    const parts: string[] = [];

    const mix = describeMix(w.items);
    if (mix && w.intensity >= 2) parts.push(mix);

    if (cluster) {
      const range =
        cluster.firstDate === cluster.lastDate
          ? formatShortDate(cluster.firstDate)
          : `${formatShortDate(cluster.firstDate)}-${formatShortDate(cluster.lastDate)}`;
      parts.push(`${cluster.count} deadlines within 48 hours (${range})`);
    }

    // "Heaviest week" is only meaningful if it is uniquely the heaviest and the
    // term has some shape to it -- otherwise it is filler.
    const isHeaviest =
      peakCount === 1 && w.estimatedHours === peak && draft.length > 1 && peak > 0;
    if (isHeaviest && (w.intensity >= 2 || cluster)) {
      parts.push(heaviestWeekPhrase(w.estimatedHours, w.studyHours, w.dueHours, scoredByBlocks));
    } else if (w.intensity === 3) {
      parts.push(`~${w.estimatedHours}h of work against a ${budget}h/week budget`);
    }

    // Silence is a valid answer. A calm week with nothing clustered gets null so
    // that a warning in the UI always means something.
    const strays = strayByWeek.get(w.weekStart);
    const strayNote = strays
      ? `${plural(strays.length, "deadline")} dated outside the term (${strays
          .map((a) => formatShortDate(a.dueDate as string))
          .join(", ")}) counted here`
      : null;
    const shown = [...parts.slice(0, 2), ...(strayNote ? [strayNote] : [])];
    const warning = shown.length === 0 ? null : capitalizeFirst(shown.join(" -- "));

    return {
      weekStart: w.weekStart,
      weekNumber: w.weekNumber,
      assessmentIds: w.assessmentIds,
      estimatedHours: w.estimatedHours,
      studyHours: w.studyHours,
      dueHours: w.dueHours,
      intensity: w.intensity,
      warning,
    };
  });
}

/**
 * The heaviest week is now the week with the most work *scheduled in it*, which
 * is usually the run-up to a big deadline rather than the deadline's own week.
 * Saying "heaviest week" alone would look wrong next to an empty deadline
 * column, so the phrasing names the split that produced the number.
 */
function heaviestWeekPhrase(
  hours: number,
  studyHours: number,
  dueHours: number,
  scoredByBlocks: boolean,
): string {
  if (!scoredByBlocks) return `heaviest week of your semester (~${hours}h due this week)`;
  const split =
    dueHours > 0
      ? `${studyHours}h of planned study plus ${dueHours}h of sitting and submitting`
      : `${studyHours}h of planned study, all of it prep for what comes after`;
  return `your heaviest week: ~${hours}h of work lands here -- ${split}`;
}

function capitalizeFirst(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/** The week a given ISO date falls in, or null when it is outside the term. */
export function weekForDate(weeks: WeekLoad[], iso: string): WeekLoad | null {
  const key = mondayOf(iso);
  return weeks.find((w) => w.weekStart === key) ?? null;
}

/** Uniquely heaviest week, or null when the term is flat or empty. */
export function heaviestWeek(weeks: WeekLoad[]): WeekLoad | null {
  if (weeks.length === 0) return null;
  const peak = weeks.reduce((m, w) => Math.max(m, w.estimatedHours), 0);
  if (peak <= 0) return null;
  const tied = weeks.filter((w) => w.estimatedHours === peak);
  return tied[0] ?? null;
}
