"use client";

import { useMemo, useState } from "react";
import type { Assessment, Course } from "@/lib/types";
import { needsReview } from "@/lib/types";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { RouteIcon, UploadIcon } from "@/components/icons";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { LoadingRegion, SkeletonRows } from "@/components/ui/skeleton";
import { AssessmentRow } from "@/components/dashboard/assessment-row";
import { accentFor } from "@/components/course-accents";
import {
  formatPercent,
  formatWeekRange,
  mondayOf,
  pluralize,
} from "@/components/format";

interface WeekGroup {
  weekStart: string;
  items: Assessment[];
}

function groupByWeek(items: Assessment[]): {
  weeks: WeekGroup[];
  undated: Assessment[];
} {
  const buckets = new Map<string, Assessment[]>();
  const undated: Assessment[] = [];

  for (const item of items) {
    const monday = mondayOf(item.dueDate);
    if (!monday) {
      undated.push(item);
      continue;
    }
    const bucket = buckets.get(monday);
    if (bucket) bucket.push(item);
    else buckets.set(monday, [item]);
  }

  const weeks = [...buckets.entries()]
    .map(([weekStart, weekItems]) => ({
      weekStart,
      items: weekItems.sort((a, b) =>
        (a.dueDate ?? "").localeCompare(b.dueDate ?? ""),
      ),
    }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));

  return { weeks, undated };
}

export function RoadmapPanel({
  loading,
  error,
  courses,
  assessments,
  accents,
  coursePages = {},
  onRetry,
  onAssessmentChanged,
}: {
  loading: boolean;
  error?: { error: string; detail?: string };
  courses: Course[];
  assessments: Assessment[];
  accents: Record<string, string>;
  /** courseId -> Notion page URL, from the Notion status the shell holds. */
  coursePages?: Record<string, string>;
  onRetry: () => void;
  /** Hand a confirmed or edited item back to the shell. */
  onAssessmentChanged?: (updated: Assessment) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const byCourse = useMemo(() => {
    const map = new Map<string, Assessment[]>();
    for (const item of assessments) {
      const bucket = map.get(item.courseId);
      if (bucket) bucket.push(item);
      else map.set(item.courseId, [item]);
    }
    return map;
  }, [assessments]);

  return (
    <Panel
      id="roadmap"
      title="Semester roadmap"
      icon={<RouteIcon width={17} height={17} />}
      description="Every course, with its work laid out week by week."
    >
      {loading ? (
        <LoadingRegion label="Loading your roadmap">
          <SkeletonRows rows={5} />
        </LoadingRegion>
      ) : error ? (
        <ErrorState error={error.error} detail={error.detail} onRetry={onRetry} />
      ) : courses.length === 0 ? (
        <EmptyState
          icon={<UploadIcon width={22} height={22} />}
          title="No courses yet"
          body="Upload a syllabus and its course, deadlines and grading breakdown appear here as a roadmap."
        />
      ) : (
        <div className="space-y-5">
          {courses.map((course) => {
            const color = accentFor(accents, course.id);
            const items = byCourse.get(course.id) ?? [];
            const { weeks, undated } = groupByWeek(items);
            const isCollapsed = collapsed[course.id] === true;
            const unreviewed = items.filter(needsReview).length;
            const bodyId = `roadmap-course-${course.id}`;
            const notionUrl = coursePages[course.id];

            return (
              <article
                key={course.id}
                className="overflow-hidden rounded-lg border border-line"
                style={{ borderLeft: `3px solid ${color}` }}
              >
                <header className="flex flex-wrap items-start justify-between gap-3 bg-raised px-4 py-3">
                  <div className="min-w-0">
                    <h3 className="flex flex-wrap items-baseline gap-x-2 text-[1rem] leading-tight text-ink">
                      <span
                        className="font-mono text-[0.8125rem] font-semibold tracking-wide"
                        style={{ color }}
                      >
                        {course.code}
                      </span>
                      {course.title}
                    </h3>
                    <p className="mt-0.5 text-[0.8125rem] text-muted">
                      {[
                        course.instructor,
                        course.term,
                        pluralize(items.length, "item"),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    {/* Counts down as items are confirmed, then disappears. */}
                    {unreviewed > 0 ? (
                      <p className="mt-1.5">
                        <Badge tone="warn">
                          {unreviewed} need{unreviewed === 1 ? "s" : ""} review
                        </Badge>
                      </p>
                    ) : null}
                    {/* Only when the course actually has a page — a dead link
                        is worse than no link. */}
                    {notionUrl ? (
                      <a
                        href={notionUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        aria-label={`Open ${course.code} in Notion`}
                        className="mt-1 inline-block rounded-sm text-[0.75rem] text-muted transition-colors hover:text-ink"
                      >
                        Open in Notion ↗
                      </a>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    aria-expanded={!isCollapsed}
                    aria-controls={bodyId}
                    onClick={() =>
                      setCollapsed((current) => ({
                        ...current,
                        [course.id]: !isCollapsed,
                      }))
                    }
                    className="shrink-0 rounded-md border border-line-strong bg-surface px-2.5 py-1 text-[0.75rem] font-medium text-ink-soft transition-colors hover:bg-raised"
                  >
                    {isCollapsed ? "Show" : "Hide"}
                  </button>
                </header>

                {!isCollapsed ? (
                  <div id={bodyId} className="px-4 py-3">
                    {course.gradeWeights.length > 0 ? (
                      <div className="mb-3 flex flex-wrap gap-x-3 gap-y-1.5">
                        {course.gradeWeights.map((row) => (
                          <span
                            key={row.category}
                            className="text-[0.75rem] text-muted"
                          >
                            {row.category}{" "}
                            <span className="font-mono text-ink-soft tabular-nums">
                              {formatPercent(row.weightPercent)}
                            </span>
                          </span>
                        ))}
                      </div>
                    ) : null}

                    {weeks.length === 0 && undated.length === 0 ? (
                      <p className="py-2 text-[0.8125rem] text-muted">
                        No assessments were extracted for this course.
                      </p>
                    ) : (
                      <ol className="space-y-3">
                        {weeks.map((group) => (
                          <li key={group.weekStart}>
                            <h4 className="mb-0.5 flex items-center gap-2 text-[0.6875rem] font-semibold tracking-[0.1em] text-muted uppercase">
                              <span
                                aria-hidden="true"
                                className="h-1.5 w-1.5 rounded-full"
                                style={{ backgroundColor: color }}
                              />
                              Week of {formatWeekRange(group.weekStart)}
                            </h4>
                            <ul className="divide-y divide-line border-l border-line pl-3">
                              {group.items.map((assessment) => (
                                <AssessmentRow
                                  key={assessment.id}
                                  assessment={assessment}
                                  courseCode={course.code}
                                  color={color}
                                  showConfidence
                                  onChanged={onAssessmentChanged}
                                />
                              ))}
                            </ul>
                          </li>
                        ))}
                        {undated.length > 0 ? (
                          <li>
                            <h4 className="mb-0.5 text-[0.6875rem] font-semibold tracking-[0.1em] text-muted uppercase">
                              No date given
                            </h4>
                            <ul className="divide-y divide-line border-l border-dashed border-line-strong pl-3">
                              {undated.map((assessment) => (
                                <AssessmentRow
                                  key={assessment.id}
                                  assessment={assessment}
                                  courseCode={course.code}
                                  color={color}
                                  showRelative={false}
                                  showConfidence
                                  onChanged={onAssessmentChanged}
                                />
                              ))}
                            </ul>
                          </li>
                        ) : null}
                      </ol>
                    )}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
