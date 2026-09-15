"use client";

import { useEffect, useId, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { Assessment, Course, MeetingTime } from "@/lib/types";
import { apiPatch, apiPost } from "@/components/api-client";
import { Button, Spinner, TOUCH_TARGET } from "@/components/ui/button";
import { CheckIcon } from "@/components/icons";
import { FORM_INPUT, FormField } from "@/components/dashboard/assessment-row";
import {
  SectionChooser,
  meetingWhen,
} from "@/components/dashboard/section-chooser";
import { meetingKindLabel } from "@/components/labels";
import {
  formatDate,
  formatTime,
  formatTimeRange,
  pluralize,
} from "@/components/format";
import { sectionGroups } from "@/lib/sections";
import { setupQuestions } from "@/lib/setup";
import type { SetupQuestion } from "@/lib/setup";

/**
 * The questions a syllabus leaves open, asked where the student is already
 * looking at the course.
 *
 * `@/lib/setup` decides what is open and in what order; this file is only the
 * asking. The tone is the section chooser's, for the same reason: nothing is
 * broken, and a card that reads like a failure makes a student go looking for
 * the mistake they did not make. The syllabus simply does not say when Week 1
 * begins, and one date fixes seven items.
 *
 * Two rules shape the layout. Each question says what its answer changes, by
 * name -- "these 7 items get dates", not "improve your calendar" -- because
 * that is the difference between a chore and a trade. And at most two are open
 * at once: a course with six gaps asked all six is a form, and a form is what
 * gets abandoned.
 */

/* -------------------------------------------------------------------------- */
/* Identity and small words                                                   */
/* -------------------------------------------------------------------------- */

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** Two letters is what fits seven chips across a 320px card. */
const DAY_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

/** How many questions are open on the card at once. */
const MAX_OPEN = 2;

/**
 * A stable handle for one question, across the renders in which it is asked,
 * answered, folded to a line and possibly reopened. Derived from what the
 * question is about rather than its position, because answering one removes it
 * from the list and would shift every index after it.
 */
function keyOf(question: SetupQuestion): string {
  switch (question.kind) {
    case "term-start":
      return "term-start";
    case "meeting-time":
      return `meeting-time:${question.meetingIndex}`;
    case "weekly-day":
      return `weekly-day:${question.assessmentId}`;
    case "section":
      return `section:${question.group.kind}`;
  }
}

/** "Tuesday and Friday" -- the days said the way a timetable is read aloud. */
function joinList(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function dayNames(days: number[] | null | undefined): string {
  return joinList(
    [...(days ?? [])]
      .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      .sort((a, b) => a - b)
      .map((day) => DAY_NAMES[day]),
  );
}

/**
 * "PHYS 211" for a lecture, "PHYS 211's lab (LAB B)" for anything else.
 *
 * A lecture IS the course as a student talks about it, so naming its kind reads
 * like a form field. Every other kind has to be named, or the question is about
 * a meeting the student cannot pick out of their week.
 */
function meetingSubject(code: string, meeting: MeetingTime): string {
  const section = meeting.section?.trim();
  if (meeting.kind === "lecture") return section ? `${code} (${section})` : code;
  const kind = meetingKindLabel(meeting.kind).toLowerCase();
  return `${code}'s ${kind}${section ? ` (${section})` : ""}`;
}

/**
 * The route answers `{ created, deleted }`. Counted defensively because a
 * server that hands back the rows themselves rather than a tally is still
 * telling us how many there were, and the sentence under the card is the one
 * place a wrong number would be believed.
 */
function countOf(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  if (Array.isArray(value)) return value.length;
  return 0;
}

/* -------------------------------------------------------------------------- */
/* The card                                                                   */
/* -------------------------------------------------------------------------- */

/** An answered question, folded to a line, with what to say on it. */
interface Resolved {
  key: string;
  line: string;
  question: SetupQuestion;
  /**
   * Whether the answer can be revised here. A weekly expansion cannot: the
   * route consumes the placeholder item and hands back real ones, so there is
   * nothing left to re-answer and a second attempt would 404. Those items are
   * edited on the roadmap like any other, which is where they now are.
   */
  changeable: boolean;
}

export function SetupCard({
  course,
  assessments,
  onCourseChanged,
  onAnswered,
  className,
}: {
  course: Course;
  /** This course's items. The questions are derived from them, so they must be this course's. */
  assessments: Assessment[];
  /** The saved course, straight from the server. */
  onCourseChanged: (updated: Course) => void;
  /**
   * Re-read courses and items, for the answers the server acts on beyond the
   * field it was sent: a term start dates every week-numbered item, a weekly
   * day creates one item per week. Without this the page would show the answer
   * and not the thing the answer did.
   */
  onAnswered?: () => void;
  /**
   * Spacing from whatever this sits under. It belongs to the root rather than a
   * wrapper because the card renders nothing at all for a course with nothing
   * open, and an empty wrapper with a margin is a gap under every finished
   * course header.
   */
  className?: string;
}) {
  const baseId = useId();
  const headingId = `${baseId}-heading`;

  /**
   * Set aside for this session only, deliberately not persisted. The calendar
   * is wrong until the question is answered, so a dismissal that outlived the
   * page would be the app agreeing to stay wrong.
   */
  const [skipped, setSkipped] = useState<string[]>([]);
  const [resolved, setResolved] = useState<Resolved[]>([]);
  /** Folded answers the student reopened with "Change". */
  const [reopened, setReopened] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [focusAfter, setFocusAfter] = useState<string | null>(null);

  /**
   * The items a term start was meant to place, and the list as it was before
   * the refetch. The server does the placing, so the only honest way to say
   * "7 items now have dates" is to wait for the items to come back and count.
   */
  const [placing, setPlacing] = useState<{
    ids: string[];
    before: Assessment[];
  } | null>(null);

  useEffect(() => {
    if (!focusAfter) return;
    document.getElementById(focusAfter)?.focus();
    setFocusAfter(null);
  }, [focusAfter]);

  useEffect(() => {
    if (!placing) return;
    // Same array means the refetch has not landed; counting now would report
    // zero for work that is about to arrive.
    if (placing.before === assessments) return;
    const dated = assessments.filter(
      (item) => placing.ids.includes(item.id) && item.dueDate !== null,
    ).length;
    setStatus(
      dated > 0
        ? `Saved — ${pluralize(dated, "item")} now ${dated === 1 ? "has a date" : "have dates"}.`
        : "Saved — the term dates are in. Those items still have no dates; check them on the roadmap.",
    );
    setPlacing(null);
  }, [placing, assessments]);

  const questions = setupQuestions(course, assessments);
  const groups = sectionGroups(course);

  /**
   * Sections are asked by the chooser, which already handles the one question
   * this card would otherwise duplicate -- and handles it better, because it
   * keeps the answered ones on screen as a receipt. So they are counted here
   * and rendered there.
   */
  const mine = questions.filter((question) => question.kind !== "section");
  const live = questions.filter(
    (question) => !skipped.includes(keyOf(question)),
  );
  const openMine = mine.filter((question) => !skipped.includes(keyOf(question)));
  const shown = openMine.slice(0, MAX_OPEN);
  const hidden = openMine.length - shown.length;
  const setAside = skipped.length;

  const changeId = (key: string) => `${baseId}-change-${key}`;
  const restoreId = `${baseId}-restore`;

  function fold(
    question: SetupQuestion,
    line: string,
    announcement: string,
    changeable = true,
  ) {
    const key = keyOf(question);
    setResolved((current) => [
      ...current.filter((entry) => entry.key !== key),
      { key, line, question, changeable },
    ]);
    setReopened((current) => current.filter((entry) => entry !== key));
    setStatus(announcement);
    // The form is about to fold to a line, taking the focused control with it.
    // Its own "Change" leaves a keyboard user on the question they answered
    // rather than at the top of a very long dashboard.
    setFocusAfter(changeId(key));
  }

  function skip(question: SetupQuestion) {
    const key = keyOf(question);
    setSkipped((current) =>
      current.includes(key) ? current : [...current, key],
    );
    setStatus(
      "Set aside for now. It will be here again next time you open this page.",
    );
    setFocusAfter(restoreId);
  }

  function restore() {
    setSkipped([]);
    setStatus("");
  }

  function renderQuestion(question: SetupQuestion): ReactNode {
    const key = keyOf(question);
    const fieldId = `${baseId}-${key}`;
    const common = {
      course,
      fieldId,
      onSkip: () => skip(question),
    };
    switch (question.kind) {
      case "term-start":
        return (
          <TermStartQuestion
            key={key}
            {...common}
            question={question}
            onSaved={(updated, line, announcement, ids) => {
              onCourseChanged(updated);
              if (ids.length > 0) setPlacing({ ids, before: assessments });
              fold(question, line, announcement);
              onAnswered?.();
            }}
          />
        );
      case "meeting-time":
        return (
          <MeetingTimeQuestion
            key={key}
            {...common}
            question={question}
            onSaved={(updated, line, announcement) => {
              onCourseChanged(updated);
              fold(question, line, announcement);
            }}
          />
        );
      case "weekly-day":
        return (
          <WeeklyDayQuestion
            key={key}
            {...common}
            question={question}
            onSaved={(line, announcement) => {
              fold(question, line, announcement, false);
              onAnswered?.();
            }}
          />
        );
      case "section":
        return null;
    }
  }

  const nothingToShow =
    live.length === 0 &&
    resolved.length === 0 &&
    setAside === 0 &&
    groups.length === 0;
  if (nothingToShow) return null;

  const body = (
    <div className="space-y-2">
      {/* Answered first, as quiet lines: they are the receipt for what was
          just decided, and they keep the open questions at the bottom where
          the last one was answered. */}
      {resolved.map((entry) =>
        reopened.includes(entry.key) ? (
          renderQuestion(entry.question)
        ) : (
          <AnsweredLine
            key={entry.key}
            line={entry.line}
            buttonId={changeId(entry.key)}
            onChange={
              entry.changeable
                ? () => {
                    setReopened((current) =>
                      current.includes(entry.key)
                        ? current
                        : [...current, entry.key],
                    );
                  }
                : undefined
            }
          />
        ),
      )}

      {shown.map((question) => renderQuestion(question))}

      {hidden > 0 ? (
        <p className="text-[0.75rem] text-muted">
          {hidden} more after {shown.length === 1 ? "this one" : "these"}.
        </p>
      ) : null}

      {setAside > 0 ? (
        <p className="flex flex-wrap items-baseline gap-x-1.5 text-[0.75rem] text-muted">
          <span>
            {pluralize(setAside, "question")} set aside for now.
          </span>
          <button
            id={restoreId}
            type="button"
            onClick={restore}
            className="rounded-sm font-medium underline decoration-line-strong underline-offset-2 transition-colors hover:text-ink"
          >
            Show {setAside === 1 ? "it" : "them"} again
          </button>
        </p>
      ) : null}

      {/* Sections, by the component that already asks them well. Below the
          rest because that is the order `setupQuestions` returns: a term start
          dates everything at once, a section only trims. */}
      {groups.length > 0 ? (
        <SectionChooser course={course} onChanged={onCourseChanged} />
      ) : null}

      <p
        role="status"
        aria-live="polite"
        className={
          status
            ? "flex items-start gap-1.5 pt-0.5 text-[0.75rem] leading-relaxed text-ink-soft"
            : "sr-only"
        }
      >
        {status ? (
          <span aria-hidden="true" className="mt-0.5 shrink-0 text-ok">
            <CheckIcon width={12} height={12} />
          </span>
        ) : null}
        {status}
      </p>
    </div>
  );

  /**
   * One element either way, never a `<section>` swapped for a `<div>`.
   *
   * With nothing open the card drops its heading and its box and becomes what
   * it is: a couple of settled lines, the way the course header looked before
   * this card existed. Doing that by returning a different root is what it
   * looks like it costs nothing to do and does not: React tears the subtree
   * down and builds it again, and the answer that emptied the card takes the
   * focus ring off the "Change" it was just handed and drops it on <body>,
   * eleven thousand pixels from where the student was working.
   */
  const open = live.length > 0;
  return (
    <section
      id={`setup-card-${course.id}`}
      aria-labelledby={open ? headingId : undefined}
      className={`scroll-mt-24 ${
        open ? "rounded-lg border border-line bg-surface p-3 sm:p-3.5" : ""
      } ${className ?? ""}`}
    >
      {open ? (
        <>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h4 id={headingId} className="text-[0.875rem] font-semibold text-ink">
              Finish setting up{" "}
              <span className="font-mono text-[0.8125rem]">{course.code}</span>
            </h4>
            <span className="text-[0.75rem] text-muted tabular-nums">
              {pluralize(live.length, "question")}
            </span>
          </div>
          <p className="mb-2.5 text-[0.8125rem] leading-relaxed text-ink-soft">
            Nothing is broken — the syllabus simply doesn&rsquo;t say. These are
            the parts only you can answer.
          </p>
        </>
      ) : null}
      {body}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Getting to the card from elsewhere on the page                             */
/* -------------------------------------------------------------------------- */

/**
 * A jump, not a route: the card is already on this page, a panel away. Shared
 * by the upload result and the sync result so the two cannot describe the same
 * destination differently, and so the id they aim at is the one this file sets.
 *
 * The anchor is the fallback for a caller that was handed no click handler; it
 * lands on the card without moving focus, which is worse than the handler and
 * far better than a dead count.
 */
export function SetupJump({
  courseId,
  label,
  onClick,
}: {
  courseId: string;
  label: string;
  onClick?: () => void;
}) {
  const className =
    "rounded-sm font-medium text-ink underline decoration-warn-line underline-offset-2 transition-colors hover:text-accent";
  if (!onClick) {
    return (
      <a href={`#setup-card-${courseId}`} className={className}>
        {label}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className={className}>
      {label}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Shared shape of one question                                               */
/* -------------------------------------------------------------------------- */

/**
 * A real fieldset with a real legend, floated for the same reason the chooser
 * floats its own: a legend long enough to wrap -- which every one of these is
 * at 320px -- is drawn straddling the card's top border and reads as broken.
 */
function QuestionCard({
  legend,
  onSubmit,
  children,
}: {
  legend: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}) {
  return (
    <form noValidate onSubmit={onSubmit} className="min-w-0">
      <fieldset className="rise min-w-0 rounded-lg border border-warn-line bg-warn-soft p-3 sm:p-3.5">
        <legend className="float-left w-full text-[0.875rem] font-semibold text-ink">
          {legend}
        </legend>
        <div className="clear-both pt-1">{children}</div>
      </fieldset>
    </form>
  );
}

/** Save, skip, and the one sentence a failure is allowed to say. */
function QuestionActions({
  saveLabel,
  savingLabel,
  pending,
  error,
  onSkip,
}: {
  saveLabel: string;
  savingLabel: string;
  pending: boolean;
  error: string | null;
  onSkip: () => void;
}) {
  return (
    <>
      {error ? (
        <p
          role="alert"
          className="mt-2.5 rounded-md border border-danger-line bg-danger-soft px-2.5 py-1.5 text-[0.75rem] leading-relaxed text-danger"
        >
          {error}
        </p>
      ) : null}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? (
            <Spinner label={savingLabel} />
          ) : (
            <CheckIcon width={14} height={14} />
          )}
          {saveLabel}
        </Button>
        {/* Always offered. A question a student cannot answer right now -- the
            syllabus is on a laptop in another room -- must not be a wall. */}
        <button
          type="button"
          onClick={onSkip}
          disabled={pending}
          className={`rounded-md px-1.5 py-1 text-[0.75rem] font-medium text-muted underline decoration-line-strong underline-offset-2 transition-colors hover:text-ink disabled:no-underline disabled:opacity-55 ${TOUCH_TARGET}`}
        >
          Not now
        </button>
      </div>
    </>
  );
}

/**
 * An answered question, folded to the one line it is worth, with the way back
 * to it. The line is written at save time, from what was actually saved.
 */
function AnsweredLine({
  line,
  buttonId,
  onChange,
}: {
  line: string;
  buttonId: string;
  /** Absent for an answer that cannot be re-asked; the line stands on its own. */
  onChange?: () => void;
}) {
  return (
    <p
      id={onChange ? undefined : buttonId}
      tabIndex={onChange ? undefined : -1}
      className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[0.8125rem] leading-snug text-muted outline-none"
    >
      <span className="text-ink-soft">{line}</span>
      {onChange ? (
        <button
          id={buttonId}
          type="button"
          aria-label={`Change: ${line}`}
          onClick={onChange}
          className="rounded-sm font-medium underline decoration-line-strong underline-offset-2 transition-colors hover:text-ink"
        >
          Change
        </button>
      ) : null}
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/* When does Week 1 begin?                                                    */
/* -------------------------------------------------------------------------- */

/** Beyond this the list is a wall of titles; the rest are counted. */
const AFFECTS_SHOWN = 5;

function TermStartQuestion({
  course,
  question,
  fieldId,
  onSaved,
  onSkip,
}: {
  course: Course;
  question: Extract<SetupQuestion, { kind: "term-start" }>;
  fieldId: string;
  onSaved: (
    updated: Course,
    line: string,
    announcement: string,
    affectedIds: string[],
  ) => void;
  onSkip: () => void;
}) {
  const [start, setStart] = useState(course.startDate ?? "");
  const [end, setEnd] = useState(course.endDate ?? "");
  /**
   * Whether the end date is part of this question, fixed when the form opens.
   * Asked in the same card rather than as a second question, because the two
   * dates are one fact about the term and a student looking one of them up has
   * the other in front of them.
   */
  const [askEnd] = useState(course.endDate === null);
  /**
   * Reopened with "Change" rather than asked for the first time, frozen the
   * same way. It changes what is true: the items below already have the dates
   * this question was asked to give them, and the server places only items that
   * are still undated -- so a corrected start renumbers the weeks and leaves
   * those items where they are. Saying "these 3 items get dates" a second time
   * would be promising something that will not happen.
   */
  const [correcting] = useState(course.startDate !== null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shown = question.affects.slice(0, AFFECTS_SHOWN);
  const more = question.affects.length - shown.length;
  /**
   * A "Week 3" item is dated by this save. A weekly rule ("every Saturday")
   * is not: it gets the weekly-day question next. The copy, the promise and
   * the count afterwards all have to say which of the two this card is doing.
   */
  const placedIds = question.affects.filter((item) => !item.weekly).map((item) => item.id);
  const weeklyCount = question.affects.length - placedIds.length;
  const weeklyOnly = placedIds.length === 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!start) {
      setError("Enter the day the term starts.");
      return;
    }
    if (end && end < start) {
      setError("The term cannot end before it starts.");
      return;
    }

    setPending(true);
    setError(null);
    const result = await apiPatch<Course>(`/api/courses/${course.id}`, {
      startDate: start,
      ...(askEnd && end ? { endDate: end } : {}),
    });
    setPending(false);
    if (!result.ok) {
      setError(result.detail ?? result.error);
      return;
    }

    const saved = result.data;
    const savedEnd = askEnd && end ? end : course.endDate;
    const line = `Term starts ${formatDate(start)}${savedEnd ? `, ends ${formatDate(savedEnd)}` : ""}`;
    onSaved(
      saved && typeof saved === "object" && typeof saved.id === "string"
        ? saved
        : { ...course, startDate: start, endDate: savedEnd },
      line,
      weeklyOnly && !correcting
        ? "Saved — term dates set. One more question: which day the weekly work is due."
        : "Saved — term dates set.",
      // Nothing to count on a correction: the placements already happened, and
      // recounting them would report work this save did not do. Weekly items
      // are never counted: this save does not date them.
      correcting ? [] : placedIds,
    );
  }

  return (
    <QuestionCard
      legend="When does Week 1 begin?"
      onSubmit={(event) => void submit(event)}
    >
      {correcting ? (
        <p className="text-[0.8125rem] leading-relaxed text-ink-soft">
          The term start is what every &ldquo;Week N&rdquo; in this syllabus
          counts from. Changing it renumbers the weeks; items already dated from
          it keep the dates they have, and those are edited on the roadmap.
        </p>
      ) : (
        <>
          <p className="text-[0.8125rem] leading-relaxed text-ink-soft">
            {weeklyOnly ? (
              <>
                This syllabus sets deadlines by the week but never says when the
                term starts. Enter the term dates, and you&rsquo;ll be asked which
                day{" "}
                {weeklyCount === 1 ? "this item is" : `these ${weeklyCount} items are`}{" "}
                due each week:
              </>
            ) : weeklyCount > 0 ? (
              <>
                This syllabus schedules by week number but never says when Week 1
                begins. Enter the term start: items with a week number get dates,
                and the weekly {weeklyCount === 1 ? "one gets" : "ones get"} one
                more question:
              </>
            ) : (
              <>
                This syllabus schedules by week number but never says when Week 1
                begins. Enter the term start and{" "}
                {question.affects.length === 1
                  ? "this item gets a date"
                  : `these ${question.affects.length} items get dates`}
                :
              </>
            )}
          </p>
          <ul className="mt-1.5 space-y-0.5">
            {shown.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-baseline gap-x-2 text-[0.8125rem] leading-snug text-ink"
              >
                <span className="min-w-0">{item.title}</span>
                <span className="text-[0.75rem] text-muted">
                  &ldquo;{item.phrase}&rdquo;
                </span>
              </li>
            ))}
            {more > 0 ? (
              <li className="text-[0.75rem] text-muted">
                and {more} more like {more === 1 ? "it" : "them"}
              </li>
            ) : null}
          </ul>
        </>
      )}

      <div className="mt-2.5 grid gap-3 sm:grid-cols-2">
        <FormField label="First day of classes" htmlFor={`${fieldId}-start`}>
          <input
            id={`${fieldId}-start`}
            type="date"
            required
            value={start}
            disabled={pending}
            onChange={(event) => setStart(event.target.value)}
            className={FORM_INPUT}
          />
        </FormField>
        {askEnd ? (
          <FormField
            label="Last day of classes"
            htmlFor={`${fieldId}-end`}
            hint="Optional, but worth adding so weekly work stops at the end of term."
          >
            <input
              id={`${fieldId}-end`}
              type="date"
              aria-describedby={`${fieldId}-end-hint`}
              value={end}
              disabled={pending}
              onChange={(event) => setEnd(event.target.value)}
              className={FORM_INPUT}
            />
          </FormField>
        ) : null}
      </div>

      <QuestionActions
        saveLabel="Save term dates"
        savingLabel="Saving the term dates"
        pending={pending}
        error={error}
        onSkip={onSkip}
      />
    </QuestionCard>
  );
}

/* -------------------------------------------------------------------------- */
/* What time does it meet?                                                    */
/* -------------------------------------------------------------------------- */

function MeetingTimeQuestion({
  course,
  question,
  fieldId,
  onSaved,
  onSkip,
}: {
  course: Course;
  question: Extract<SetupQuestion, { kind: "meeting-time" }>;
  fieldId: string;
  onSaved: (updated: Course, line: string, announcement: string) => void;
  onSkip: () => void;
}) {
  /**
   * The stored meeting, not the one the question was derived from: reopening
   * this with "Change" has to show the times that are actually saved.
   */
  const meeting = course.meetingTimes[question.meetingIndex] ?? question.meeting;
  const [start, setStart] = useState(meeting.startTime || "");
  const [end, setEnd] = useState(meeting.endTime || "");
  /** Reopened with "Change": the hour is known, and the card must not say it isn't. */
  const [correcting] = useState(Boolean(meeting.startTime && meeting.endTime));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const days = dayNames(meeting.daysOfWeek);
  const subject = meetingSubject(course.code, meeting);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!start || !end) {
      setError("Enter both the start and the end time.");
      return;
    }
    if (end <= start) {
      setError("The end time has to be after the start time.");
      return;
    }

    setPending(true);
    setError(null);
    /**
     * The whole array, because that is what the route replaces. Sending only
     * the meeting that changed would read as "and the course meets at no other
     * time", which is how a lab disappears from a calendar.
     */
    const meetingTimes = course.meetingTimes.map((row, index) =>
      index === question.meetingIndex
        ? { ...row, startTime: start, endTime: end }
        : row,
    );
    const result = await apiPatch<Course>(`/api/courses/${course.id}`, {
      meetingTimes,
    });
    setPending(false);
    if (!result.ok) {
      setError(result.detail ?? result.error);
      return;
    }

    const saved = result.data;
    const filled: MeetingTime = { ...meeting, startTime: start, endTime: end };
    const line = `${meetingKindLabel(meeting.kind)} · ${meetingWhen(filled)}`;
    onSaved(
      saved && typeof saved === "object" && typeof saved.id === "string"
        ? saved
        : { ...course, meetingTimes },
      line,
      `Saved — ${subject} meets ${days ? `${days}, ` : ""}${formatTimeRange(start, end) ?? ""}.`,
    );
  }

  return (
    <QuestionCard
      legend="What time does it meet?"
      onSubmit={(event) => void submit(event)}
    >
      <p className="text-[0.8125rem] leading-relaxed text-ink-soft">
        {correcting ? (
          <>
            {days ? `${subject} meets ${days}` : subject}
            {formatTimeRange(meeting.startTime, meeting.endTime)
              ? `, ${formatTimeRange(meeting.startTime, meeting.endTime)}`
              : ""}
            . That is the hour you entered — change it if it is wrong.
          </>
        ) : (
          <>
            {days
              ? `${subject} meets ${days}, but the syllabus doesn't say when.`
              : `The syllabus never says when ${subject} meets.`}{" "}
            Nothing goes on your calendar for it until we know the hour.
          </>
        )}
      </p>

      <div className="mt-2.5 grid gap-3 sm:grid-cols-2">
        <FormField label="Starts at" htmlFor={`${fieldId}-start`}>
          <input
            id={`${fieldId}-start`}
            type="time"
            required
            value={start}
            disabled={pending}
            onChange={(event) => setStart(event.target.value)}
            className={FORM_INPUT}
          />
        </FormField>
        <FormField label="Ends at" htmlFor={`${fieldId}-end`}>
          <input
            id={`${fieldId}-end`}
            type="time"
            required
            value={end}
            disabled={pending}
            onChange={(event) => setEnd(event.target.value)}
            className={FORM_INPUT}
          />
        </FormField>
      </div>

      <QuestionActions
        saveLabel="Save the time"
        savingLabel="Saving the time"
        pending={pending}
        error={error}
        onSkip={onSkip}
      />
    </QuestionCard>
  );
}

/* -------------------------------------------------------------------------- */
/* Which day is the weekly thing due?                                         */
/* -------------------------------------------------------------------------- */

function WeeklyDayQuestion({
  course,
  question,
  fieldId,
  onSaved,
  onSkip,
}: {
  course: Course;
  question: Extract<SetupQuestion, { kind: "weekly-day" }>;
  fieldId: string;
  onSaved: (line: string, announcement: string) => void;
  onSkip: () => void;
}) {
  const [weekday, setWeekday] = useState<number | null>(question.rule.weekday);
  const [time, setTime] = useState(question.rule.time ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (weekday === null) {
      setError("Pick the day these are due.");
      return;
    }

    setPending(true);
    setError(null);
    const result = await apiPost<{ created: unknown; deleted: unknown }>(
      `/api/courses/${course.id}/assessments/${question.assessmentId}/expand`,
      { weekday, time: time || null },
    );
    setPending(false);
    if (!result.ok) {
      setError(result.detail ?? result.error);
      return;
    }

    const created = countOf(result.data?.created);
    const day = DAY_NAMES[weekday];
    const clock = time ? formatTime(time) : null;
    onSaved(
      `${question.title} · every ${day}${clock ? ` at ${clock}` : ""}${created > 0 ? ` · ${pluralize(created, "item")} on the roadmap` : ""}`,
      created > 0
        ? `Saved — ${pluralize(created, `${day} item`)} added to your roadmap.`
        : `Saved — ${day} it is. No weeks were left in the term to add it to.`,
    );
  }

  const suggested = question.rule.weekday !== null;

  return (
    <QuestionCard
      legend="Which day are these due?"
      onSubmit={(event) => void submit(event)}
    >
      {question.sourceText ? (
        // Its own words, so the answer is checked against the sentence rather
        // than against our summary of it.
        <p className="border-l-2 border-warn-line pl-2.5 text-[0.8125rem] leading-relaxed text-ink italic">
          &ldquo;{question.sourceText}&rdquo;
        </p>
      ) : null}
      <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-ink-soft">
        {suggested
          ? `The syllabus mentions ${DAY_NAMES[question.rule.weekday ?? 0]} — confirm it or pick another day.`
          : "The syllabus says this repeats every week but never fixes the day."}{" "}
        Pick one and &ldquo;{question.title}&rdquo; goes on every week of the
        term.
      </p>

      {/* A real radio group: seven buttons with roving focus would be seven
          tab stops, and arrow keys are what a group of one-of-seven is for.
          The inputs are clipped rather than replaced, so the arrow-key walk,
          the name grouping and the focus ring are the browser's. */}
      <fieldset className="mt-2.5">
        <legend className="mb-1 block text-[0.75rem] font-medium text-muted">
          Day of the week
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {DAY_NAMES.map((name, day) => {
            const selected = weekday === day;
            return (
              <label
                key={name}
                className={`relative flex cursor-pointer items-center justify-center rounded-lg border px-2.5 py-1.5 text-[0.8125rem] font-medium transition-colors ${TOUCH_TARGET} ${
                  selected
                    ? "border-accent bg-accent text-accent-on"
                    : "border-line-strong bg-surface/70 text-ink-soft hover:bg-surface"
                }`}
              >
                <input
                  type="radio"
                  id={`${fieldId}-day-${day}`}
                  name={`${fieldId}-day`}
                  value={day}
                  aria-label={name}
                  checked={selected}
                  disabled={pending}
                  onChange={() => setWeekday(day)}
                  className="peer sr-only"
                />
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 rounded-lg peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent"
                />
                <span aria-hidden="true">{DAY_SHORT[day]}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="mt-2.5 sm:max-w-[13rem]">
        <FormField
          label="Due time"
          htmlFor={`${fieldId}-time`}
          hint="Optional. Leave it blank if the syllabus never says."
          onClear={time ? () => setTime("") : undefined}
          clearLabel="Clear the due time"
        >
          <input
            id={`${fieldId}-time`}
            type="time"
            aria-describedby={`${fieldId}-time-hint`}
            value={time}
            disabled={pending}
            onChange={(event) => setTime(event.target.value)}
            className={FORM_INPUT}
          />
        </FormField>
      </div>

      <QuestionActions
        saveLabel="Put these on the calendar"
        savingLabel="Creating the weekly items"
        pending={pending}
        error={error}
        onSkip={onSkip}
      />
    </QuestionCard>
  );
}
