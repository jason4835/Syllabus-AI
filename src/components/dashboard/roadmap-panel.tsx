"use client";

import { useEffect, useId, useMemo, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import type { Assessment, AssessmentKind, Course } from "@/lib/types";
import { needsReview } from "@/lib/types";
import { apiPost } from "@/components/api-client";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Button, Spinner } from "@/components/ui/button";
import { CheckIcon, RouteIcon, UploadIcon } from "@/components/icons";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { LoadingRegion, SkeletonRows } from "@/components/ui/skeleton";
import {
  AssessmentRow,
  FORM_INPUT,
  FormField,
} from "@/components/dashboard/assessment-row";
import { CourseEditor } from "@/components/dashboard/course-editor";
import { KIND_LABEL } from "@/components/labels";
import { accentFor } from "@/components/course-accents";
import {
  formatPercent,
  formatWeekRange,
  mondayOf,
  pluralize,
} from "@/components/format";

const KINDS = Object.keys(KIND_LABEL) as AssessmentKind[];

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
  onAssessmentAdded,
  onAssessmentDeleted,
  onCourseChanged,
  editingCourseId = null,
  editFocusField = "code",
  onEditCourse,
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
  /** A hand-typed item the extractor missed, straight from the server. */
  onAssessmentAdded?: (added: Assessment) => void;
  onAssessmentDeleted?: (id: string) => void;
  onCourseChanged?: (updated: Course) => void;
  /**
   * Which course is open in the editor. Controlled by the shell so the
   * heatmap's "Set term dates" can open the same form from another panel.
   */
  editingCourseId?: string | null;
  editFocusField?: "code" | "startDate";
  onEditCourse?: (courseId: string | null) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [adding, setAdding] = useState<string | null>(null);

  /**
   * The editor can be opened from the heatmap, a whole panel away, so an
   * unexplained state change up there has to move the page down here.
   */
  useEffect(() => {
    if (!editingCourseId) return;
    document
      .getElementById(`roadmap-card-${editingCourseId}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [editingCourseId]);

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
            // Every affordance below needs somewhere to put its result; without
            // a listener the control would change the server and not the page.
            const editable =
              typeof onCourseChanged === "function" &&
              typeof onEditCourse === "function";
            const canAdd = typeof onAssessmentAdded === "function";

            return (
              <article
                key={course.id}
                id={`roadmap-card-${course.id}`}
                className="overflow-hidden rounded-lg border border-line"
                style={{ borderLeft: `3px solid ${color}` }}
              >
                {editable && editingCourseId === course.id ? (
                  <div className="bg-raised p-2 sm:p-3">
                    <CourseEditor
                      course={course}
                      color={color}
                      focusField={editFocusField}
                      onSaved={(updated) => {
                        onCourseChanged?.(updated);
                        onEditCourse?.(null);
                      }}
                      onCancel={() => onEditCourse?.(null)}
                    />
                  </div>
                ) : (
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
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  {editable ? (
                    <button
                      type="button"
                      onClick={() => onEditCourse?.(course.id)}
                      className="rounded-md px-1.5 py-1 text-[0.75rem] font-medium text-muted transition-colors hover:bg-surface hover:text-ink"
                    >
                      Edit course
                    </button>
                  ) : null}
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
                  </div>
                </header>
                )}

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
                                  onDeleted={onAssessmentDeleted}
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
                                  onDeleted={onAssessmentDeleted}
                                />
                              ))}
                            </ul>
                          </li>
                        ) : null}
                      </ol>
                    )}

                    {/* At the end of the list, where you notice something is
                        missing from it. */}
                    {canAdd ? (
                      adding === course.id ? (
                        <div className="mt-3">
                          <AddItemForm
                            course={course}
                            color={color}
                            onAdded={(added) => {
                              onAssessmentAdded?.(added);
                              setAdding(null);
                            }}
                            onCancel={() => setAdding(null)}
                          />
                        </div>
                      ) : (
                        <div className="mt-2 border-t border-line pt-2">
                          <button
                            type="button"
                            onClick={() => setAdding(course.id)}
                            className="-ml-1.5 rounded-md px-1.5 py-1 text-[0.75rem] font-medium text-muted transition-colors hover:bg-raised hover:text-ink"
                          >
                            + Add item
                          </button>
                        </div>
                      )
                    ) : null}
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

/* -------------------------------------------------------------------------- */
/* Add item                                                                   */
/* -------------------------------------------------------------------------- */

interface AddDraft {
  title: string;
  kind: AssessmentKind;
  dueDate: string;
  dueTime: string;
  weightPercent: string;
}

const EMPTY_DRAFT: AddDraft = {
  title: "",
  kind: "assignment",
  dueDate: "",
  dueTime: "",
  weightPercent: "",
};

/**
 * The extractor misses things -- a deadline announced in class, an item buried
 * in prose. This is the smallest form that can add one: the same five fields
 * the row editor shows, minus the notes nobody types on the way in.
 */
function AddItemForm({
  course,
  color,
  onAdded,
  onCancel,
}: {
  course: Course;
  color: string;
  onAdded: (added: Assessment) => void;
  onCancel: () => void;
}) {
  const fieldId = useId();
  const [draft, setDraft] = useState<AddDraft>(EMPTY_DRAFT);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function patch(field: keyof AddDraft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = draft.title.trim();
    if (title.length === 0) {
      setError("Give this item a title.");
      return;
    }
    const rawWeight = draft.weightPercent.trim();
    let weightPercent: number | null = null;
    if (rawWeight.length > 0) {
      const parsed = Number(rawWeight);
      if (!Number.isFinite(parsed)) {
        setError("Weight must be a number between 0 and 100.");
        return;
      }
      weightPercent = parsed;
    }

    setPending(true);
    setError(null);
    const result = await apiPost<Assessment>(
      `/api/courses/${course.id}/assessments`,
      {
        title,
        kind: draft.kind,
        dueDate: draft.dueDate.trim() || null,
        dueTime: draft.dueTime.trim() || null,
        weightPercent,
      },
    );
    setPending(false);
    if (!result.ok) {
      setError(result.detail ?? result.error);
      return;
    }
    setDraft(EMPTY_DRAFT);
    onAdded(result.data);
  }

  function onFormKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onCancel();
  }

  return (
    <form
      noValidate
      onSubmit={(event) => void submit(event)}
      onKeyDown={onFormKeyDown}
      aria-label={`Add an item to ${course.code}`}
      className="rounded-lg border border-line bg-raised p-3"
      style={{ borderLeft: `3px solid ${color}` }}
    >
      <p className="text-[0.75rem] font-semibold tracking-wide text-ink-soft">
        New item · {course.code}
      </p>

      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <FormField
          label="Title"
          htmlFor={`${fieldId}-title`}
          className="sm:col-span-2"
        >
          <input
            id={`${fieldId}-title`}
            type="text"
            autoComplete="off"
            autoFocus
            placeholder="Problem set 4"
            value={draft.title}
            disabled={pending}
            onChange={(event) => patch("title", event.target.value)}
            className={FORM_INPUT}
          />
        </FormField>

        <FormField label="Type" htmlFor={`${fieldId}-kind`}>
          <select
            id={`${fieldId}-kind`}
            value={draft.kind}
            disabled={pending}
            onChange={(event) =>
              patch("kind", event.target.value as AssessmentKind)
            }
            className={FORM_INPUT}
          >
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABEL[kind]}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="Due date" htmlFor={`${fieldId}-date`}>
          <input
            id={`${fieldId}-date`}
            type="date"
            value={draft.dueDate}
            disabled={pending}
            onChange={(event) => patch("dueDate", event.target.value)}
            className={FORM_INPUT}
          />
        </FormField>

        <FormField label="Due time" htmlFor={`${fieldId}-time`}>
          <input
            id={`${fieldId}-time`}
            type="time"
            value={draft.dueTime}
            disabled={pending}
            onChange={(event) => patch("dueTime", event.target.value)}
            className={FORM_INPUT}
          />
        </FormField>

        <FormField label="Weight (% of grade)" htmlFor={`${fieldId}-weight`}>
          <input
            id={`${fieldId}-weight`}
            type="number"
            inputMode="decimal"
            min={0}
            max={100}
            step="any"
            placeholder="—"
            value={draft.weightPercent}
            disabled={pending}
            onChange={(event) => patch("weightPercent", event.target.value)}
            className={FORM_INPUT}
          />
        </FormField>
      </div>

      {error ? (
        <p
          role="alert"
          className="mt-3 rounded-md border border-danger-line bg-danger-soft px-2.5 py-1.5 text-[0.75rem] leading-relaxed text-danger"
        >
          {error}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? (
            <Spinner label="Adding" />
          ) : (
            <CheckIcon width={14} height={14} />
          )}
          Add item
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <span className="text-[0.6875rem] text-muted">Esc to cancel</span>
      </div>
    </form>
  );
}
