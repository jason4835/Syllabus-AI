"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import type { Course, MeetingKind, MeetingTime } from "@/lib/types";
import { apiPatch } from "@/components/api-client";
import { Button, Spinner } from "@/components/ui/button";
import { CheckIcon } from "@/components/icons";
import { MEETING_KIND_LABEL } from "@/components/labels";
import {
  FORM_INPUT,
  FORM_LABEL,
  FormField,
} from "@/components/dashboard/assessment-row";

const MEETING_KINDS = Object.keys(MEETING_KIND_LABEL) as MeetingKind[];

/** Sunday-first, the way a timetable is printed. */
const DAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** Exactly the fields `PATCH /api/courses/[id]` accepts. */
interface CoursePatch {
  code?: string;
  title?: string;
  instructor?: string | null;
  term?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  meetingTimes?: MeetingTime[];
}

/** Form state is all strings — an empty optional field means "clear it". */
interface Draft {
  code: string;
  title: string;
  instructor: string;
  term: string;
  startDate: string;
  endDate: string;
  meetings: MeetingDraft[];
}

/**
 * A row of the meeting-times editor. `key` is local bookkeeping: meetings have
 * no id, and using the array index as a React key makes a removed row take the
 * next row's input state with it.
 */
interface MeetingDraft {
  key: string;
  kind: MeetingKind;
  section: string;
  instructor: string;
  days: number[];
  startTime: string;
  endTime: string;
  location: string;
}

let meetingKeySeed = 0;
function nextMeetingKey(): string {
  meetingKeySeed += 1;
  return `meeting-${meetingKeySeed}`;
}

function toMeetingDraft(meeting: MeetingTime): MeetingDraft {
  return {
    key: nextMeetingKey(),
    kind: meeting.kind ?? "lecture",
    section: meeting.section ?? "",
    instructor: meeting.instructor ?? "",
    days: [...(meeting.daysOfWeek ?? [])].filter(
      (day) => Number.isInteger(day) && day >= 0 && day <= 6,
    ),
    startTime: meeting.startTime ?? "",
    endTime: meeting.endTime ?? "",
    location: meeting.location ?? "",
  };
}

function emptyMeetingDraft(): MeetingDraft {
  return {
    key: nextMeetingKey(),
    kind: "lecture",
    section: "",
    instructor: "",
    days: [],
    startTime: "",
    endTime: "",
    location: "",
  };
}

function toMeetingTime(draft: MeetingDraft): MeetingTime {
  return {
    kind: draft.kind,
    section: draft.section.trim() || null,
    instructor: draft.instructor.trim() || null,
    daysOfWeek: [...draft.days].sort((a, b) => a - b),
    startTime: draft.startTime,
    endTime: draft.endTime,
    location: draft.location.trim() || null,
  };
}

/** Same shape, same order, so two arrays can be compared as text. */
function fingerprint(meetings: MeetingTime[]): string {
  return JSON.stringify(
    meetings.map((meeting) => ({
      kind: meeting.kind ?? "lecture",
      section: meeting.section?.trim() || null,
      instructor: meeting.instructor?.trim() || null,
      daysOfWeek: [...(meeting.daysOfWeek ?? [])].sort((a, b) => a - b),
      startTime: meeting.startTime ?? "",
      endTime: meeting.endTime ?? "",
      location: meeting.location?.trim() || null,
    })),
  );
}

function toDraft(course: Course): Draft {
  return {
    code: course.code,
    title: course.title,
    instructor: course.instructor ?? "",
    term: course.term ?? "",
    startDate: course.startDate ?? "",
    endDate: course.endDate ?? "",
    meetings: (course.meetingTimes ?? []).map(toMeetingDraft),
  };
}

/** Per-row complaint, keyed by the row's local key. */
type RowErrors = Record<string, string>;

/**
 * Only what changed goes over the wire. The heatmap numbers its weeks from the
 * term window, so sending an untouched `startDate` back would look like the
 * student stated a date they only looked at.
 */
