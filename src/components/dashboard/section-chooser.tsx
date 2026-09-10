"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent } from "react";
import type { Course, MeetingKind, MeetingTime } from "@/lib/types";
import { apiPatch } from "@/components/api-client";
import { Spinner, TOUCH_TARGET } from "@/components/ui/button";
import { CheckIcon } from "@/components/icons";
import { meetingKindLabel } from "@/components/labels";
import { formatTime } from "@/components/format";
import { normalizeSection, sectionGroups, unansweredGroups } from "@/lib/sections";
import type { SectionGroup } from "@/lib/sections";

const DAY_LETTERS = ["Su", "M", "T", "W", "Th", "F", "Sa"];

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

/**
 * "MW 8:00–9:50 AM" -- the half of a meeting a student actually remembers.
 * Split out from `meetingSummary` because the chooser leads with it: the hour
 * you show up is the thing you know, and the registrar's code is not.
 */
export function meetingWhen(meeting: MeetingTime): string {
  return [formatDays(meeting.daysOfWeek), formatSpan(meeting.startTime, meeting.endTime)]
    .filter(Boolean)
    .join(" ");
}

/** "2MTC 907 · Prof. Lee" -- the corroborating half, quiet by design. */
export function meetingWhere(meeting: MeetingTime): string {
  return [meeting.location, meeting.instructor]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" · ");
}

/** "MW 8:00–9:50 AM · 2MTC 907 · Prof. Lee" */
export function meetingSummary(meeting: MeetingTime): string {
  return [meetingWhen(meeting), meetingWhere(meeting)].filter(Boolean).join(" · ");
}

/** The same line with its kind in front: "recitation T 3:00–3:50 PM". */
export function meetingSummaryWithKind(meeting: MeetingTime): string {
  const summary = meetingSummary(meeting);
  const kind = meetingKindLabel(meeting.kind).toLowerCase();
  return summary ? `${kind} ${summary}` : kind;
}

/** "lab", "lecture and lab", "lecture, lab and recitation". */
function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * The questions this course still has open, named rather than counted: "lecture
 * and lab", or "" when there is nothing left to ask.
 *
 * Every sentence that used to say "this syllabus lists 5 sections — choose
 * yours" was the bug written out loud. Five labels are two questions, and a
 * student who read that as one picked once and lost every lab.
 */
export function openQuestionWords(course: Course): string {
  return joinWords(
    unansweredGroups(course).map((group) => group.label.toLowerCase()),
  );
}

/* -------------------------------------------------------------------------- */
/* The chooser                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A tap on a radio is a real change event, and so is every step of an arrow
 * key walking the group. Waiting a beat before the request means arrowing past
 * LAB A on the way to LAB C costs one save rather than three.
 */
const KEY_WALK_MS = 250;

/** Overrides on top of `group.chosen`, so a tap lands before the round trip. */
type Answers = Partial<Record<MeetingKind, string>>;

/**
 * Every question this syllabus asks, asked where the student is already
 * looking at the course.
 *
 * Deliberately warm rather than alarming: nothing is broken, the syllabus
 * simply describes more classes than the student takes. And deliberately one
 * card per question -- a course with two lectures and three labs is two
 * questions, and pooling all five labels into one list is what silently
 * enrolled a student in no lab at all.
 */
