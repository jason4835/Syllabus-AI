"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { needsReview } from "@/lib/types";
import type { DragEvent } from "react";
import type { Assessment, Course } from "@/lib/types";
import { apiUpload, paywallOf } from "@/components/api-client";
import type { AppConfig, TermSummary } from "@/components/api-client";
import { Panel } from "@/components/ui/panel";
import { Button, Spinner } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ErrorState, Note } from "@/components/ui/states";
import { AlertIcon, CheckIcon, FileIcon, UploadIcon } from "@/components/icons";
import {
  AssessmentRow,
  FORM_INPUT,
  FormField,
} from "@/components/dashboard/assessment-row";
import { SectionChooser } from "@/components/dashboard/section-chooser";
import { SetupJump } from "@/components/dashboard/setup-card";
import { TermPassCard } from "@/components/dashboard/term-pass-card";
import {
  TermFields,
  emptyTermDraft,
  validateTermDraft,
} from "@/components/dashboard/term-form";
import type { TermDraft } from "@/components/dashboard/term-form";
import { sectionGroups } from "@/lib/sections";
import { setupQuestions } from "@/lib/setup";
import { formatDateRange, formatPercent, pluralize } from "@/components/format";

/** Mirrors the route's own limit, so the wording matches what the server says. */
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/**
 * Word's own type string, spelled out once: it is long enough that repeating it
 * in the `accept` attribute and in the rejection check invites a typo that would
 * silently refuse every .docx a student picks from a Windows file dialog.
 */
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
/** The legacy binary Word format, still what a department's shared drive holds. */
const DOC_MIME = "application/msword";

export interface UploadResult {
  courseId: string;
  course: Course;
  assessments: Assessment[];
  warnings: string[];
  /**
   * The id of the course this upload replaced, when it was sent with
   * `replace=<id>`. Absent from an older server, which only ever added.
   */
  replaced?: string | null;
  /**
   * Present only when Notion is connected. Optional rather than `| null`
   * because an older server (or one whose Notion routes are not deployed) just
   * omits the field, and the upload is still a success either way.
   */
  notion?: {
    pageUrl: string | null;
    hubUrl: string | null;
    error: string | null;
  } | null;
  /**
   * The term this course was filed under. Optional for the same reason `notion`
   * is: a server without the terms half deployed simply omits it.
   */
  term?: TermSummary | null;
  /**
   * True when the server inferred the term from the syllabus and created it
   * unconfirmed. The setup card is what asks about it — see `term-confirm` in
   * `@/lib/setup` — so this panel only has to make sure the page re-reads its
   * terms afterwards.
   */
  termSuggested?: boolean;
}

/** "Let the syllabus decide" — sends no term at all and lets the server infer one. */
const INFER_TERM = "";
/** The chooser's own option, not a term id: reveals the inline new-term form. */
const NEW_TERM = "new";

