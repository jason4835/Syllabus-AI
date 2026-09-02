/**
 * Public entry point for the semester planner.
 *
 * Everything the rest of the app needs comes from here:
 *
 *   buildSemesterPlan(courses, assessments)  -> the plan behind /api/plan
 *   replan(input)                            -> smart re-planning when dates change
 *   answerQuestion(question, ctx)            -> the chat box behind /api/chat
 *
 * The planner is a pure function of its inputs (plus an injectable clock), so
 * the same course data always produces the same plan. That is what makes
 * `replan` able to say honestly what moved: it can diff two runs.
 */

import type { Assessment, Course, SemesterPlan } from "@/lib/types";
import {
  DEFAULT_WEEKLY_BUDGET_HOURS,
  buildWeeks,
  buildWeeksFromBlocks,
  daysBetween,
  estimatedHoursFor,
  formatShortDate,
  heaviestWeek,
  resolveTerm,
  type WorkloadOptions,
} from "@/lib/plan/workload";
import { buildStudyBlocks, type StudyOptions } from "@/lib/plan/study";

export type PlanOptions = WorkloadOptions & StudyOptions;

/**
 * Build the whole plan, in three passes, because the two halves of it depend on
 * each other:
 *
 *  1. Provisional weeks. They fix the term window and the week numbering, and
 *     they score each week by the prep its deadlines imply. The scheduler needs
 *     that: it reads week intensity so it can drain work out of weeks that are
 *     already over budget.
 *  2. Study blocks, scheduled against those provisional weeks.
 *  3. Re-score every week from the blocks that actually landed in it, plus what
 *     is due that week. Only this pass is shown to the student -- scoring by
 *     deadline week alone was reporting 0h for the weeks the plan itself told
 *     them to study, which made the chart look broken.
 *
 * The term window is resolved once and the same way in every pass, so the week
 * numbers cannot shift between them.
 */
export function buildSemesterPlan(
  courses: Course[],
  assessments: Assessment[],
  opts: PlanOptions = {},
): SemesterPlan {
  const term = resolveTerm(courses, assessments, opts);
  const provisionalWeeks = buildWeeks(courses, assessments, opts);
  const studyBlocks = buildStudyBlocks(courses, assessments, provisionalWeeks, opts);
  const weeks = buildWeeksFromBlocks(courses, assessments, studyBlocks, opts);
  return {
    weeks,
    studyBlocks,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    term,
  };
}

/* -------------------------------------------------------------------------- */
/* Re-planning                                                                 */
/* -------------------------------------------------------------------------- */

export interface ReplanInput {
  courses: Course[];
  /** The updated assessment set -- what the syllabus (or the student) now says. */
  assessments: Assessment[];
  /** The assessments the current plan was built from. */
  previousAssessments: Assessment[];
  /** The plan currently on screen. */
  previousPlan: SemesterPlan;
}

export interface ReplanResult {
  plan: SemesterPlan;
  /**
   * Plain-language description of what moved and why, newest-material first.
   * Rendered as a "what changed" strip above the calendar -- a re-plan that
   * silently reshuffles the week is indistinguishable from a bug.
   */
  changes: string[];
}

/**
 * Smart re-planning entry point.
 *
 * When a professor pushes a midterm back a week, the naive fix is to rebuild
 * the plan and hope the student notices. This rebuilds *and* diffs, so the UI
 * can say "Midterm moved 4 days later -- 4 study blocks rescheduled" instead of
 * quietly rearranging someone's month.
 *
 * The diff covers three levels:
 *  - items: added, removed, re-dated, re-weighted, re-classified;
 *  - study blocks: how many sessions each of those changes moved;
 *  - weeks: intensity shifts, and a new heaviest week.
 */
export function replan(input: ReplanInput, opts: PlanOptions = {}): ReplanResult {
  const plan = buildSemesterPlan(input.courses, input.assessments, opts);
  const changes = describeChanges(input, plan, opts);
  return { plan, changes };
}