export function SectionChooser({
  course,
  onChanged,
}: {
  course: Course;
  /** The saved course, straight from the server. */
  onChanged: (updated: Course) => void;
}) {
  const baseId = useId();
  const groups = sectionGroups(course);

  const [answers, setAnswers] = useState<Answers>({});
  /**
   * The same map as `answers`, readable from inside a timeout. The scheduled
   * save runs long after the render that scheduled it, so reading state there
   * would build the payload out of the answers as they were two taps ago.
   */
  const answersRef = useRef<Answers>({});
  /** The group whose answer is in flight, and the label being written. */
  const [saving, setSaving] = useState<{ kind: MeetingKind; label: string } | null>(
    null,
  );
  /**
   * The same value, readable from an event handler that was created before the
   * tap. `onBlur` fires in the same beat as the change that started a save, so
   * reading the state variable there sees `null` and folds the card out from
   * under a save that was about to fold it itself.
   */
  const savingRef = useRef<{ kind: MeetingKind; label: string } | null>(null);
  const [failed, setFailed] = useState<{ kind: MeetingKind; message: string } | null>(
    null,
  );
  /** Groups reopened by "Change". An unanswered group is open regardless. */
  const [reopened, setReopened] = useState<MeetingKind[]>([]);
  /** One polite sentence, for a reader who cannot see the row settle. */
  const [status, setStatus] = useState("");
  /** Set when collapsing or expanding moved the control out from under focus. */
  const [focusAfter, setFocusAfter] = useState<string | null>(null);

  /**
   * Whether the answer being saved came from a tap or from an arrow key.
   *
   * A tap is a decision, and the card can fold behind it. An arrow key is a
   * walk through the options: folding the card the moment the first step saves
   * would pull the radio group out from under someone still reading it, and
   * their next arrow press would land on nothing. A walk folds when focus
   * leaves instead.
   */
  const viaPointer = useRef(true);

  const pendingSave = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Only the newest answer may finish. Tapping LAB C while LAB A is still in
   * flight must not let A's reply land last and repaint the row as A.
   */
  const ticket = useRef(0);

  useEffect(
    () => () => {
      if (pendingSave.current) clearTimeout(pendingSave.current);
    },
    [],
  );

  useEffect(() => {
    if (!focusAfter) return;
    document.getElementById(focusAfter)?.focus();
    setFocusAfter(null);
  }, [focusAfter]);

  if (groups.length === 0) return null;

  const optionId = (kind: MeetingKind, label: string) =>
    `${baseId}-${kind}-${normalizeSection(label).replace(/[^a-z0-9]+/g, "-")}`;
  const changeId = (kind: MeetingKind) => `${baseId}-change-${kind}`;
  const answerFor = (group: SectionGroup) => answers[group.kind] ?? group.chosen;
  const answered = groups.filter((group) => answerFor(group) !== null).length;

  async function save(group: SectionGroup, label: string, fold: boolean) {
    // Arrowing off an answer and back onto it is not a new answer. Nothing to
    // write, and nothing to fold -- the walk is still in progress.
    if (normalizeSection(label) === normalizeSection(group.chosen ?? "")) {
      savingRef.current = null;
      setSaving(null);
      setStatus("");
      return;
    }
    const mine = ++ticket.current;
    /**
     * The whole set, every time. The server reconciles it down to at most one
     * answer per group, so sending only the group that changed would read as
     * "and I am in no lab" the moment a lecture is picked.
     */
    const sections = groups
      .map((other) =>
        other.kind === group.kind
          ? label
          : (answersRef.current[other.kind] ?? other.chosen),
      )
      .filter((value): value is string => Boolean(value));

    const result = await apiPatch<Course>(`/api/courses/${course.id}`, { sections });
    if (mine !== ticket.current) return;
    savingRef.current = null;
    setSaving(null);

    if (!result.ok) {
      // Put the row back to what is actually saved: a card that keeps showing
      // LAB C after the save failed is telling the student a lie they will
      // only discover on an empty calendar.
      const reverted = { ...answersRef.current };
      delete reverted[group.kind];
      answersRef.current = reverted;
      setAnswers(reverted);
      setStatus("");
      setFailed({ kind: group.kind, message: result.detail ?? result.error });
      return;
    }

    const echoed = result.data;
    // A server that does not echo the whole course back yet still told us the
    // save landed; the one field we changed is enough to move the page on.
    const updated: Course =
      echoed && typeof echoed === "object" && typeof echoed.id === "string"
        ? echoed
        : { ...course, sections };

    // The card is about to fold down to a line, taking the focused radio with
    // it. Handing focus to that line's own "Change" leaves a keyboard user on
    // the question they just answered rather than at the top of the document.
    if (fold) {
      setReopened((prev) => prev.filter((kind) => kind !== group.kind));
      setFocusAfter(changeId(group.kind));
    }
    const option = group.options.find(
      (candidate) => normalizeSection(candidate.label) === normalizeSection(label),
    );
    const when = (option?.meetings ?? []).map(meetingWhen).filter(Boolean).join(", ");
    setStatus(`${group.label} saved: ${when ? `${when} ` : ""}(${label}).`);
    onChanged(updated);
  }

  /**
   * One tap chooses and saves. Safe to make immediate because it is trivially
   * reversible -- another tap replaces it -- and nothing reaches a real
   * calendar until the student syncs. A Save button here only added a step
   * between the answer and the answer being true.
   */
  function choose(group: SectionGroup, label: string) {
    const next = { ...answersRef.current, [group.kind]: label };
    answersRef.current = next;
    setAnswers(next);
    setFailed(null);
    savingRef.current = { kind: group.kind, label };
    setSaving({ kind: group.kind, label });
    setStatus(`Saving your ${group.label.toLowerCase()}…`);
    const fold = viaPointer.current;
    if (pendingSave.current) clearTimeout(pendingSave.current);
    pendingSave.current = setTimeout(() => void save(group, label, fold), KEY_WALK_MS);
  }

  function collapse(group: SectionGroup) {
    setReopened((prev) => prev.filter((kind) => kind !== group.kind));
    setFocusAfter(changeId(group.kind));
  }

  function expand(group: SectionGroup) {
    const chosen = answerFor(group);
    setReopened((prev) => (prev.includes(group.kind) ? prev : [...prev, group.kind]));
    // A radio group is entered at its current answer, not at the top of the list.
    if (chosen) setFocusAfter(optionId(group.kind, chosen));
  }

  function onCardKeyDown(event: KeyboardEvent<HTMLFieldSetElement>, group: SectionGroup) {
    if (event.key !== "Escape") {
      viaPointer.current = false;
      return;
    }
    if (answerFor(group) === null) return;
    event.stopPropagation();
    collapse(group);
  }

  /** The other end of the arrow walk: the card folds when focus moves off it. */
  function onCardBlur(event: FocusEvent<HTMLFieldSetElement>, group: SectionGroup) {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    if ((answersRef.current[group.kind] ?? group.chosen) === null) return;
    // A save still in flight owns the fold, and knows where to put focus.
    if (savingRef.current?.kind === group.kind) return;
    setReopened((prev) => prev.filter((kind) => kind !== group.kind));
  }

  return (
    <div id={`section-chooser-${course.id}`} className="scroll-mt-24 space-y-2">
      {/* Two open questions and one answered is a state the student has to be
          able to see; without it, answering the lecture looks like finishing. */}
      {groups.length > 1 ? (
        <p className="flex items-center justify-between gap-2 text-[0.6875rem] font-semibold tracking-[0.12em] text-muted uppercase">
          <span className="whitespace-nowrap">Your sections</span>
          {/* The rule is the first thing to go: at 320 the two labels only fit
              because nothing sits between them. */}
          <span aria-hidden="true" className="hidden h-px flex-1 bg-line sm:block" />
          <span className="whitespace-nowrap tabular-nums">
            {answered} of {groups.length} chosen
          </span>
        </p>
      ) : null}

      {groups.map((group) => {
        const chosen = answerFor(group);
        const open = chosen === null || reopened.includes(group.kind);
        if (!open) {
          return (
            <AnsweredLine
              key={group.kind}
              group={group}
              chosen={chosen}
              buttonId={changeId(group.kind)}
              onChange={() => expand(group)}
            />
          );
        }

        const error = failed?.kind === group.kind ? failed.message : null;
        return (
          <fieldset
            key={group.kind}
            onKeyDown={(event) => onCardKeyDown(event, group)}
            onBlur={(event) => onCardBlur(event, group)}
            className="rise min-w-0 rounded-lg border border-warn-line bg-warn-soft p-3 sm:p-3.5"
          >
            {/* Floated rather than left in the border: a legend long enough to
                wrap -- which "Which lecture section are you in?" is at 320px --
                is drawn straddling the card's top edge, and reads as broken. */}
            <legend className="float-left w-full text-[0.875rem] font-semibold text-ink">
              {group.question}
            </legend>
            <p className="clear-both pt-1 text-[0.8125rem] leading-relaxed text-ink-soft">
              The syllabus lists {group.options.length}. We&rsquo;ll put the one
              you pick on your calendar and leave the rest out.
            </p>

            <div className="mt-2.5 space-y-1.5">
              {group.options.map((option) => {
                const selected = chosen === option.label;
                const busy =
                  saving?.kind === group.kind && saving.label === option.label;
                /**
                 * Said out loud with the separators the layout only implies.
                 * The wrapping label would name this row too, but as one run
                 * of text -- "MW 8:00-9:50 AMWhitfield 120LEC 01" -- and the
                 * commas are what make it a sentence rather than a smear.
                 */
                const spoken = [
                  ...option.meetings.map((meeting) =>
                    [meetingWhen(meeting), meetingWhere(meeting)]
                      .filter(Boolean)
                      .join(", "),
                  ),
                  `section ${option.label}`,
                ]
                  .filter(Boolean)
                  .join(", ");
                return (
                  <label
                    key={option.label}
                    onPointerDown={() => {
                      viaPointer.current = true;
                    }}
                    className={`relative flex cursor-pointer flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg border px-2.5 py-2 transition-colors sm:gap-x-3 sm:px-3 sm:py-2.5 ${TOUCH_TARGET} ${
                      selected
                        ? "border-accent-line bg-surface"
                        : "border-line bg-surface/60 hover:bg-surface"
                    }`}
                  >
                    <input
                      type="radio"
                      id={optionId(group.kind, option.label)}
                      name={`${baseId}-${group.kind}`}
                      value={option.label}
                      aria-label={spoken}
                      checked={selected}
                      onChange={() => choose(group, option.label)}
                      className="peer sr-only"
                    />
                    {/* The input itself is clipped to nothing, so the ring it
                        would have drawn has to be drawn over the whole row. */}
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 rounded-lg peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent"
                    />
                    <span
                      aria-hidden="true"
                      className="flex h-[18px] w-[18px] shrink-0 items-center justify-center"
                    >
                      {busy ? (
                        <Spinner label="Saving" />
                      ) : selected ? (
                        <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-accent text-accent-on">
                          <CheckIcon width={11} height={11} />
                        </span>
                      ) : (
                        <span className="h-[18px] w-[18px] rounded-full border-2 border-line-strong" />
                      )}
                    </span>

                    {/* `basis` is the whole trick: below about 300px of row the
                        chip cannot sit beside the time without breaking
                        "MW 8:00–9:50 AM" in half, so it wraps under instead. */}
                    <span className="min-w-0 flex-1 basis-[7.5rem] space-y-1">
                      {option.meetings.map((meeting, index) => {
                        const when = meetingWhen(meeting);
                        const where = meetingWhere(meeting);
                        return (
                          <span key={index} className="block min-w-0">
                            <span className="block text-[0.875rem] leading-tight font-semibold text-ink sm:text-[0.9375rem]">
                              {when || meetingKindLabel(meeting.kind)}
                            </span>
                            {where ? (
                              <span className="mt-0.5 block text-[0.75rem] leading-snug text-muted">
                                {where}
                              </span>
                            ) : null}
                          </span>
                        );
                      })}
                    </span>

                    {/* Present so the student can check it against a
                        registration page — never the thing they scan for. */}
                    <span className="ml-auto shrink-0 rounded-sm border border-line-strong px-1.5 py-0.5 font-mono text-[0.6875rem] tracking-wide text-muted tabular-nums">
                      {option.label}
                    </span>
                  </label>
                );
              })}
            </div>

            {error ? (
              <p
                role="alert"
                className="mt-2.5 rounded-md border border-danger-line bg-danger-soft px-2.5 py-1.5 text-[0.75rem] leading-relaxed text-danger"
              >
                <span className="block font-medium">
                  Your {group.label.toLowerCase()} was not saved.
                </span>
                <span className="block">{error}</span>
              </p>
            ) : null}

            {chosen !== null ? (
              <p className="mt-2.5">
                <button
                  type="button"
                  onClick={() => collapse(group)}
                  className="rounded-sm text-[0.75rem] font-medium text-muted underline decoration-line-strong underline-offset-2 transition-colors hover:text-ink"
                >
                  Done
                </button>
              </p>
            ) : null}
          </fieldset>
        );
      })}

      <p role="status" aria-live="polite" className="sr-only">
        {status}
      </p>
    </div>
  );
}

/**
 * An answered question, folded back down to the one line it is worth: the kind,
 * when it meets, and the label in brackets for verification. Loud enough to
 * check at a glance, quiet enough that a finished course stops shouting.
 */
function AnsweredLine({
  group,
  chosen,
  buttonId,
  onChange,
}: {
  group: SectionGroup;
  chosen: string;
  buttonId: string;
  onChange: () => void;
}) {
  const option = group.options.find(
    (candidate) => normalizeSection(candidate.label) === normalizeSection(chosen),
  );
  const when = (option?.meetings ?? [])
    .map(meetingWhen)
    .filter(Boolean)
    .join(", ");

  return (
    <p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[0.8125rem] leading-snug text-muted">
      <span className="font-medium text-ink-soft">{group.label}</span>
      {when ? (
        <>
          <span aria-hidden="true">·</span>
          <span>{when}</span>
        </>
      ) : null}
      <span className="font-mono text-[0.75rem]">({chosen})</span>
      <button
        id={buttonId}
        type="button"
        aria-label={`Change your ${group.label.toLowerCase()}`}
        onClick={onChange}
        className="rounded-sm font-medium underline decoration-line-strong underline-offset-2 transition-colors hover:text-ink"
      >
        Change
      </button>
    </p>
  );
}
