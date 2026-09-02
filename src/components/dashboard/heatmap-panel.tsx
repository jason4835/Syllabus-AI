"use client";

import { useMemo, useState } from "react";
import type { Assessment, Course, SemesterPlan, WeekLoad } from "@/lib/types";
import { Panel } from "@/components/ui/panel";
import { GridIcon, AlertIcon, InfoIcon } from "@/components/icons";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { LoadingRegion, SkeletonStrip } from "@/components/ui/skeleton";
import { AssessmentRow } from "@/components/dashboard/assessment-row";
import { accentFor } from "@/components/course-accents";
import {
  formatDateShort,
  formatHours,
  formatWeekRange,
  mondayOf,
  pluralize,
} from "@/components/format";
import { INTENSITY_LABEL, intensityLabel } from "@/components/labels";

/**
 * The signature visual. Each week is a column whose bar height is real
 * estimated hours and whose fill is the intensity band. Intensity is never
 * carried by color alone: the bar height, the printed hour count, and a
 * pattern (dots at "busy", hatching at "crunch") all say the same thing.
 */
export function HeatmapPanel({
  loading,
  error,
  weeks,
  term,
  courses,
  assessments,
  accents,
  onRetry,
}: {
  loading: boolean;
  error?: { error: string; detail?: string };
  weeks: WeekLoad[];
  /**
   * The window the weeks are numbered from. Undefined from a server that has
   * not shipped it yet, null when nothing could be resolved -- both fall back
   * to the plain week count.
   */
  term?: SemesterPlan["term"];
  courses: Course[];
  assessments: Assessment[];
  accents: Record<string, string>;
  onRetry: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);

  const courseById = useMemo(
    () => new Map(courses.map((course) => [course.id, course])),
    [courses],
  );
  const assessmentById = useMemo(
    () => new Map(assessments.map((item) => [item.id, item])),
    [assessments],
  );

  const currentWeek = mondayOf(new Date());
  const peak = Math.max(1, ...weeks.map((week) => week.estimatedHours));

  const activeWeek =
    weeks.find((week) => week.weekStart === selected) ??
    weeks.find((week) => week.weekStart === currentWeek) ??
    weeks[0];

  const warnedCount = weeks.filter((week) => week.warning).length;

  // "October 5th isn't week 1" -- a real student, looking at a heatmap numbered
  // from their first deadline. The numbering is only meaningful next to where
  // it came from, so the subtitle now says so, and says when it is a guess.
  const termLabel = courses
    .map((course) => course.term)
    .find((label): label is string => Boolean(label && label.trim()));
  const subtitle = describeTerm(term, weeks, termLabel);

  return (
    <Panel
      id="heatmap"
      title="Workload heatmap"
      icon={<GridIcon width={17} height={17} />}
      description={
        subtitle ? (
          subtitle.uncertain ? (
            <span className="flex items-start gap-1.5">
              <InfoIcon className="mt-0.5 shrink-0" width={13} height={13} />
              <span>{subtitle.text}</span>
            </span>
          ) : (
            subtitle.text
          )
        ) : weeks.length > 0 ? (
          `${pluralize(weeks.length, "week")} of the semester, scored by estimated hours.`
        ) : (
          "Week-by-week workload across every course."
        )
      }
      action={
        warnedCount > 0 ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-warn-line bg-warn-soft px-2.5 py-1 text-[0.75rem] font-medium text-warn">
            <AlertIcon width={13} height={13} />
            {pluralize(warnedCount, "heavy week")}
          </span>
        ) : null
      }
    >
      {loading ? (
        <LoadingRegion label="Loading the workload heatmap">
          <SkeletonStrip />
        </LoadingRegion>
      ) : error ? (
        <ErrorState error={error.error} detail={error.detail} onRetry={onRetry} />
      ) : weeks.length === 0 ? (
        <EmptyState
          icon={<GridIcon width={22} height={22} />}
          title="No semester to map yet"
          body="Once a syllabus is uploaded, every week gets scored so you can see the heavy stretches coming."
        />
      ) : (
        <div className="space-y-4">
          <div className="-mx-1 overflow-x-auto px-1 pb-1">
            <ul
              className="flex min-w-max gap-1.5 sm:min-w-0"
              aria-label="Semester weeks by workload"
            >
              {weeks.map((week) => {
                const isSelected = activeWeek?.weekStart === week.weekStart;
                const isCurrent = week.weekStart === currentWeek;
                const height = Math.max(
                  8,
                  Math.round((week.estimatedHours / peak) * 100),
                );
                const pattern =
                  week.intensity === 3
                    ? "hatch"
                    : week.intensity === 2
                      ? "dotted"
                      : "";
                return (
                  <li key={week.weekStart} className="min-w-9 flex-1 sm:min-w-0">
                    <button
                      type="button"
                      onClick={() =>
                        setSelected(isSelected ? null : week.weekStart)
                      }
                      onMouseEnter={() => setSelected(week.weekStart)}
                      onFocus={() => setSelected(week.weekStart)}
                      aria-pressed={isSelected}
                      aria-label={`Week ${week.weekNumber}, ${formatWeekRange(
                        week.weekStart,
                      )}. ${intensityLabel(week.intensity)}, about ${formatHours(
                        week.estimatedHours,
                      )}.${week.warning ? ` Warning: ${week.warning}.` : ""}`}
                      className={`group flex w-full flex-col items-center gap-1 rounded-md p-1 transition-colors ${
                        isSelected ? "bg-raised" : "hover:bg-raised"
                      }`}
                    >
                      <span
                        className={`relative flex h-24 w-full items-end overflow-hidden rounded-md border bg-track sm:h-28 ${
                          isCurrent
                            ? "border-accent"
                            : isSelected
                              ? "border-line-strong"
                              : "border-transparent"
                        }`}
                      >
                        <span
                          className={`w-full rounded-[5px] transition-[height] duration-200 ${pattern}`}
                          style={{
                            height: `${height}%`,
                            backgroundColor: `var(--color-load-${week.intensity})`,
                          }}
                        />
                        {week.warning ? (
                          <span
                            aria-hidden="true"
                            className="absolute top-1 right-1 text-danger"
                          >
                            <AlertIcon width={11} height={11} strokeWidth={2.4} />
                          </span>
                        ) : null}
                      </span>
                      <span className="font-mono text-[0.6875rem] leading-none font-medium text-ink-soft tabular-nums">
                        {week.weekNumber}
                      </span>
                      <span className="font-mono text-[0.625rem] leading-none text-muted tabular-nums">
                        {Math.round(week.estimatedHours)}h
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          <Legend />

          {activeWeek ? (
            <WeekDetail
              week={activeWeek}
              isCurrent={activeWeek.weekStart === currentWeek}
              items={activeWeek.assessmentIds
                .map((id) => assessmentById.get(id))
                .filter((item): item is Assessment => Boolean(item))}
              courseById={courseById}
              accents={accents}
            />
          ) : null}
        </div>
      )}
    </Panel>
  );
}

function Legend() {
  const patterns = ["", "", "dotted", "hatch"];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-3">
      <span className="text-[0.6875rem] font-semibold tracking-[0.12em] text-muted uppercase">
        Legend
      </span>
      {INTENSITY_LABEL.map((label, index) => (
        <span
          key={label}
          className="inline-flex items-center gap-1.5 text-[0.75rem] text-ink-soft"
        >
          <span
            aria-hidden="true"
            className={`h-3 w-5 rounded-sm ${patterns[index]}`}
            style={{ backgroundColor: `var(--color-load-${index})` }}
          />
          {label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5 text-[0.75rem] text-ink-soft">
        <span aria-hidden="true" className="text-danger">
          <AlertIcon width={12} height={12} strokeWidth={2.4} />
        </span>
        Has a warning
      </span>
    </div>
  );
}

function WeekDetail({
  week,
  isCurrent,
  items,
  courseById,
  accents,
}: {
  week: WeekLoad;
  isCurrent: boolean;
  items: Assessment[];
  courseById: Map<string, Course>;
  accents: Record<string, string>;
}) {
  const split = splitHours(week);

  return (
    <div
      aria-live="polite"
      className="rounded-lg border border-line bg-sunken/60 p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-[1rem] leading-tight text-ink">
          Week {week.weekNumber}
          <span className="ml-2 font-sans text-[0.8125rem] font-normal text-muted">
            {formatWeekRange(week.weekStart)}
          </span>
          {isCurrent ? (
            <span className="ml-2 rounded-full border border-accent-line bg-accent-soft px-2 py-0.5 align-middle font-sans text-[0.6875rem] font-medium text-accent">
              This week
            </span>
          ) : null}
        </h3>
        <p className="flex items-center gap-2 text-[0.8125rem] text-ink-soft">
          <span
            aria-hidden="true"
            className={`inline-block h-3 w-3 rounded-sm ${
              week.intensity === 3 ? "hatch" : week.intensity === 2 ? "dotted" : ""
            }`}
            style={{ backgroundColor: `var(--color-load-${week.intensity})` }}
          />
          <span className="font-medium text-ink">
            {intensityLabel(week.intensity)}
          </span>
          · about {formatHours(week.estimatedHours)}
          {split ? <span className="text-muted"> · {split}</span> : null}
        </p>
      </div>

      {week.warning ? (
        <p className="mt-3 flex items-start gap-2 rounded-md border border-warn-line bg-warn-soft px-3 py-2 text-[0.8125rem] leading-relaxed text-ink">
          <span className="mt-0.5 shrink-0 text-warn">
            <AlertIcon width={14} height={14} />
          </span>
          {week.warning}
        </p>
      ) : null}

      {items.length > 0 ? (
        <ul className="mt-1 divide-y divide-line">
          {items.map((assessment) => (
            <AssessmentRow
              key={assessment.id}
              assessment={assessment}
              courseCode={courseById.get(assessment.courseId)?.code ?? "Course"}
              color={accentFor(accents, assessment.courseId)}
              showRelative={false}
            />
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-[0.8125rem] text-muted">
          Nothing is due this week. A good one to get ahead in.
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * "8h study, 2h due" -- the two halves of the total, so a heavy week with no
 * deadline in it stops looking like a mistake.
 *
 * The halves arrived in the plan after the totals did, so a server one deploy
 * behind sends neither. The total on its own is still true, so that case simply
 * renders as it always did rather than printing "0h study, 0h due".
 */
function splitHours(week: WeekLoad): string | null {
  const study = week.studyHours;
  const due = week.dueHours;
  if (typeof study !== "number" || typeof due !== "number") return null;
  if (study <= 0 && due <= 0) return null;
  return `${round(study)}h study, ${round(due)}h due`;
}

/**
 * `formatHours`' rounding rule, without its unit. Whole hours would print
 * "5 hrs · 5h study, 1h due" for a 5.3-hour week -- a breakdown that visibly
 * does not add up reads as a bug, so the halves keep the total's precision.
 */
function round(hours: number): number {
  return hours < 10 ? Math.round(hours * 10) / 10 : Math.round(hours);
}

/**
 * Says where week 1 came from, and how much to trust it.
 *
 * Returns null when there is no term to describe -- an old server that does not
 * send one, or a plan that could not resolve one -- and the panel falls back to
 * the plain week count it always showed.
 */
function describeTerm(
  term: SemesterPlan["term"] | undefined,
  weeks: WeekLoad[],
  courseTerm: string | undefined,
): { text: string; uncertain: boolean } | null {
  if (!term || weeks.length === 0) return null;

  const last = weeks[weeks.length - 1]?.weekNumber ?? weeks.length;
  const span = last > 1 ? `Weeks 1–${last}` : "Week 1";
  const dates = `${formatDateShort(term.start)} – ${formatDateShort(term.end)}`;

  if (term.source === "syllabus") {
    return { text: `${span} · ${dates}, from your syllabus`, uncertain: false };
  }

  if (term.source === "inferred") {
    // The label is the course's own term string ("Fall 2026"); naming it is the
    // difference between an estimate the student can check and a bare claim.
    const from = courseTerm
      ? `estimated from “${courseTerm}”`
      : "estimated from your course dates";
    return {
      text: `${span} · ${dates}, ${from} — your syllabus didn’t state term dates`,
      uncertain: true,
    };
  }

  return {
    text: `${span} · anchored to your first deadline — no term dates or label found`,
    uncertain: false,
  };
}
