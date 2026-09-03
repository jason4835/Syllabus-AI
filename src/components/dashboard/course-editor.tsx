"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import type { Course } from "@/lib/types";
import { apiPatch } from "@/components/api-client";
import { Button, Spinner } from "@/components/ui/button";
import { CheckIcon } from "@/components/icons";
import {
  FORM_INPUT,
  FormField,
} from "@/components/dashboard/assessment-row";

/** Exactly the fields `PATCH /api/courses/[id]` accepts. */
interface CoursePatch {
  code?: string;
  title?: string;
  instructor?: string | null;
  term?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}

/** Form state is all strings — an empty optional field means "clear it". */
interface Draft {
  code: string;
  title: string;
  instructor: string;
  term: string;
  startDate: string;
  endDate: string;
}

function toDraft(course: Course): Draft {
  return {
    code: course.code,
    title: course.title,
    instructor: course.instructor ?? "",
    term: course.term ?? "",
    startDate: course.startDate ?? "",
    endDate: course.endDate ?? "",
  };
}

/**
 * Only what changed goes over the wire. The heatmap numbers its weeks from the
 * term window, so sending an untouched `startDate` back would look like the
 * student stated a date they only looked at.
 */
function buildPatch(
  course: Course,
  draft: Draft,
): { patch: CoursePatch } | { error: string } {
  const patch: CoursePatch = {};

  const code = draft.code.trim();
  if (code.length === 0) return { error: "Give this course a code." };
  if (code !== course.code) patch.code = code;

  const title = draft.title.trim();
  if (title.length === 0) return { error: "Give this course a title." };
  if (title !== course.title) patch.title = title;

  const instructor = draft.instructor.trim() || null;
  if (instructor !== course.instructor) patch.instructor = instructor;

  const term = draft.term.trim() || null;
  if (term !== course.term) patch.term = term;

  const startDate = draft.startDate.trim() || null;
  const endDate = draft.endDate.trim() || null;
  if (startDate && endDate && endDate < startDate) {
    return { error: "The end date cannot come before the start date." };
  }
  if (startDate !== course.startDate) patch.startDate = startDate;
  if (endDate !== course.endDate) patch.endDate = endDate;

  return { patch };
}

export function CourseEditor({
  course,
  color,
  focusField = "code",
  onSaved,
  onCancel,
}: {
  course: Course;
  /** The course's accent, so the form reads as part of its card. */
  color: string;
  /** Where the cursor lands — the heatmap's "Set term dates" aims at the dates. */
  focusField?: "code" | "startDate";
  onSaved: (updated: Course) => void;
  onCancel: () => void;
}) {
  const fieldId = useId();
  const [draft, setDraft] = useState<Draft>(() => toDraft(course));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const startRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusField === "startDate") startRef.current?.focus();
    else codeRef.current?.focus();
  }, [focusField]);

  function patch(field: keyof Draft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const built = buildPatch(course, draft);
    if ("error" in built) {
      setError(built.error);
      return;
    }
    // Nothing edited: close quietly rather than spend a round trip saying so.
    if (Object.keys(built.patch).length === 0) {
      onCancel();
      return;
    }
    setPending(true);
    setError(null);
    const result = await apiPatch<Course>(
      `/api/courses/${course.id}`,
      built.patch,
    );
    setPending(false);
    if (!result.ok) {
      // A 422 names the offending field in `detail`; that is the useful half.
      setError(result.detail ?? result.error);
      return;
    }
    onSaved(result.data);
  }

  function onFormKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onCancel();
  }

  return (
    <form
      noValidate
      onSubmit={(event) => void save(event)}
      onKeyDown={onFormKeyDown}
      aria-label={`Edit ${course.code}`}
      className="rounded-lg border border-line bg-raised p-3 sm:p-4"
      style={{ borderLeft: `3px solid ${color}` }}
    >
      <p className="text-[0.75rem] font-semibold tracking-wide text-ink-soft">
        Course details
      </p>

      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <FormField label="Code" htmlFor={`${fieldId}-code`}>
          <input
            ref={codeRef}
            id={`${fieldId}-code`}
            type="text"
            autoComplete="off"
            value={draft.code}
            disabled={pending}
            onChange={(event) => patch("code", event.target.value)}
            className={FORM_INPUT}
          />
        </FormField>

        <FormField label="Title" htmlFor={`${fieldId}-title`}>
          <input
            id={`${fieldId}-title`}
            type="text"
            autoComplete="off"
            value={draft.title}
            disabled={pending}
            onChange={(event) => patch("title", event.target.value)}
            className={FORM_INPUT}
          />
        </FormField>

        <FormField
          label="Instructor"
          htmlFor={`${fieldId}-instructor`}
          onClear={draft.instructor ? () => patch("instructor", "") : undefined}
          clearLabel={`Clear the instructor for ${course.code}`}
        >
          <input
            id={`${fieldId}-instructor`}
            type="text"
            autoComplete="off"
            placeholder="—"
            value={draft.instructor}
            disabled={pending}
            onChange={(event) => patch("instructor", event.target.value)}
            className={FORM_INPUT}
          />
        </FormField>

        <FormField
          label="Term"
          htmlFor={`${fieldId}-term`}
          onClear={draft.term ? () => patch("term", "") : undefined}
          clearLabel={`Clear the term for ${course.code}`}
        >
          <input
            id={`${fieldId}-term`}
            type="text"
            autoComplete="off"
            placeholder="Fall 2026"
            value={draft.term}
            disabled={pending}
            onChange={(event) => patch("term", event.target.value)}
            className={FORM_INPUT}
          />
        </FormField>

        <FormField
          label="Term starts"
          htmlFor={`${fieldId}-start`}
          onClear={draft.startDate ? () => patch("startDate", "") : undefined}
          clearLabel={`Clear the start date for ${course.code}`}
        >
          <input
            ref={startRef}
            id={`${fieldId}-start`}
            type="date"
            value={draft.startDate}
            disabled={pending}
            onChange={(event) => patch("startDate", event.target.value)}
            className={FORM_INPUT}
          />
        </FormField>

        <FormField
          label="Term ends"
          htmlFor={`${fieldId}-end`}
          onClear={draft.endDate ? () => patch("endDate", "") : undefined}
          clearLabel={`Clear the end date for ${course.code}`}
        >
          <input
            id={`${fieldId}-end`}
            type="date"
            value={draft.endDate}
            disabled={pending}
            onChange={(event) => patch("endDate", event.target.value)}
            className={FORM_INPUT}
          />
        </FormField>
      </div>

      <p className="mt-2 text-[0.75rem] leading-relaxed text-muted">
        Week 1 of the heatmap is the week containing the start date — set these
        and the semester is numbered from your syllabus rather than a guess.
      </p>

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
            <Spinner label="Saving" />
          ) : (
            <CheckIcon width={14} height={14} />
          )}
          Save
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
