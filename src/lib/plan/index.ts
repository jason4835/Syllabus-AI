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
  daysBetween,
  estimatedHoursFor,
  formatShortDate,
  heaviestWeek,
  type WorkloadOptions,
} from "@/lib/plan/workload";
import { buildStudyBlocks, type StudyOptions } from "@/lib/plan/study";

export type PlanOptions = WorkloadOptions & StudyOptions;

/**
 * Build the whole plan: weekly load first, then study blocks scheduled against
 * it. Order matters -- the scheduler reads week intensity so it can drain prep
 * out of weeks that are already over budget.
 */
export function buildSemesterPlan(
  courses: Course[],
  assessments: Assessment[],
  opts: PlanOptions = {},
): SemesterPlan {
  const weeks = buildWeeks(courses, assessments, opts);
  const studyBlocks = buildStudyBlocks(courses, assessments, weeks, opts);
  return {
    weeks,
    studyBlocks,
    generatedAt: (opts.now ?? new Date()).toISOString(),
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
      `Week ${peakAfter.weekNumber} (${formatShortDate(peakAfter.weekStart)}) is now your heaviest week at ~${peakAfter.estimatedHours}h.`,
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
  ASSESSMENT_HOUR_COSTS,
  DEFAULT_WEEKLY_BUDGET_HOURS,
  INTENSITY_THRESHOLDS,
  WEIGHT_EXPONENT,
  WEIGHT_SCALE_MAX,
  WEIGHT_SCALE_MIN,
  buildWeeks,
  datedAssessments,
  estimateAssessmentHours,
  estimatedHoursFor,
  heaviestWeek,
  intensityForHours,
  resolveTermBounds,
  weekForDate,
} from "@/lib/plan/workload";
export type { HourCost, HourEstimate, WorkloadOptions } from "@/lib/plan/workload";

export {
  DEFAULT_STUDY_OPTIONS,
  blocksForAssessment,
  buildStudyBlocks,
  scheduledHoursOnDay,
} from "@/lib/plan/study";
export type { StudyOptions } from "@/lib/plan/study";

export { answerQuestion, answerLocally, buildPlanContext, findAssessment } from "@/lib/plan/chat";
export type { ChatContext, ChatOptions, ChatTurn } from "@/lib/plan/chat";
