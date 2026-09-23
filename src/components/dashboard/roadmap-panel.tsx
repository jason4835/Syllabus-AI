"use client";

import { useEffect, useId, useMemo, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import type {
  Assessment,
  AssessmentKind,
  Course,
  NoClassPeriod,
} from "@/lib/types";
import { needsReview } from "@/lib/types";
import { apiDelete, apiPost } from "@/components/api-client";
import type { AppConfig, TermSummary } from "@/components/api-client";
import { useIsNarrow } from "@/components/use-narrow";
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
  endTimeError,
  endTimeHint,
} from "@/components/dashboard/assessment-row";
import { CourseEditor } from "@/components/dashboard/course-editor";
import {
  meetingSummary,
  meetingSummaryWithKind,
  openQuestionWords,
} from "@/components/dashboard/section-chooser";
import { SetupCard } from "@/components/dashboard/setup-card";
import { meetingsForStudent } from "@/lib/sections";
import { KIND_LABEL } from "@/components/labels";
import { accentFor } from "@/components/course-accents";
import {
  formatDateShort,
  formatPercent,
  formatWeekRange,
  mondayOf,
  parseDate,
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
  terms = [],
  config = null,
  coursePages = {},
  onRetry,
  onAssessmentChanged,
  onAssessmentAdded,
  onAssessmentDeleted,
  onCourseChanged,
  onCourseDeleted,
  editingCourseId = null,
  editFocusField = "code",
  onEditCourse,
  onSetupAnswered,
}: {
  loading: boolean;
  error?: { error: string; detail?: string };
  courses: Course[];
  assessments: Assessment[];
  accents: Record<string, string>;
  /**
   * The student's terms. Three things here need them: the course header prints
   * the term's NAME, the editor moves a course between terms, and the setup card
   * asks about a term the upload inferred but nobody has confirmed.
   */
  terms?: TermSummary[];
  /** Passed down for the paywall card only; null while `/api/config` is in flight. */
  config?: AppConfig | null;
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
   * A course removed outright, server and all. Without a listener the control
   * is not offered: deleting a course the page then keeps showing is worse
   * than no delete at all.
   */
  onCourseDeleted?: (courseId: string) => void;
  /**
   * Which course is open in the editor. Controlled by the shell so the
   * heatmap's "Set term dates" can open the same form from another panel.
   */
  editingCourseId?: string | null;
  editFocusField?: "code" | "startDate";
  onEditCourse?: (courseId: string | null) => void;
  /**
   * Re-read courses and items after a setup answer the server acted on beyond
   * the field it was sent — a term start that dates every week-numbered item, a
   * weekly day that creates one item per week. `onCourseChanged` cannot stand
   * in for it: the course it hands back is correct and says nothing about the
   * items that moved underneath it.
   */
  onSetupAnswered?: () => void;
}) {
  /**
   * Per-course open/closed, `undefined` meaning "whatever the viewport implies".
   *
   * On a phone every course being open made this panel about thirteen thousand
   * pixels tall, which pushed Upload and Calendar sync -- the two things a
   * student actually came to do -- roughly sixteen screens below the fold, with
   * no in-page nav to skip them. Open is still right on a wide screen, where
   * the panel sits in a column beside everything else and scanning the term at
   * a glance is the point. So the default follows the viewport, and an explicit
   * tap still wins over it for that course.
   */
  const [collapsed, setCollapsed] = useState<Record<string, boolean | undefined>>({});
  const narrow = useIsNarrow();

  /**
   * Past a couple of courses, open-by-default stops being a scan and becomes a
   * wall -- five courses fully expanded is every week of every class stacked
   * end to end, and the panels a student came for (upload, sync) are somewhere
   * below all of it. So on a wide screen the default flips to collapsed once
   * there are three or more, which keeps the term readable as a list of
   * courses with an open/closed toggle each, and the header offers the whole
   * set in one click for the student who does want it all.
   *
   * Two courses still open by default: side by side they are the comparison
   * the roadmap exists to show.
   */
  const denseDefault = courses.length >= 3;
  const defaultCollapsed = narrow || denseDefault;
  const allOpen = courses.every((c) => (collapsed[c.id] ?? defaultCollapsed) === false);
  const setAll = (value: boolean) =>
    setCollapsed(Object.fromEntries(courses.map((c) => [c.id, value])));
  const [adding, setAdding] = useState<string | null>(null);
  /** The course whose "are you sure?" is open, and the one being deleted. */
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function removeCourse(course: Course) {
    setDeleting(course.id);
    setDeleteError(null);
    const result = await apiDelete<{
      deleted: boolean;
      calendarEventsRemoved: number;
    }>(`/api/courses/${course.id}`);
    setDeleting(null);
    if (!result.ok) {
      setDeleteError(result.detail ?? result.error);
      return;
    }
    setConfirmingDelete(null);
    onCourseDeleted?.(course.id);
  }

  /**
   * The editor can be opened from the heatmap, a whole panel away, so an
   * unexplained state change up there has to move the page down here.
   */
  useEffect(() => {
    if (!editingCourseId) return;
    scrollToElement(
      document.getElementById(`roadmap-card-${editingCourseId}`),
      "center",
    );
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
      action={
        courses.length >= 3 ? (
          <button
            type="button"
            onClick={() => setAll(allOpen)}
            className="rounded-md px-2 py-1 text-[0.8125rem] font-medium text-accent transition-colors hover:bg-raised"
          >
            {allOpen ? "Collapse all" : "Expand all"}
          </button>
        ) : undefined
      }
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
            const isCollapsed = collapsed[course.id] ?? defaultCollapsed;
            const unreviewed = items.filter(needsReview).length;
            const bodyId = `roadmap-course-${course.id}`;
            const notionUrl = coursePages[course.id];
            const termName =
              terms.find((term) => term.id === course.termId)?.name ??
              course.term;
            // Every affordance below needs somewhere to put its result; without
            // a listener the control would change the server and not the page.
            const editable =
              typeof onCourseChanged === "function" &&
              typeof onEditCourse === "function";
            const canAdd = typeof onAssessmentAdded === "function";
            const canDelete = typeof onCourseDeleted === "function";
            /**
             * The setup card is mounted for every course that can be edited,
             * and decides for itself whether it has anything to say. Mounting
             * it on "has an open question" instead would unmount it the instant
             * the last one was answered, taking with it the receipt for the
             * answer and the sentence saying what the answer just did.
             */

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
                      terms={terms}
                      config={config}
                      focusField={editFocusField}
                      onSaved={(updated) => {
                        onCourseChanged?.(updated);
                        onEditCourse?.(null);
                      }}
                      onCancel={() => onEditCourse?.(null)}
                    />
                  </div>
                ) : (
                <header className="bg-raised px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
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
                        /* The term ROW's name, which is what the rest of the
                           dashboard groups this course under. `course.term` is
                           the syllabus's own words and stays as the fallback for
                           a course that has no term row. */
                        termName,
                        pluralize(items.length, "item"),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    <MeetsLine course={course} />
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
                      aria-label={`Edit ${course.code}`}
                      className="rounded-md px-1.5 py-1 text-[0.75rem] font-medium text-muted transition-colors hover:bg-surface hover:text-ink"
                    >
                      Edit course
                    </button>
                  ) : null}
                  {canDelete ? (
                    <button
                      type="button"
                      id={`delete-course-${course.id}`}
                      aria-expanded={confirmingDelete === course.id}
                      aria-controls={`delete-course-confirm-${course.id}`}
                      onClick={() => {
                        setDeleteError(null);
                        setConfirmingDelete(
                          confirmingDelete === course.id ? null : course.id,
                        );
                      }}
                      aria-label={`Delete ${course.code}`}
                      className="rounded-md px-1.5 py-1 text-[0.75rem] font-medium text-muted transition-colors hover:bg-danger-soft hover:text-danger"
                    >
                      Delete
                    </button>
                  ) : null}
                  <button
                    type="button"
                    aria-expanded={!isCollapsed}
                    aria-controls={bodyId}
                    aria-label={`${isCollapsed ? "Show" : "Hide"} ${course.code} items`}
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
                  </div>

                  {/* Inline, like the item delete: the question is asked where
                      the control is, and it names what goes with it. */}
                  {canDelete && confirmingDelete === course.id ? (
                    <div
                      id={`delete-course-confirm-${course.id}`}
                      className="mt-3 rounded-md border border-danger-line bg-danger-soft px-3 py-2.5"
                    >
                      <p className="text-[0.8125rem] leading-relaxed text-ink">
                        Delete{" "}
                        <span className="font-mono text-[0.8125rem]">
                          {course.code}
                        </span>
                        {course.title ? ` — ${course.title}` : ""}? Its{" "}
                        {pluralize(items.length, "item")} go with it, and the
                        events this course put on your Google Calendar are
                        removed too. This cannot be undone.
                      </p>
                      {deleteError ? (
                        <p
                          role="alert"
                          className="mt-2 text-[0.75rem] leading-relaxed text-danger"
                        >
                          That didn&rsquo;t delete — {deleteError}
                        </p>
                      ) : null}
                      <div className="mt-2.5 flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          aria-label={`Yes, delete ${course.code}`}
                          disabled={deleting === course.id}
                          onClick={() => void removeCourse(course)}
                          className="border-danger-line text-danger hover:bg-danger-soft"
                        >
                          {deleting === course.id ? (
                            <Spinner label="Deleting" />
                          ) : null}
                          Delete this course
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label={`Keep ${course.code}`}
                          disabled={deleting === course.id}
                          onClick={() => setConfirmingDelete(null)}
                        >
                          Keep it
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  {editable ? (
                    <SetupCard
                      className="mt-3"
                      course={course}
                      assessments={items}
                      terms={terms}
                      onCourseChanged={(updated) => onCourseChanged?.(updated)}
                      onAnswered={onSetupAnswered}
                    />
                  ) : null}
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
                        No items were extracted for this course.
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

/**
 * Scrolls without animating for anyone who asked not to be animated. A smooth
 * scroll across a long dashboard is exactly the vestibular trigger
 * `prefers-reduced-motion` exists for, and the jump lands in the same place.
 */
function scrollToElement(
  target: Element | null,
  block: ScrollLogicalPosition,
): void {
  if (!target) return;
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  target.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block });
}

/* -------------------------------------------------------------------------- */
/* Add item                                                                   */
/* -------------------------------------------------------------------------- */

interface AddDraft {
  title: string;
  kind: AssessmentKind;
  dueDate: string;
  dueTime: string;
  endTime: string;
  weightPercent: string;
}

const EMPTY_DRAFT: AddDraft = {
  title: "",
  kind: "assignment",
  dueDate: "",
  dueTime: "",
  endTime: "",
  weightPercent: "",
};

/**
 * The extractor misses things -- a deadline announced in class, an item buried
 * in prose. This is the smallest form that can add one: the same fields the row
 * editor shows, minus the notes nobody types on the way in.
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
  const endHint = endTimeHint(draft.kind);

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
    const rangeError = endTimeError(draft.dueTime, draft.endTime);
    if (rangeError) {
      setError(rangeError);
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
        endTime: draft.endTime.trim() || null,
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

        <FormField
          label="End time"
          htmlFor={`${fieldId}-end`}
          hint={endHint}
          onClear={draft.endTime ? () => patch("endTime", "") : undefined}
          clearLabel="Clear the end time"
        >
          <input
            id={`${fieldId}-end`}
            type="time"
            aria-describedby={endHint ? `${fieldId}-end-hint` : undefined}
            value={draft.endTime}
            disabled={pending}
            onChange={(event) => patch("endTime", event.target.value)}
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

/* -------------------------------------------------------------------------- */
/* Meeting pattern + the weeks it doesn't happen                              */
/* -------------------------------------------------------------------------- */

const MS_PER_DAY = 86_400_000;

/**
 * "Sep 7 (Labor Day)", "Nov 25–27 (Thanksgiving)", "after Dec 11".
 *
 * A stretch that runs to the end of the term is the syllabus saying classes
 * stop, not that a two-week holiday is coming — so it is written from the last
 * day that *does* meet, which is the date a student is actually looking for.
 */
function formatNoClass(period: NoClassPeriod, termEnd: string | null): string {
  const start = parseDate(period.start);
  const end = parseDate(period.end);
  const suffix = period.reason ? ` (${period.reason})` : "";
  if (!start) return period.reason ?? "";

  const termLast = parseDate(termEnd);
  const runsToTermEnd =
    end !== null &&
    termLast !== null &&
    end.getTime() > start.getTime() &&
    end.getTime() >= termLast.getTime();
  if (runsToTermEnd) {
    const lastMeeting = new Date(start.getTime() - MS_PER_DAY);
    return `after ${formatDateShort(lastMeeting)}${suffix}`;
  }

  if (!end || end.getTime() === start.getTime()) {
    return `${formatDateShort(start)}${suffix}`;
  }
  // Same month: "Nov 25–27" beats repeating the month for two days apart.
  const sameMonth =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth();
  const range = sameMonth
    ? `${formatDateShort(start)}–${end.getDate()}`
    : `${formatDateShort(start)} – ${formatDateShort(end)}`;
  return `${range}${suffix}`;
}

/**
 * The course's rhythm in one line — when it meets, and when it doesn't.
 *
 * Only this student's meetings: their own section plus whatever applies to
 * everyone. Listing every section here is how the calendar bug read on the
 * page, and a student who has not picked yet is asked rather than shown five
 * schedules and left to work out which is theirs.
 */
function MeetsLine({ course }: { course: Course }) {
  const mine = meetingsForStudent(course);
  const classes = mine.filter((meeting) => meeting.kind !== "office_hours");
  const hours = mine.filter((meeting) => meeting.kind === "office_hours");

  // Names the kinds still open rather than counting labels, because a count
  // reads as one question and this is not one question.
  const open = openQuestionWords(course);
  const choose = open ? `Choose your ${open} below` : "";

  const meets = classes.map(meetingSummaryWithKind).filter(Boolean).join("; ");
  const officeHours = hours.map(meetingSummary).filter(Boolean).join("; ");

  const summaries = (course.noClass ?? [])
    .map((period) => formatNoClass(period, course.endDate))
    .filter(Boolean);
  // Three is what fits on a phone before the line wraps twice; the rest stay
  // one hover away rather than pushing the item list down the page.
  const shown = summaries.slice(0, 3);
  const hidden = summaries.length - shown.length;
  const noClass =
    summaries.length === 0
      ? ""
      : `No class: ${shown.join(", ")}${hidden > 0 ? `, +${hidden} more` : ""}`;

  if (!meets && !noClass && !officeHours && !choose) return null;

  return (
    <>
      {meets || noClass || choose ? (
        <p className="mt-0.5 text-[0.8125rem] leading-snug text-muted">
          {meets ? `Meets ${meets}` : null}
          {meets && choose ? " — " : null}
          {choose ? <span>{choose}</span> : null}
          {(meets || choose) && noClass ? " — " : null}
          {noClass ? (
            <span
              title={hidden > 0 ? `No class: ${summaries.join(", ")}` : undefined}
            >
              {noClass}
            </span>
          ) : null}
        </p>
      ) : null}
      {/* Quieter than the class line on purpose: office hours are an option,
          not an obligation, and they are opt-in on the calendar too. */}
      {officeHours ? (
        <p className="mt-0.5 text-[0.75rem] leading-snug text-muted">
          Office hours {officeHours}
        </p>
      ) : null}
    </>
  );
}