function describeChanges(
  input: ReplanInput,
  plan: SemesterPlan,
  opts: PlanOptions,
): string[] {
  const codeOf = (courseId: string) =>
    input.courses.find((c) => c.id === courseId)?.code ?? "";
  const label = (a: Assessment) => `${codeOf(a.courseId)} ${a.title}`.trim();
  const blocksFor = (id: string) => plan.studyBlocks.filter((b) => b.assessmentId === id).length;
  const prevBlocksFor = (id: string) =>
    input.previousPlan.studyBlocks.filter((b) => b.assessmentId === id).length;
  const sessions = (n: number) => `${n} study block${n === 1 ? "" : "s"}`;

  const prevById = new Map(input.previousAssessments.map((a) => [a.id, a]));
  const nextById = new Map(input.assessments.map((a) => [a.id, a]));
  const itemChanges: string[] = [];

  for (const a of input.assessments) {
    const before = prevById.get(a.id);
    if (!before) {
      const when = a.dueDate ? ` due ${formatShortDate(a.dueDate)}` : " (no date yet)";
      const n = blocksFor(a.id);
      itemChanges.push(
        `Added ${label(a)}${when} -- ${n > 0 ? `${sessions(n)} scheduled` : "nothing scheduled yet"}.`,
      );
      continue;
    }

    if (before.dueDate !== a.dueDate) {
      if (before.dueDate && a.dueDate) {
        const delta = daysBetween(before.dueDate, a.dueDate);
        const dir = delta > 0 ? "later" : "earlier";
        const mag = Math.abs(delta);
        itemChanges.push(
          `${label(a)} moved ${mag} day${mag === 1 ? "" : "s"} ${dir} (${formatShortDate(before.dueDate)} -> ${formatShortDate(a.dueDate)}) -- ${sessions(blocksFor(a.id))} rescheduled.`,
        );
      } else if (a.dueDate) {
        itemChanges.push(
          `${label(a)} now has a date (${formatShortDate(a.dueDate)}) -- ${sessions(blocksFor(a.id))} scheduled.`,
        );
      } else {
        itemChanges.push(
          `${label(a)} lost its due date -- ${sessions(prevBlocksFor(a.id))} dropped until it has one again.`,
        );
      }
      continue;
    }

    if (before.kind !== a.kind) {
      itemChanges.push(
        `${label(a)} reclassified from ${before.kind} to ${a.kind} -- estimate is now ~${estimatedHoursFor(a)}h (was ~${estimatedHoursFor(before)}h).`,
      );
      continue;
    }

    if (before.weightPercent !== a.weightPercent) {
      const from = before.weightPercent === null ? "unstated" : `${before.weightPercent}%`;
      const to = a.weightPercent === null ? "unstated" : `${a.weightPercent}%`;
      const hoursBefore = estimatedHoursFor(before);
      const hoursAfter = estimatedHoursFor(a);
      if (hoursBefore !== hoursAfter) {
        itemChanges.push(
          `${label(a)} weight changed ${from} -> ${to} -- estimate moved from ~${hoursBefore}h to ~${hoursAfter}h.`,
        );
      }
    }
  }

  for (const a of input.previousAssessments) {
    if (nextById.has(a.id)) continue;
    const n = prevBlocksFor(a.id);
    itemChanges.push(
      `Removed ${label(a)} -- ${n > 0 ? `${sessions(n)} freed up` : "nothing was scheduled for it"}.`,
    );
  }

  // Week-level consequences. Only report weeks that crossed an intensity band:
  // a week going from 11.5h to 12h is noise, a week going from busy to crunch
  // is the thing the student needs to see.
  //
  // These hours are now the work that *lands* in the week -- study blocks plus
  // what is due -- so moving a deadline can change the load of a week that has
  // no deadline in it at all. The copy says "work lands" rather than "due" so a
  // student who reads it against the calendar does not think it is a bug.
  const prevWeeks = new Map(input.previousPlan.weeks.map((w) => [w.weekStart, w]));
  const bandNames = ["calm", "normal", "busy", "crunch"] as const;
  const weekChanges: string[] = [];
  for (const w of plan.weeks) {
    const before = prevWeeks.get(w.weekStart);
    if (!before || before.intensity === w.intensity) continue;
    const verb = w.intensity > before.intensity ? "escalated" : "eased";
    weekChanges.push(
      `Week ${w.weekNumber} (${formatShortDate(w.weekStart)}) ${verb} from ${bandNames[before.intensity]} to ${bandNames[w.intensity]} (~${before.estimatedHours}h -> ~${w.estimatedHours}h).`,
    );
  }

  const peakBefore = heaviestWeek(input.previousPlan.weeks);
  const peakAfter = heaviestWeek(plan.weeks);
  if (peakAfter && peakAfter.weekStart !== peakBefore?.weekStart) {
    weekChanges.push(
      `Week ${peakAfter.weekNumber} (${formatShortDate(peakAfter.weekStart)}) is now your heaviest week -- ~${peakAfter.estimatedHours}h of work lands there (${peakAfter.studyHours}h study, ${peakAfter.dueHours}h due).`,
    );
  }

  const budget = opts.weeklyBudgetHours ?? DEFAULT_WEEKLY_BUDGET_HOURS;
  const crunch = plan.weeks.filter((w) => w.intensity === 3).length;
  const crunchBefore = input.previousPlan.weeks.filter((w) => w.intensity === 3).length;
  if (crunch !== crunchBefore) {
    weekChanges.push(
      `You now have ${crunch} week${crunch === 1 ? "" : "s"} over your ${budget}h budget (was ${crunchBefore}).`,
    );
  }

  const all = [...itemChanges, ...weekChanges.slice(0, 4)];
  if (all.length === 0) return ["Nothing moved -- the plan is unchanged."];
  return all;
}

/* -------------------------------------------------------------------------- */
/* Re-exports -- one import path for the whole planning layer                   */
/* -------------------------------------------------------------------------- */

export {
  ASSESSMENT_DUE_HOUR_COSTS,
  ASSESSMENT_HOUR_COSTS,
  DEFAULT_WEEKLY_BUDGET_HOURS,
  INTENSITY_THRESHOLDS,
  WEIGHT_EXPONENT,
  WEIGHT_SCALE_MAX,
  WEIGHT_SCALE_MIN,
  buildWeeks,
  buildWeeksFromBlocks,
  datedAssessments,
  dueHoursFor,
  estimateAssessmentHours,
  estimatedHoursFor,
  heaviestWeek,
  intensityForHours,
  resolveTerm,
  resolveTermBounds,
  studyHoursByWeek,
  termWindowFromTermLabel,
  weekForDate,
} from "@/lib/plan/workload";
export type {
  HourCost,
  HourEstimate,
  ResolvedTerm,
  TermSource,
  WorkloadOptions,
} from "@/lib/plan/workload";

export {
  DEFAULT_STUDY_OPTIONS,
  blocksForAssessment,
  buildStudyBlocks,
  scheduledHoursOnDay,
} from "@/lib/plan/study";
export type { StudyOptions } from "@/lib/plan/study";

export { answerQuestion, answerLocally, buildPlanContext, findAssessment } from "@/lib/plan/chat";
export type { ChatContext, ChatOptions, ChatTurn } from "@/lib/plan/chat";
