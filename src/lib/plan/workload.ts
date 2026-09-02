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

import type { Assessment, AssessmentKind, Course, WeekLoad } from "@/lib/types";

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

/**
 * Resolve the term window.
 *
 * Preference order: explicit options, then the union of the courses' own term
 * dates, then the span of the assessments themselves. Whatever we land on is
 * then *widened* to cover every dated assessment -- a syllabus that lists a
 * make-up exam after the stated end date must still get a week, or it would
 * vanish from the heatmap entirely.
 */
export function resolveTermBounds(
  courses: Course[],
  assessments: Assessment[],
  opts: WorkloadOptions = {},
): { termStart: string; termEnd: string } | null {
  const dated = datedAssessments(assessments);
  const courseStarts = courses.map((c) => c.startDate).filter((d): d is string => Boolean(d));
  const courseEnds = courses.map((c) => c.endDate).filter((d): d is string => Boolean(d));

  const candidates: string[] = dated.map((a) => a.dueDate as string);

  let start = opts.termStart ?? (courseStarts.length ? courseStarts.slice().sort()[0] : undefined);
  let end = opts.termEnd ?? (courseEnds.length ? courseEnds.slice().sort().slice(-1)[0] : undefined);

  if (!start) start = candidates.length ? candidates[0] : undefined;
  if (!end) end = candidates.length ? candidates[candidates.length - 1] : undefined;
  if (!start || !end) return null;

  for (const d of candidates) {
    if (d < start) start = d;
    if (d > end) end = d;
  }
  if (end < start) end = start;
  return { termStart: start, termEnd: end };
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

/**
 * Bucket assessments into ISO weeks and score each week.
 *
 * `weekNumber` is 1-based from the Monday of the term's first week, so "week 7"
 * means the same thing here as it does on the registrar's calendar.
 */
export function buildWeeks(
  courses: Course[],
  assessments: Assessment[],
  opts: WorkloadOptions = {},
): WeekLoad[] {
  const bounds = resolveTermBounds(courses, assessments, opts);
  if (!bounds) return [];

  const budget = opts.weeklyBudgetHours ?? DEFAULT_WEEKLY_BUDGET_HOURS;
  const dated = datedAssessments(assessments);
  const starts = weekStartsBetween(bounds.termStart, bounds.termEnd);

  const byWeek = new Map<string, Assessment[]>();
  for (const s of starts) byWeek.set(s, []);
  for (const a of dated) {
    const key = mondayOf(a.dueDate as string);
    const bucket = byWeek.get(key);
    if (bucket) bucket.push(a);
    // Bounds were widened to cover every dated assessment, so a miss here is
    // impossible; ignoring it rather than throwing keeps the planner total.
  }

  // Clusters are attributed to the week their first deadline falls in.
  const clusterByWeek = new Map<string, DeadlineCluster>();
  for (const c of findClusters(dated)) {
    const key = mondayOf(c.firstDate);
    const existing = clusterByWeek.get(key);
    if (!existing || c.count > existing.count) clusterByWeek.set(key, c);
  }

  const draft = starts.map((weekStart, i) => {
    const items = byWeek.get(weekStart) ?? [];
    const estimatedHours = roundQuarter(
      items.reduce((sum, a) => sum + estimatedHoursFor(a), 0),
    );
    return {
      weekStart,
      weekNumber: i + 1,
      assessmentIds: items.map((a) => a.id),
      estimatedHours,
      intensity: intensityForHours(estimatedHours, budget),
      items,
    };
  });

  const peak = draft.reduce((m, w) => Math.max(m, w.estimatedHours), 0);
  const peakCount = draft.filter((w) => w.estimatedHours === peak).length;

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
      parts.push(`heaviest week of your semester (~${w.estimatedHours}h)`);
    } else if (w.intensity === 3) {
      parts.push(`~${w.estimatedHours}h of work against a ${budget}h/week budget`);
    }

    // Silence is a valid answer. A calm week with nothing clustered gets null so
    // that a warning in the UI always means something.
    const warning =
      parts.length === 0
        ? null
        : capitalizeFirst(parts.slice(0, 2).join(" -- "));

    return {
      weekStart: w.weekStart,
      weekNumber: w.weekNumber,
      assessmentIds: w.assessmentIds,
      estimatedHours: w.estimatedHours,
      intensity: w.intensity,
      warning,
    };
  });
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