function buildPatch(
  course: Course,
  draft: Draft,
): { patch: CoursePatch } | { error: string; rows?: RowErrors } {
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

  // A meeting a calendar cannot draw is worse than no meeting at all, so every
  // row has to say which days it happens and when it ends.
  const rows: RowErrors = {};
  for (const meeting of draft.meetings) {
    if (meeting.days.length === 0) {
      rows[meeting.key] = "Pick at least one day.";
      continue;
    }
    if (!meeting.startTime || !meeting.endTime) {
      rows[meeting.key] = "Give this meeting a start and an end time.";
      continue;
    }
    if (meeting.endTime <= meeting.startTime) {
      rows[meeting.key] = "The end time has to come after the start time.";
    }
  }
  if (Object.keys(rows).length > 0) {
    return { error: "Check the meeting times below.", rows };
  }

  const meetingTimes = draft.meetings.map(toMeetingTime);
  if (fingerprint(meetingTimes) !== fingerprint(course.meetingTimes ?? [])) {
    // The route takes the whole array: a meeting is only identified by its
    // position, so a partial list would read as a deletion.
    patch.meetingTimes = meetingTimes;
  }

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
  const [rowErrors, setRowErrors] = useState<RowErrors>({});
  const codeRef = useRef<HTMLInputElement>(null);
  const startRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusField === "startDate") startRef.current?.focus();
    else codeRef.current?.focus();
  }, [focusField]);

  function patch(field: keyof Omit<Draft, "meetings">, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function patchMeeting(key: string, changes: Partial<MeetingDraft>) {
    setDraft((current) => ({
      ...current,
      meetings: current.meetings.map((meeting) =>
        meeting.key === key ? { ...meeting, ...changes } : meeting,
      ),
    }));
    setRowErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function toggleDay(key: string, day: number) {
    setDraft((current) => ({
      ...current,
      meetings: current.meetings.map((meeting) =>
        meeting.key === key
          ? {
              ...meeting,
              days: meeting.days.includes(day)
                ? meeting.days.filter((value) => value !== day)
                : [...meeting.days, day].sort((a, b) => a - b),
            }
          : meeting,
      ),
    }));
    setRowErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function addMeeting() {
    setDraft((current) => ({
      ...current,
      meetings: [...current.meetings, emptyMeetingDraft()],
    }));
  }

  function removeMeeting(key: string) {
    setDraft((current) => ({
      ...current,
      meetings: current.meetings.filter((meeting) => meeting.key !== key),
    }));
    setRowErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const built = buildPatch(course, draft);
    if ("error" in built) {
      setError(built.error);
      setRowErrors(built.rows ?? {});
      return;
    }
    setRowErrors({});
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

      {/* ------------------------------------------------------------------ */}
      {/* Meeting times                                                       */}
      {/* ------------------------------------------------------------------ */}
      <section aria-labelledby={`${fieldId}-meetings`} className="mt-4 border-t border-line pt-3">
        <p
          id={`${fieldId}-meetings`}
          className="text-[0.75rem] font-semibold tracking-wide text-ink-soft"
        >
          Meeting times
        </p>
        <p className="mt-1 text-[0.75rem] leading-relaxed text-muted">
          What goes on your calendar as a recurring event. A section label is
          only needed when the syllabus lists more than one.
        </p>

        {draft.meetings.length === 0 ? (
          <p className="mt-2 text-[0.8125rem] text-muted">
            No meeting times were extracted for this course.
          </p>
        ) : (
          <ul className="mt-2.5 space-y-2.5">
            {draft.meetings.map((meeting, index) => (
              <li
                key={meeting.key}
                className="rounded-lg border border-line bg-surface p-2.5 sm:p-3"
              >
                <div className="grid gap-2.5 sm:grid-cols-3">
                  <FormField
                    label="Type"
                    htmlFor={`${fieldId}-${meeting.key}-kind`}
                  >
                    <select
                      id={`${fieldId}-${meeting.key}-kind`}
                      value={meeting.kind}
                      disabled={pending}
                      onChange={(event) =>
                        patchMeeting(meeting.key, {
                          kind: event.target.value as MeetingKind,
                        })
                      }
                      className={FORM_INPUT}
                    >
                      {MEETING_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {MEETING_KIND_LABEL[kind]}
                        </option>
                      ))}
                    </select>
                  </FormField>

                  <FormField
                    label="Section"
                    htmlFor={`${fieldId}-${meeting.key}-section`}
                  >
                    <input
                      id={`${fieldId}-${meeting.key}-section`}
                      type="text"
                      autoComplete="off"
                      placeholder="—"
                      value={meeting.section}
                      disabled={pending}
                      onChange={(event) =>
                        patchMeeting(meeting.key, { section: event.target.value })
                      }
                      className={FORM_INPUT}
                    />
                  </FormField>

                  <FormField
                    label="Instructor"
                    htmlFor={`${fieldId}-${meeting.key}-instructor`}
                  >
                    <input
                      id={`${fieldId}-${meeting.key}-instructor`}
                      type="text"
                      autoComplete="off"
                      placeholder="—"
                      value={meeting.instructor}
                      disabled={pending}
                      onChange={(event) =>
                        patchMeeting(meeting.key, {
                          instructor: event.target.value,
                        })
                      }
                      className={FORM_INPUT}
                    />
                  </FormField>
                </div>

                <div className="mt-2.5">
                  <span className={FORM_LABEL}>Days</span>
                  <div
                    role="group"
                    aria-label={`Days meeting ${index + 1} happens`}
                    // Seven columns rather than a wrapping row: a week that
                    // breaks after Friday on a narrow phone stops reading as a
                    // week at all.
                    className="mt-1 grid max-w-64 grid-cols-7 gap-1"
                  >
                    {DAY_INITIALS.map((initial, day) => {
                      const on = meeting.days.includes(day);
                      return (
                        <button
                          key={day}
                          type="button"
                          aria-pressed={on}
                          aria-label={DAY_NAMES[day]}
                          disabled={pending}
                          onClick={() => toggleDay(meeting.key, day)}
                          className={`h-8 w-full rounded-md border text-[0.8125rem] font-medium transition-colors disabled:opacity-60 ${
                            on
                              ? "border-accent bg-accent text-accent-on"
                              : "border-line-strong bg-surface text-muted hover:bg-raised hover:text-ink"
                          }`}
                        >
                          {initial}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="mt-2.5 grid gap-2.5 sm:grid-cols-3">
                  <FormField
                    label="Starts"
                    htmlFor={`${fieldId}-${meeting.key}-start`}
                  >
                    <input
                      id={`${fieldId}-${meeting.key}-start`}
                      type="time"
                      value={meeting.startTime}
                      disabled={pending}
                      onChange={(event) =>
                        patchMeeting(meeting.key, {
                          startTime: event.target.value,
                        })
                      }
                      className={FORM_INPUT}
                    />
                  </FormField>

                  <FormField
                    label="Ends"
                    htmlFor={`${fieldId}-${meeting.key}-end`}
                  >
                    <input
                      id={`${fieldId}-${meeting.key}-end`}
                      type="time"
                      value={meeting.endTime}
                      disabled={pending}
                      onChange={(event) =>
                        patchMeeting(meeting.key, { endTime: event.target.value })
                      }
                      className={FORM_INPUT}
                    />
                  </FormField>

                  <FormField
                    label="Room"
                    htmlFor={`${fieldId}-${meeting.key}-room`}
                  >
                    <input
                      id={`${fieldId}-${meeting.key}-room`}
                      type="text"
                      autoComplete="off"
                      placeholder="—"
                      value={meeting.location}
                      disabled={pending}
                      onChange={(event) =>
                        patchMeeting(meeting.key, {
                          location: event.target.value,
                        })
                      }
                      className={FORM_INPUT}
                    />
                  </FormField>
                </div>

                {rowErrors[meeting.key] ? (
                  <p
                    role="alert"
                    className="mt-2 rounded-md border border-danger-line bg-danger-soft px-2.5 py-1.5 text-[0.75rem] leading-relaxed text-danger"
                  >
                    {rowErrors[meeting.key]}
                  </p>
                ) : null}

                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => removeMeeting(meeting.key)}
                    aria-label={`Remove meeting ${index + 1}`}
                    className="rounded-md px-1.5 py-1 text-[0.75rem] font-medium text-muted transition-colors hover:bg-raised hover:text-danger disabled:opacity-60"
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-2">
          <button
            type="button"
            disabled={pending}
            onClick={addMeeting}
            className="-ml-1.5 rounded-md px-1.5 py-1 text-[0.75rem] font-medium text-muted transition-colors hover:bg-surface hover:text-ink disabled:opacity-60"
          >
            + Add meeting
          </button>
        </div>
      </section>

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
