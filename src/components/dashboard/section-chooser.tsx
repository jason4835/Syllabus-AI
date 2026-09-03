"use client";

import { useId, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import type { Course, MeetingTime } from "@/lib/types";
import { apiPatch } from "@/components/api-client";
import { Button, Spinner } from "@/components/ui/button";
import { CheckIcon } from "@/components/icons";
import { meetingKindLabel } from "@/components/labels";
import { formatTime } from "@/components/format";

const DAY_LETTERS = ["Su", "M", "T", "W", "Th", "F", "Sa"];

/* -------------------------------------------------------------------------- */
/* Reading a course's sections                                                */
/* -------------------------------------------------------------------------- */

/**
 * The distinct section labels this syllabus names, in the order the syllabus
 * listed them. Whitespace-only labels are not sections -- they are noise from
 * the extractor, and counting them would ask a student to pick between "A" and
 * nothing at all.
 */
export function sectionLabels(course: Course): string[] {
  const labels: string[] = [];
  for (const meeting of course.meetingTimes ?? []) {
    const label = meeting.section?.trim();
    if (!label) continue;
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

/**
 * Does this course still need an answer? Several sections on the page and none
 * of them chosen. While that is true nothing section-specific is synced,
 * because guessing puts the student in someone else's classroom.
 */
export function needsSection(course: Course): boolean {
  return sectionLabels(course).length >= 2 && (course.section ?? null) === null;
}

/** The meetings that belong to one section label. */
export function meetingsForSection(
  course: Course,
  section: string,
): MeetingTime[] {
  return (course.meetingTimes ?? []).filter(
    (meeting) => meeting.section?.trim() === section,
  );
}

/**
 * What this student actually attends: their own section's meetings plus the
 * ones that apply to everyone (office hours, usually). Meetings belonging to
 * some other section are not theirs and never appear.
 */
export function meetingsForStudent(course: Course): MeetingTime[] {
  const chosen = course.section?.trim() ?? null;
  return (course.meetingTimes ?? []).filter((meeting) => {
    const section = meeting.section?.trim() || null;
    return section === null || section === chosen;
  });
}

/* -------------------------------------------------------------------------- */
/* Formatting one meeting                                                     */
/* -------------------------------------------------------------------------- */

/** [1,3] -> "MW" */
export function formatDays(days: number[] | null | undefined): string {
  return [...(days ?? [])]
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((a, b) => a - b)
    .map((day) => DAY_LETTERS[day])
    .join("");
}

/**
 * "8:00–9:50 AM" -- one meridiem when both ends share it, which is nearly
 * always, and is how a timetable is read aloud.
 */
export function formatSpan(start: string, end: string): string {
  const from = formatTime(start);
  const to = formatTime(end);
  if (!from || !to) return from ?? to ?? "";
  const suffix = from.slice(-2);
  if (suffix === to.slice(-2)) return `${from.slice(0, -3)}–${to}`;
  return `${from}–${to}`;
}

/** "MW 8:00–9:50 AM · 2MTC 907 · Prof. Lee" */
export function meetingSummary(meeting: MeetingTime): string {
  const when = [formatDays(meeting.daysOfWeek), formatSpan(meeting.startTime, meeting.endTime)]
    .filter(Boolean)
    .join(" ");
  return [when, meeting.location, meeting.instructor]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" · ");
}

/** The same line with its kind in front: "recitation T 3:00–3:50 PM". */
export function meetingSummaryWithKind(meeting: MeetingTime): string {
  const summary = meetingSummary(meeting);
  const kind = meetingKindLabel(meeting.kind).toLowerCase();
  return summary ? `${kind} ${summary}` : kind;
}

/* -------------------------------------------------------------------------- */
/* The chooser                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One question, asked where the student is already looking at the course. It
 * is deliberately warm rather than alarming: nothing is broken, the syllabus
 * simply describes more classes than the student takes.
 */
export function SectionChooser({
  course,
  onChanged,
  onCancel,
}: {
  course: Course;
  /** The saved course, straight from the server. */
  onChanged: (updated: Course) => void;
  /** Present only when the chooser was opened to change an answer. */
  onCancel?: () => void;
}) {
  const groupName = useId();
  const labels = sectionLabels(course);
  const [choice, setChoice] = useState<string | null>(
    course.section?.trim() ?? null,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!choice) {
      setError("Pick the section you are enrolled in.");
      return;
    }
    if (choice === (course.section?.trim() ?? null)) {
      onCancel?.();
      return;
    }
    setPending(true);
    setError(null);
    const result = await apiPatch<Course>(`/api/courses/${course.id}`, {
      section: choice,
    });
    setPending(false);
    if (!result.ok) {
      setError(result.detail ?? result.error);
      return;
    }
    // A server that does not echo the whole course back yet still told us the
    // save landed; the one field we changed is enough to move the page on.
    const saved = result.data;
    const updated: Course =
      saved && typeof saved === "object" && typeof saved.id === "string"
        ? saved
        : { ...course, section: choice };
    onChanged(updated);
  }

  function onFormKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key !== "Escape" || !onCancel) return;
    event.stopPropagation();
    onCancel();
  }

  return (
    <form
      noValidate
      id={`section-chooser-${course.id}`}
      onSubmit={(event) => void save(event)}
      onKeyDown={onFormKeyDown}
      aria-label={`Choose your section for ${course.code}`}
      className="rise scroll-mt-24 rounded-lg border border-warn-line bg-warn-soft p-3.5"
    >
      <fieldset className="min-w-0">
        <legend className="text-[0.875rem] font-semibold text-ink">
          Which section are you in?
        </legend>
        <p className="mt-1 text-[0.8125rem] leading-relaxed text-ink-soft">
          This syllabus lists {labels.length} sections — we won&rsquo;t add
          class meetings until you pick yours.
        </p>

        <div className="mt-3 space-y-1.5">
          {labels.map((label) => {
            const meetings = meetingsForSection(course, label);
            const selected = choice === label;
            return (
              <label
                key={label}
                className={`flex cursor-pointer items-start gap-2.5 rounded-md border px-2.5 py-2 transition-colors ${
                  selected
                    ? "border-accent-line bg-surface"
                    : "border-transparent hover:bg-surface/70"
                }`}
              >
                <input
                  type="radio"
                  name={groupName}
                  value={label}
                  checked={selected}
                  disabled={pending}
                  onChange={() => {
                    setChoice(label);
                    setError(null);
                  }}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[color:var(--color-accent)]"
                />
                <span className="min-w-0">
                  <span className="block text-[0.8125rem] font-medium text-ink">
                    {label}
                  </span>
                  {meetings.map((meeting, index) => (
                    <span
                      key={`${label}-${index}`}
                      className="block text-[0.75rem] leading-snug text-muted"
                    >
                      {meeting.kind === "lecture"
                        ? meetingSummary(meeting)
                        : meetingSummaryWithKind(meeting)}
                    </span>
                  ))}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

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
            <Spinner label="Saving your section" />
          ) : (
            <CheckIcon width={14} height={14} />
          )}
          Save section
        </Button>
        {onCancel ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={onCancel}
          >
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