/** `YYYY-MM-DD` for today in the student's own zone, like every date they read. */
function todayIso(now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Which term a syllabus dropped right now most likely belongs to: the one
 * running today, else the one most recently created.
 *
 * A guess, and only ever a default -- the select is right there, and the server
 * re-decides from the syllabus itself when nothing is sent. Today's term beats
 * the newest one because a student uploading in week two of the autumn has
 * usually just created the autumn term, and one uploading a late add in October
 * has not.
 */
function defaultTermId(terms: TermSummary[], now = new Date()): string {
  const today = todayIso(now);
  const current = terms.find(
    (term) =>
      term.startDate !== null &&
      term.endDate !== null &&
      term.startDate <= today &&
      today <= term.endDate,
  );
  if (current) return current.id;
  const newest = [...terms].sort((a, b) =>
    (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
  )[0];
  return newest ? newest.id : INFER_TERM;
}

/** What the 409 says we already have. */
export interface DuplicateCourse {
  id: string;
  code: string;
  title: string;
  term: string | null;
}

type Phase =
  | { kind: "idle" }
  | { kind: "uploading"; fileName: string; percent: number }
  | { kind: "parsing"; fileName: string }
  | { kind: "done"; result: UploadResult }
  /** The file is held here, so answering the question never means re-picking it. */
  | { kind: "duplicate"; file: File; duplicate: DuplicateCourse }
  /**
   * A file was picked for a term whose free course is already used, so nothing
   * was sent. The file is HELD -- it never left the browser, so re-attempting it
   * against a term with room costs nothing and must not cost the student a trip
   * back to the file picker.
   *
   * This is an answer to an attempt, never a state the panel opens in: a card
   * that appeared on load, before anyone had done anything, would read as a
   * popup no matter how it was styled.
   */
  | { kind: "blocked"; file: File; term: TermSummary }
  /**
   * The server's 402, after a parse. The file is NOT held here -- the parse
   * already happened and re-sending the same bytes would spend another one -- so
   * the card stands until another term is chosen or the pass is bought, and the
   * page's term refetch clears it.
   */
  | { kind: "paywall"; term: TermSummary }
  /**
   * `file` is the one that failed, when there was one and retrying it makes
   * sense. "Try again" only reset the panel, so the student had to find and
   * re-pick the same file -- a retry button that does not retry.
   *
   * Absent for the validation failures that would simply fail again (wrong
   * type, too large, empty); there the fix is a different file, and the message
   * already says so.
   */
  | { kind: "error"; error: string; detail?: string; file?: File; fields?: Record<string, string> };

/**
 * The upload route answers a duplicate with a 409 carrying `duplicateOf`. The
 * shared client hands back the envelope, not the status, so the field itself is
 * the signal -- and it is read defensively, because a server that has not
 * shipped this yet simply will not send it.
 */
function readDuplicate(result: unknown): DuplicateCourse | null {
  if (typeof result !== "object" || result === null) return null;
  const value = (result as { duplicateOf?: unknown }).duplicateOf;
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  return {
    id: record.id,
    code: typeof record.code === "string" ? record.code : "this course",
    title: typeof record.title === "string" ? record.title : "",
    term: typeof record.term === "string" ? record.term : null,
  };
}

export function UploadPanel({
  demoMode,
  accent,
  terms = [],
  config = null,
  onUploaded,
  onAssessmentChanged,
  onCourseChanged,
  onCourseReplaced,
  onAnswerQuestions,
}: {
  demoMode: boolean;
  /** Accent the newly added course will carry elsewhere in the dashboard. */
  accent: string;
  /**
   * The student's terms, for the chooser above the dropzone. Empty is a real
   * state -- a first upload has no terms to choose from, and the server infers
   * one from the syllabus.
   */
  terms?: TermSummary[];
  /** Needed only by the paywall card; null while `/api/config` is in flight. */
  config?: AppConfig | null;
  onUploaded: (result: UploadResult) => void;
  /** Hand a confirmed or edited item back to the shell. */
  onAssessmentChanged?: (updated: Assessment) => void;
  /**
   * A course edited from inside this card — picking a section, so far. The
   * card holds its own copy of the course, so it updates here as well as in
   * the shell; otherwise the question would still be on screen after it was
   * answered.
   */
  onCourseChanged?: (updated: Course) => void;
  /**
   * A replace swaps one course for another: the shell has to drop the old one
   * and its assessments, which a plain "uploaded" would not tell it to do.
   */
  onCourseReplaced?: (oldCourseId: string, result: UploadResult) => void;
  /**
   * Send the student to this course's setup card on the roadmap. The questions
   * that are not answerable here — a term start, a class time, a weekly day —
   * are asked there, and a count with no way to reach them is a nag.
   */
  onAnswerQuestions?: (courseId: string) => void;
}) {
  const inputId = useId();
  const fieldId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  /**
   * Which term the next upload goes into: a term id, `INFER_TERM` (send
   * nothing), or `NEW_TERM` (the inline form below).
   */
  const [termChoice, setTermChoice] = useState<string>(INFER_TERM);
  const [termDraft, setTermDraft] = useState<TermDraft>(() => emptyTermDraft());
  const [termError, setTermError] = useState<string | null>(null);
  /**
   * The default is applied once, the first time terms arrive. Re-applying it on
   * every refetch would quietly undo a choice the student had already made --
   * and a refetch happens after every upload.
   */
  const defaulted = useRef(false);
  useEffect(() => {
    if (defaulted.current || terms.length === 0) return;
    defaulted.current = true;
    setTermChoice(defaultTermId(terms));
  }, [terms]);

  const selectedTerm =
    termChoice === INFER_TERM || termChoice === NEW_TERM
      ? null
      : (terms.find((term) => term.id === termChoice) ?? null);

  /** The term has no room and the student asked to see the pass anyway. */
  const [unlockOpen, setUnlockOpen] = useState(false);

  /**
   * The paywall as an ANSWER: a file was picked for a full term (nothing sent),
   * or the server refused one after the parse. Both replace the dropzone,
   * because in both cases the next step is a decision about the term and not
   * another file. Neither is derived from the selection alone -- see the
   * `blocked` phase.
   */
  const attempt: { term: TermSummary; fileName: string | null } | null =
    phase.kind === "blocked"
      ? { term: phase.term, fileName: phase.file.name }
      : phase.kind === "paywall"
        ? { term: phase.term, fileName: null }
        : null;

  /** A term is selected, and it has no room for another course. */
  const selectedIsFull = selectedTerm !== null && !selectedTerm.canAddCourse;

  /**
   * "Choose a different term" is a pointer at the chooser, not a change of it:
   * silently moving someone's selection to make a card go away is the app
   * deciding for them. Picking one with room clears the card -- and, when a file
   * is being held, picks the upload back up where it left off.
   */
  const chooseAnotherTerm = useCallback(() => {
    selectRef.current?.focus();
  }, []);
  /**
   * The one handle on a request already in flight. A hung upload used to be
   * unstoppable: no timeout, no signal, and the reset control hidden while
   * busy — the only way out was reloading the page.
   */
  const abortRef = useRef<AbortController | null>(null);

  // Leaving the panel must not leave a request running against a dead setState.
  useEffect(() => () => abortRef.current?.abort(), []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase({ kind: "idle" });
  }, []);

  const onRowChanged = useCallback(
    (updated: Assessment) => {
      setPhase((current) =>
        current.kind === "done"
          ? {
              kind: "done",
              result: {
                ...current.result,
                assessments: current.result.assessments.map((item) =>
                  item.id === updated.id ? updated : item,
                ),
              },
            }
          : current,
      );
      onAssessmentChanged?.(updated);
    },
    [onAssessmentChanged],
  );

  const onCourseSaved = useCallback(
    (updated: Course) => {
      setPhase((current) =>
        current.kind === "done" && current.result.course.id === updated.id
          ? { kind: "done", result: { ...current.result, course: updated } }
          : current,
      );
      onCourseChanged?.(updated);
    },
    [onCourseChanged],
  );
  const [dragging, setDragging] = useState(false);

  const busy = phase.kind === "uploading" || phase.kind === "parsing";

  /**
   * One line about the selected term, under the select. What a student needs to
   * know before the file moves is whether this course is the free one — said as
   * a fact, not as a nudge.
   */
  const termHint =
    termChoice === NEW_TERM
      ? null
      : selectedTerm === null
        ? "The dates in your syllabus decide. You can move the course afterwards."
        : selectedTerm.access === "premium"
          ? "Term Pass active — every course in this term is unlocked."
          : selectedTerm.access === "expired"
            ? "The pass for this term has run out."
            : selectedTerm.canAddCourse
              ? "Your first course in this term is free."
              // Said by the line below instead, which carries the way out of it.
              : null;

  /**
   * What one term choice means on the wire, decided in one place so the picker,
   * the drop handler and the re-attempt cannot disagree about it.
   *
   * `choice` is passed in rather than read from state because the re-attempt
   * happens in the same tick as the change that triggered it, when `termChoice`
   * still holds the old value.
   */
  const resolveTermFields = useCallback(
    (
      choice: string,
    ):
      | { kind: "ok"; fields: Record<string, string> }
      | { kind: "invalid"; error: string }
      | { kind: "blocked"; term: TermSummary } => {
      if (choice === NEW_TERM) {
        const checked = validateTermDraft(termDraft);
        if ("error" in checked) return { kind: "invalid", error: checked.error };
        return { kind: "ok", fields: { newTerm: JSON.stringify(checked.input) } };
      }
      const term =
        choice === INFER_TERM
          ? null
          : (terms.find((candidate) => candidate.id === choice) ?? null);
      // Nothing sent: the server reads the term out of the syllabus itself.
      if (term === null) return { kind: "ok", fields: {} };
      // The courtesy check. The server repeats it after the parse; doing it here
      // is what stops a student paying for an extraction they cannot keep.
      if (!term.canAddCourse) return { kind: "blocked", term };
      return { kind: "ok", fields: { termId: term.id } };
    },
    [termDraft, terms],
  );

  const send = useCallback(
    async (
      file: File,
      fields?: Record<string, string>,
      /** The term to send it to, when it is not the one in state yet. */
      choiceOverride?: string,
    ) => {
      /**
       * PDF, Word or plain text. Three layers used to disagree about the last
       * one: the server accepted `.txt`, this check refused it, the description
       * said "PDF only", and the file dialog would not offer it -- while the
       * parser's own error messages suggested pasting text that had nowhere to
       * go. Text is the honest answer for the case that most needs one: a
       * scanned syllabus has no text layer, and copying it into a .txt file is
       * something a student can actually do.
       *
       * The MIME fallbacks cover a file whose extension is missing or wrong but
       * whose type the browser recognised; the bytes themselves are checked on
       * the server, which is the only place that can.
       */
      if (
        !/\.(pdf|docx?|txt)$/i.test(file.name) &&
        file.type !== "application/pdf" &&
        file.type !== DOCX_MIME &&
        file.type !== DOC_MIME
      ) {
        setPhase({
          kind: "error",
          error: "That file is not a PDF, a Word document or a text file",
          detail: `“${file.name}” could not be read. Export your syllabus as a PDF or a Word document, or paste its text into a .txt file, and try again.`,
        });
        return;
      }
      /**
       * The server rejects this at 15 MB, and it did so only after the whole
       * file had crossed the wire — an 18 MB syllabus on hotel wifi spent two
       * minutes uploading to be told no. The browser knows the size before a
       * byte moves, so the answer comes from here, in the server's own words.
       */
      if (file.size > MAX_UPLOAD_BYTES) {
        setPhase({
          kind: "error",
          error: `That file is ${(file.size / 1048576).toFixed(1)} MB. The limit is 15 MB.`,
          detail: "Export or compress the syllabus below 15 MB and try again.",
        });
        return;
      }
      if (file.size === 0) {
        setPhase({ kind: "error", error: "That file is empty." });
        return;
      }

      /**
       * The term, as one multipart field: an id when a term was picked, a JSON
       * `TermInput` when one is being created here, and nothing at all when the
       * syllabus is left to decide.
       *
       * A term with no room stops the upload HERE, holding the file: this is the
       * moment the paywall is about, and it is the first moment it appears.
       */
      const resolved = resolveTermFields(choiceOverride ?? termChoice);
      if (resolved.kind === "invalid") {
        setTermError(resolved.error);
        return;
      }
      if (resolved.kind === "blocked") {
        setPhase({ kind: "blocked", file, term: resolved.term });
        return;
      }
      setTermError(null);
      /** A retry's own fields (`replace`, `allowDuplicate`) win over nothing here. */
      const allFields = { ...resolved.fields, ...fields };

      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;

      setPhase({ kind: "uploading", fileName: file.name, percent: 0 });

      const result = await apiUpload<UploadResult>("/api/upload", file, {
        fields: allFields,
        signal: controller.signal,
        onProgress: (percent) => {
          setPhase((current) =>
            current.kind === "uploading"
              ? { ...current, percent }
              : current,
          );
          if (percent >= 100) {
            setPhase((current) =>
              current.kind === "uploading"
                ? { kind: "parsing", fileName: current.fileName }
                : current,
            );
          }
        },
      });

      if (controller.signal.aborted) return;
      abortRef.current = null;

      if (!result.ok) {
        // The 402 before the 409: a term that is full is not a question about
        // this file, and retrying it would spend another parse to be told the
        // same thing.
        const paywall = paywallOf(result);
        if (paywall) {
          setPhase({ kind: "paywall", term: paywall.term });
          return;
        }
        const duplicate = readDuplicate(result);
        if (duplicate) {
          setPhase({ kind: "duplicate", file, duplicate });
          return;
        }
        setPhase({
          kind: "error",
          error: result.error,
          detail: result.detail,
          file,
          fields: allFields,
        });
        return;
      }
      setPhase({ kind: "done", result: result.data });

      /**
       * A term just created here becomes the selection, so a second syllabus
       * for the same semester does not have to be told about it twice — and the
       * form does not sit there holding a term that already exists.
       */
      const created = result.data.term ?? null;
      if ((choiceOverride ?? termChoice) === NEW_TERM && created) {
        setTermChoice(created.id);
        setTermDraft(emptyTermDraft());
      }

      // `replaced` comes from the server; the id we sent is the fallback for a
      // server that performs the swap without reporting it.
      const replacedId = result.data.replaced ?? allFields.replace ?? null;
      if (replacedId && onCourseReplaced) onCourseReplaced(replacedId, result.data);
      else onUploaded(result.data);
    },
    [onUploaded, onCourseReplaced, termChoice, resolveTermFields],
  );

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    const file = event.dataTransfer.files?.[0];
    if (file) void send(file);
  };

  return (
    <Panel
      id="upload"
      title="Upload a syllabus"
      icon={<UploadIcon width={17} height={17} />}
      description={
        demoMode
          ? "Demo mode parses your file with the built-in fixture extractor."
          : "PDF, Word (.docx or .doc) or .txt. One course per file."
      }
      action={
        busy ? (
          // Always an exit: this used to disappear exactly when a stuck upload
          // made it the only control worth having.
          <Button variant="secondary" size="sm" onClick={cancel}>
            Cancel
          </Button>
        ) : phase.kind === "done" || phase.kind === "error" ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setPhase({ kind: "idle" })}
          >
            Upload another
          </Button>
        ) : null
      }
    >
      {phase.kind === "done" ? (
        <ExtractionResult
          result={phase.result}
          accent={accent}
          onChanged={onAssessmentChanged ? onRowChanged : undefined}
          onCourseChanged={onCourseChanged ? onCourseSaved : undefined}
          onAnswerQuestions={onAnswerQuestions}
        />
      ) : (
        <div className="space-y-3">
          {/* Above the dropzone, because it is the one decision that has to be
              made before the file moves — and after it, a wrong term costs a
              parse. "Let the syllabus decide" stays the honest default: the
              server reads the dates out of the document either way. */}
          <div>
            <FormField
              label="Add it to"
              htmlFor={`${fieldId}-term`}
              hint={termHint}
            >
              <select
                ref={selectRef}
                id={`${fieldId}-term`}
                value={termChoice}
                disabled={busy}
                aria-describedby={termHint ? `${fieldId}-term-hint` : undefined}
                onChange={(event) => {
                  const next = event.target.value;
                  setTermError(null);
                  setUnlockOpen(false);
                  setTermChoice(next);
                  // A 402 belongs to the term it came from; a new choice retires
                  // it. The parse it cost is gone either way, so there is no file
                  // to pick back up.
                  if (phase.kind === "paywall") setPhase({ kind: "idle" });
                  /**
                   * A held file and a term with room: carry on. The student
                   * already said "upload this" once, and asking them to say it
                   * again is the panel forgetting what it is holding. A choice
                   * with no room re-blocks against the new term, which is the
                   * truthful answer rather than a stale card.
                   */
                  if (phase.kind === "blocked" && next !== NEW_TERM) {
                    void send(phase.file, undefined, next);
                  }
                }}
                className={FORM_INPUT}
              >
                <option value={INFER_TERM}>Let the syllabus decide</option>
                {terms.map((term) => (
                  <option key={term.id} value={term.id}>
                    {term.name} — {formatDateRange(term.startDate, term.endDate)}
                  </option>
                ))}
                <option value={NEW_TERM}>New term…</option>
              </select>
            </FormField>

            {termChoice === NEW_TERM ? (
              <div className="mt-2.5 rounded-lg border border-line bg-raised p-3">
                <TermFields
                  draft={termDraft}
                  fieldId={`${fieldId}-new`}
                  disabled={busy}
                  onChange={(changes) => {
                    setTermError(null);
                    setTermDraft((current) => ({ ...current, ...changes }));
                  }}
                />
              </div>
            ) : null}

            {termError ? (
              <p
                role="alert"
                className="mt-2 rounded-md border border-danger-line bg-danger-soft px-2.5 py-1.5 text-[0.75rem] leading-relaxed text-danger"
              >
                {termError}
              </p>
            ) : null}

            {/* One muted line, not a card: a term with no room is a fact about
                the term, and a returning student who came to read their roadmap
                should be told it in passing rather than sold to. The pass is one
                click away for anyone who wants it now. */}
            {selectedIsFull && !attempt ? (
              <p className="mt-2 flex flex-wrap items-baseline gap-x-1.5 text-[0.75rem] leading-relaxed text-muted">
                <span>
                  This term&rsquo;s free course is used — the next one needs a
                  Term Pass.
                </span>
                <button
                  type="button"
                  aria-expanded={unlockOpen}
                  onClick={() => setUnlockOpen((current) => !current)}
                  className="rounded-sm font-medium underline decoration-line-strong underline-offset-2 transition-colors hover:text-ink"
                >
                  {unlockOpen ? "Hide" : "Unlock"}
                </button>
              </p>
            ) : null}

            {selectedIsFull && !attempt && unlockOpen && config && selectedTerm ? (
              <div className="mt-2.5">
                <TermPassCard term={selectedTerm} config={config} />
              </div>
            ) : null}
          </div>

          {attempt ? (
            <div className="space-y-2">
              {/* The file is still here. Saying so is the difference between
                  "nothing happened" and "your file is gone". */}
              {attempt.fileName ? (
                <p className="text-[0.8125rem] leading-relaxed text-ink-soft">
                  <span className="break-all font-medium text-ink">
                    {attempt.fileName}
                  </span>{" "}
                  wasn&rsquo;t uploaded — {attempt.term.name} already has its free
                  course. Pick a term with room and it goes straight through.
                </p>
              ) : null}
              {config ? (
                <TermPassCard
                  term={attempt.term}
                  config={config}
                  onChooseDifferentTerm={chooseAnotherTerm}
                />
              ) : (
                <Note tone="warn">
                  {attempt.term.name} already has its free course. Loading your
                  payment options…
                </Note>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {/* The way on for a term typed into the form above, which the
                    select's own change cannot send on its own. */}
                {phase.kind === "blocked" && termChoice === NEW_TERM ? (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void send(phase.file)}
                  >
                    Upload into this new term
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setPhase({ kind: "idle" })}
                >
                  Not now
                </Button>
              </div>
            </div>
          ) : (
          <div
            onDragOver={(event) => {
              event.preventDefault();
              if (!busy) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors ${
              dragging
                ? "border-accent bg-accent-soft"
                : "border-line-strong bg-sunken/50"
            }`}
          >
            {busy ? (
              <div className="mx-auto max-w-xs">
                <p className="flex items-center justify-center gap-2 text-[0.875rem] font-medium text-ink">
                  <Spinner label="Working" />
                  {phase.kind === "uploading"
                    ? `Uploading ${phase.fileName}`
                    : "Reading the syllabus…"}
                </p>
                <div
                  role="progressbar"
                  aria-label="Upload progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={phase.kind === "uploading" ? phase.percent : 100}
                  className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-track"
                >
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-200"
                    style={{
                      width:
                        phase.kind === "uploading"
                          ? `${Math.max(4, phase.percent)}%`
                          : "100%",
                    }}
                  />
                </div>
                <p className="mt-2 text-[0.75rem] text-muted">
                  {phase.kind === "uploading"
                    ? `${phase.percent}% sent`
                    : "Extracting courses, dates and grading weights."}
                </p>
                <div className="mt-3">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={cancel}
                  >
                    Cancel this upload
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-accent-soft text-accent">
                  <FileIcon width={20} height={20} />
                </span>
                <p className="text-[0.9375rem] font-medium text-ink">
                  Drop a syllabus here
                </p>
                <p className="mt-1 text-[0.8125rem] text-muted">
                  or pick one from your computer
                </p>
                <div className="mt-4">
                  <label htmlFor={inputId} className="sr-only">
                    Syllabus file
                  </label>
                  <input
                    ref={inputRef}
                    id={inputId}
                    type="file"
                    /* Extensions as well as MIME types: a .docx dragged out of
                       Downloads sometimes carries no type at all, and a filter
                       built only from types greys it out in the dialog. */
                    accept={`application/pdf,.pdf,${DOCX_MIME},.docx,${DOC_MIME},.doc,text/plain,.txt`}
                    className="sr-only"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void send(file);
                      event.target.value = "";
                    }}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => inputRef.current?.click()}
                  >
                    Choose a file
                  </Button>
                </div>
              </>
            )}
          </div>
          )}

          {phase.kind === "duplicate" ? (
            <DuplicateChoice
              duplicate={phase.duplicate}
              fileName={phase.file.name}
              onReplace={() =>
                void send(phase.file, { replace: phase.duplicate.id })
              }
              onKeepBoth={() => void send(phase.file, { allowDuplicate: "1" })}
              onCancel={() => setPhase({ kind: "idle" })}
            />
          ) : null}

          {phase.kind === "error" ? (
            <ErrorState
              error={phase.error}
              detail={phase.detail}
              onRetry={
                phase.file
                  ? () => void send(phase.file as File, phase.fields)
                  : () => setPhase({ kind: "idle" })
              }
            />
          ) : null}
        </div>
      )}
    </Panel>
  );
}

/**
 * A duplicate is a question, not a failure: the parse worked, and both answers
 * are reasonable (a re-upload of a corrected syllabus, or two real sections).
 * The file stays in the phase, so answering costs one click and not a trip back
 * to the file picker.
 */
function DuplicateChoice({
  duplicate,
  fileName,
  onReplace,
  onKeepBoth,
  onCancel,
}: {
  duplicate: DuplicateCourse;
  fileName: string;
  onReplace: () => void;
  onKeepBoth: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="alert"
      className="rise rounded-lg border border-warn-line bg-warn-soft p-4"
    >
      <p className="flex items-start gap-2 text-[0.875rem] leading-relaxed font-medium text-ink">
        <span className="mt-0.5 shrink-0 text-warn">
          <AlertIcon width={15} height={15} />
        </span>
        <span>
          You already have{" "}
          <span className="font-mono text-[0.8125rem]">{duplicate.code}</span>
          {duplicate.term ? ` (${duplicate.term})` : ""} — Replace it, or keep
          both?
        </span>
      </p>
      <p className="mt-1.5 pl-7 text-[0.75rem] leading-relaxed text-ink-soft">
        Replacing deletes the old course and its items, then saves{" "}
        <span className="break-all">{fileName}</span> in its place. Keeping both
        leaves the existing course untouched.
      </p>
      <div className="mt-3 flex flex-wrap gap-2 pl-7">
        <Button size="sm" onClick={onReplace}>
          Replace it
        </Button>
        <Button size="sm" variant="secondary" onClick={onKeepBoth}>
          Keep both
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ExtractionResult({
  result,
  accent,
  onChanged,
  onCourseChanged,
  onAnswerQuestions,
}: {
  result: UploadResult;
  accent: string;
  onChanged?: (updated: Assessment) => void;
  onCourseChanged?: (updated: Course) => void;
  onAnswerQuestions?: (courseId: string) => void;
}) {
  const { course, assessments, warnings, notion, term } = result;
  const flagged = assessments.filter(needsReview);
  /**
   * The gaps this card cannot close. Sections are asked right here, so they are
   * not counted: a link promising three things to finish, one of which is the
   * radio group directly below it, is the panel talking about itself.
   *
   * A term the server inferred counts as one of them: the setup card asks about
   * it first, and a count that left it out would not match what the student
   * finds when they follow the link.
   */
  const elsewhere =
    setupQuestions(course, assessments).filter(
      (question) => question.kind !== "section",
    ).length + (result.termSuggested ? 1 : 0);
  const totalWeight = course.gradeWeights.reduce(
    (sum, row) => sum + row.weightPercent,
    0,
  );

  return (
    <div className="rise space-y-5">
      <div
        className="rounded-lg border border-line bg-raised p-4"
        style={{ borderLeft: `3px solid ${accent}` }}
      >
        <p className="flex items-center gap-1.5 text-[0.75rem] font-semibold tracking-wide text-ok">
          <CheckIcon width={14} height={14} />
          Extracted
        </p>
        <h3 className="mt-1.5 text-[1.125rem] leading-tight text-ink">
          <span className="font-mono text-[0.875rem] tracking-wide text-ink-soft">
            {course.code}
          </span>{" "}
          {course.title}
        </h3>
        <p className="mt-1 text-[0.8125rem] text-muted">
          {/* The term ROW's name when there is one — it is what the rest of the
              dashboard now groups this course under. `course.term` is the
              syllabus's own words, kept as the fallback. */}
          {[course.instructor, term?.name ?? course.term]
            .filter(Boolean)
            .join(" · ") || "No instructor or term listed"}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Badge tone="accent">
            {pluralize(assessments.length, "item")}
          </Badge>
          <Badge tone="neutral">
            {pluralize(course.gradeWeights.length, "grading row")}
          </Badge>
          {flagged.length > 0 ? (
            <Badge tone="warn">{flagged.length} to check</Badge>
          ) : null}
        </div>

        {/*
          Notion is a bonus on top of a finished upload, never a gate on it: a
          failure is reported as a quiet aside so the extraction above still
          reads as the success it is.
        */}
        {notion?.pageUrl ? (
          <a
            href={notion.pageUrl}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={`Open the Notion page for ${course.code}`}
            className="mt-3 inline-block rounded-sm text-[0.8125rem] font-medium text-accent transition-colors hover:text-ink"
          >
            Created your Notion page →
          </a>
        ) : notion?.error ? (
          <p className="mt-3 text-[0.75rem] leading-relaxed text-muted">
            Uploaded — Notion page couldn&rsquo;t be created: {notion.error}
          </p>
        ) : null}

        {/* Asked here, at the moment the syllabus is read, rather than left
            for the student to discover on a calendar full of other people's
            classes. It stays after the last answer rather than vanishing: the
            folded-down lines are the receipt for what was just chosen. */}
        {onCourseChanged && sectionGroups(course).length > 0 ? (
          <div className="mt-3.5">
            <SectionChooser course={course} onChanged={onCourseChanged} />
          </div>
        ) : null}

        {/* The other gaps are asked on the roadmap, where the items they place
            are visible. Named and counted here because this is the moment the
            student is thinking about this syllabus, and a term start typed now
            is seven dated items rather than seven surprises in October. */}
        {elsewhere > 0 ? (
          <p className="mt-3 text-[0.8125rem] leading-relaxed text-ink-soft">
            <SetupJump
              courseId={course.id}
              label={`${elsewhere} ${elsewhere === 1 ? "thing" : "things"} to finish for ${course.code}`}
              onClick={
                onAnswerQuestions ? () => onAnswerQuestions(course.id) : undefined
              }
            />{" "}
            — the syllabus left {elsewhere === 1 ? "it" : "them"} open, and your
            calendar stays incomplete until {elsewhere === 1 ? "it is" : "they are"}{" "}
            answered.
          </p>
        ) : null}
      </div>

      {warnings.length > 0 ? (
        <div>
          <h4 className="mb-2 text-[0.6875rem] font-semibold tracking-[0.12em] text-muted uppercase">
            Warnings
          </h4>
          <ul className="space-y-1.5">
            {warnings.map((warning, index) => (
              <li
                key={`${warning}-${index}`}
                className="flex items-start gap-2 rounded-md border border-warn-line bg-warn-soft px-3 py-2 text-[0.8125rem] leading-relaxed text-ink"
              >
                <span className="mt-0.5 shrink-0 text-warn">
                  <AlertIcon width={13} height={13} />
                </span>
                {warning}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {course.gradeWeights.length > 0 ? (
        <div>
          <h4 className="mb-2 text-[0.6875rem] font-semibold tracking-[0.12em] text-muted uppercase">
            Grading weights
          </h4>
          <ul className="space-y-1.5">
            {course.gradeWeights.map((row) => (
              <li key={row.category} className="flex items-center gap-3">
                <span className="w-28 shrink-0 truncate text-[0.8125rem] text-ink-soft sm:w-36">
                  {row.category}
                </span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-track">
                  <span
                    className="block h-full rounded-full"
                    style={{
                      width: `${Math.min(100, row.weightPercent)}%`,
                      backgroundColor: accent,
                    }}
                  />
                </span>
                <span className="w-11 shrink-0 text-right font-mono text-[0.8125rem] text-ink tabular-nums">
                  {formatPercent(row.weightPercent)}
                </span>
              </li>
            ))}
          </ul>
          {Math.abs(totalWeight - 100) > 0.5 ? (
            <div className="mt-2.5">
              <Note tone="warn">
                These weights add up to {formatPercent(totalWeight)}, not 100%.
                Worth a look at the original syllabus.
              </Note>
            </div>
          ) : null}
        </div>
      ) : (
        <Note>
          No grading breakdown was found in this syllabus. Weights will show as
          blank until you add them.
        </Note>
      )}

      <div>
        <h4 className="mb-1 text-[0.6875rem] font-semibold tracking-[0.12em] text-muted uppercase">
          Items found
        </h4>
        <ul className="divide-y divide-line">
          {assessments.map((assessment) => (
            <AssessmentRow
              key={assessment.id}
              assessment={assessment}
              courseCode={course.code}
              color={accent}
              showConfidence
              onChanged={onChanged}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}
