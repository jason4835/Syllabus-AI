"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import type { Assessment, AssessmentKind } from "@/lib/types";
import { needsReview } from "@/lib/types";
import { apiDelete, apiPatch } from "@/components/api-client";
import { Badge } from "@/components/ui/badge";
import { Button, Spinner } from "@/components/ui/button";
import { AlertIcon, CheckIcon } from "@/components/icons";
import { formatDate, formatPercent, formatRelative, formatTime } from "@/components/format";
import { KIND_LABEL, isHighStakes, kindLabel } from "@/components/labels";

const KINDS = Object.keys(KIND_LABEL) as AssessmentKind[];

/**
 * The dashboard has three inline forms now -- this row, the course editor and
 * the roadmap's add-item form. They share one control and one label so an
 * inline form always looks like the same thing wherever it opens.
 */
export const FORM_INPUT =
  "w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-[0.875rem] text-ink placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-60";
export const FORM_LABEL = "block text-[0.75rem] font-medium text-muted";

/** Exactly the fields `PATCH /api/assessments/[id]` accepts from the editor. */
interface AssessmentPatch {
  title?: string;
  kind?: AssessmentKind;
  dueDate?: string | null;
  dueTime?: string | null;
  weightPercent?: number | null;
  notes?: string | null;
}

/** Form state is all strings — an empty field means "clear this value". */
interface Draft {
  title: string;
  kind: AssessmentKind;
  dueDate: string;
  dueTime: string;
  weightPercent: string;
  notes: string;
}

function toDraft(assessment: Assessment): Draft {
  return {
    title: assessment.title,
    kind: assessment.kind,
    dueDate: assessment.dueDate ?? "",
    dueTime: assessment.dueTime ?? "",
    weightPercent:
      assessment.weightPercent === null ? "" : String(assessment.weightPercent),
    notes: assessment.notes ?? "",
  };
}

/**
 * Only what actually changed goes over the wire: the route stamps `reviewedAt`
 * on any accepted change, so sending untouched fields would silently mark an
 * item reviewed that the user only glanced at.
 */
function buildPatch(
  assessment: Assessment,
  draft: Draft,
): { patch: AssessmentPatch } | { error: string } {
  const patch: AssessmentPatch = {};

  const title = draft.title.trim();
  if (title.length === 0) return { error: "Give this item a title." };
  if (title !== assessment.title) patch.title = title;

  if (draft.kind !== assessment.kind) patch.kind = draft.kind;

  const dueDate = draft.dueDate.trim() || null;
  if (dueDate !== assessment.dueDate) patch.dueDate = dueDate;

  const dueTime = draft.dueTime.trim() || null;
  if (dueTime !== assessment.dueTime) patch.dueTime = dueTime;

  const rawWeight = draft.weightPercent.trim();
  let weightPercent: number | null = null;
  if (rawWeight.length > 0) {
    const parsed = Number(rawWeight);
    if (!Number.isFinite(parsed)) {
      return { error: "Weight must be a number between 0 and 100." };
    }
    weightPercent = parsed;
  }
  if (weightPercent !== assessment.weightPercent) {
    patch.weightPercent = weightPercent;
  }

  const notes = draft.notes.trim() || null;
  if (notes !== assessment.notes) patch.notes = notes;

  return { patch };
}

export interface AssessmentRowProps {
  assessment: Assessment;
  courseCode: string;
  color: string;
  /** Show the "in 5 days" column — off inside week-scoped lists. */
  showRelative?: boolean;
  /** Surface the review warning for low-confidence, unconfirmed items. */
  showConfidence?: boolean;
  /**
   * Hand the server's updated item back to whoever owns the list. Editing and
   * confirming are only offered when this is present — without a way to put the
   * result somewhere, the controls would lie.
   */
  onChanged?: (updated: Assessment) => void;
  /**
   * Removal lives inside the editor, not on the row: deleting is rare next to
   * fixing, and a delete button sitting under every item is a hazard. Offered
   * only when someone is listening -- otherwise the row would vanish from the
   * server and stay on the screen.
   */
  onDeleted?: (id: string) => void;
}

export function AssessmentRow({
  assessment,
  courseCode,
  color,
  showRelative = true,
  showConfidence = false,
  onChanged,
  onDeleted,
}: AssessmentRowProps) {
  const fieldId = useId();
  const sourceId = `${fieldId}-source`;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => toDraft(assessment));
  const [pending, setPending] = useState<"confirm" | "save" | "delete" | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  /**
   * On a phone there is no hover, so a hover-revealed Edit would be the only
   * way to fix bad data and be invisible. Ask the pointer instead of guessing.
   */
  const [coarsePointer, setCoarsePointer] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const query = window.matchMedia("(hover: none)");
    const sync = () => setCoarsePointer(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (editing) titleRef.current?.focus();
  }, [editing]);

  const editable = typeof onChanged === "function";
  const flagged = showConfidence && needsReview(assessment);

  function openEditor() {
    setDraft(toDraft(assessment));
    setError(null);
    setConfirmingDelete(false);
    setEditing(true);
  }

  function closeEditor() {
    setEditing(false);
    setError(null);
    setConfirmingDelete(false);
  }

  function patch(field: keyof Draft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  async function send(body: AssessmentPatch | { reviewed: true }, mode: "confirm" | "save") {
    setPending(mode);
    setError(null);
    const result = await apiPatch<Assessment>(
      `/api/assessments/${assessment.id}`,
      body,
    );
    setPending(null);
    if (!result.ok) {
      setError(result.detail ?? result.error);
      return false;
    }
    onChanged?.(result.data);
    return true;
  }

  async function confirm() {
    await send({ reviewed: true }, "confirm");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const built = buildPatch(assessment, draft);
    if ("error" in built) {
      setError(built.error);
      return;
    }
    // Nothing edited: closing quietly beats a pointless round trip that would
    // stamp the item as reviewed.
    if (Object.keys(built.patch).length === 0) {
      closeEditor();
      return;
    }
    if (await send(built.patch, "save")) closeEditor();
  }

  async function remove() {
    setPending("delete");
    setError(null);
    const result = await apiDelete<{ deleted: boolean }>(
      `/api/assessments/${assessment.id}`,
    );
    setPending(null);
    if (!result.ok) {
      setError(result.detail ?? result.error);
      setConfirmingDelete(false);
      return;
    }
    // The row is about to be unmounted by its owner; no local state to settle.
    onDeleted?.(assessment.id);
  }

  function onFormKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    // One Escape backs out of the delete question, the next closes the editor.
    if (confirmingDelete) {
      setConfirmingDelete(false);
      return;
    }
    closeEditor();
  }

  if (editing) {
    return (
      <li className="py-3">
        <form
          noValidate
          onSubmit={(event) => void save(event)}
          onKeyDown={onFormKeyDown}
          aria-label={`Edit ${assessment.title}`}
          className="rounded-lg border border-line bg-raised p-3"
          style={{ borderLeft: `3px solid ${color}` }}
        >
          <p className="text-[0.75rem] font-semibold tracking-wide text-ink-soft">
            {courseCode}
          </p>

          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <FormField
              label="Title"
              htmlFor={`${fieldId}-title`}
              className="sm:col-span-2"
            >
              <input
                ref={titleRef}
                id={`${fieldId}-title`}
                type="text"
                autoComplete="off"
                value={draft.title}
                disabled={pending !== null}
                onChange={(event) => patch("title", event.target.value)}
                className={FORM_INPUT}
              />
            </FormField>

            <FormField label="Type" htmlFor={`${fieldId}-kind`}>
              <select
                id={`${fieldId}-kind`}
                value={draft.kind}
                disabled={pending !== null}
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

            <FormField
              label="Due date"
              htmlFor={`${fieldId}-date`}
              onClear={draft.dueDate ? () => patch("dueDate", "") : undefined}
              clearLabel={`Clear the due date for ${assessment.title}`}
            >
              <input
                id={`${fieldId}-date`}
                type="date"
                value={draft.dueDate}
                disabled={pending !== null}
                onChange={(event) => patch("dueDate", event.target.value)}
                className={FORM_INPUT}
              />
            </FormField>

            <FormField
              label="Due time"
              htmlFor={`${fieldId}-time`}
              onClear={draft.dueTime ? () => patch("dueTime", "") : undefined}
              clearLabel={`Clear the due time for ${assessment.title}`}
            >
              <input
                id={`${fieldId}-time`}
                type="time"
                value={draft.dueTime}
                disabled={pending !== null}
                onChange={(event) => patch("dueTime", event.target.value)}
                className={FORM_INPUT}
              />
            </FormField>

            <FormField
              label="Weight (% of grade)"
              htmlFor={`${fieldId}-weight`}
              onClear={
                draft.weightPercent ? () => patch("weightPercent", "") : undefined
              }
              clearLabel={`Clear the weight for ${assessment.title}`}
            >
              <input
                id={`${fieldId}-weight`}
                type="number"
                inputMode="decimal"
                min={0}
                max={100}
                step="any"
                placeholder="—"
                value={draft.weightPercent}
                disabled={pending !== null}
                onChange={(event) => patch("weightPercent", event.target.value)}
                className={FORM_INPUT}
              />
            </FormField>

            <FormField
              label="Notes"
              htmlFor={`${fieldId}-notes`}
              className="sm:col-span-2"
            >
              <textarea
                id={`${fieldId}-notes`}
                rows={2}
                value={draft.notes}
                disabled={pending !== null}
                onChange={(event) => patch("notes", event.target.value)}
                className={`${FORM_INPUT} resize-y`}
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
            <Button type="submit" size="sm" disabled={pending !== null}>
              {pending === "save" ? (
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
              disabled={pending !== null}
              onClick={closeEditor}
            >
              Cancel
            </Button>
            <span className="text-[0.6875rem] text-muted">Esc to cancel</span>

            {onDeleted ? (
              <span className="ml-auto flex flex-wrap items-center gap-2">
                {confirmingDelete ? (
                  <>
                    <span className="text-[0.75rem] font-medium text-danger">
                      Delete this item?
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={pending !== null}
                      onClick={() => void remove()}
                      className="border-danger-line text-danger hover:bg-danger-soft"
                    >
                      {pending === "delete" ? (
                        <Spinner label="Deleting" />
                      ) : null}
                      Delete
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={pending !== null}
                      onClick={() => setConfirmingDelete(false)}
                    >
                      Keep it
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={pending !== null}
                    onClick={() => setConfirmingDelete(true)}
                    className="border-danger-line text-danger hover:bg-danger-soft"
                  >
                    Delete
                  </Button>
                )}
              </span>
            ) : null}
          </div>
        </form>
      </li>
    );
  }

  const weight = formatPercent(assessment.weightPercent);
  const time = formatTime(assessment.dueTime);

  return (
    <li className="group flex items-start gap-3 py-3">
      <span
        aria-hidden="true"
        className="mt-0.5 h-9 w-1 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-[0.75rem] font-semibold tracking-wide text-ink-soft">
            {courseCode}
          </span>
          <span aria-hidden="true" className="text-line-strong">
            ·
          </span>
          <span className="text-[0.75rem] text-muted">
            {kindLabel(assessment.kind)}
          </span>
          {weight ? (
            <span className="text-[0.75rem] text-muted">
              · {weight} of grade
            </span>
          ) : null}
        </div>
        <p
          className={`mt-0.5 text-[0.9375rem] leading-snug text-ink ${
            isHighStakes(assessment.kind) ? "font-semibold" : "font-medium"
          }`}
        >
          {assessment.title}
        </p>
        <p className="mt-0.5 text-[0.8125rem] text-muted">
          {formatDate(assessment.dueDate)}
          {time ? ` · ${time}` : ""}
        </p>
        {assessment.notes ? (
          <p className="mt-1 text-[0.8125rem] leading-snug text-ink-soft">
            {assessment.notes}
          </p>
        ) : null}

        {flagged ? (
          <div className="mt-2 rounded-md border border-warn-line bg-warn-soft px-2.5 py-2">
            <p className="flex items-center gap-1.5 text-[0.75rem] font-medium text-warn">
              <AlertIcon width={13} height={13} />
              Low confidence · please confirm
              <span className="font-mono tabular-nums">
                ({Math.round(assessment.confidence * 100)}%)
              </span>
            </p>

            {editable ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  aria-label={`Confirm ${assessment.title} is correct`}
                  disabled={pending !== null}
                  onClick={() => void confirm()}
                >
                  {pending === "confirm" ? (
                    <Spinner label="Confirming" />
                  ) : (
                    <CheckIcon width={14} height={14} />
                  )}
                  Confirm
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={pending !== null}
                  onClick={openEditor}
                >
                  Edit
                </Button>
                {assessment.sourceText ? (
                  <button
                    type="button"
                    aria-expanded={showSource}
                    aria-controls={sourceId}
                    onClick={() => setShowSource((open) => !open)}
                    className="rounded-md px-1.5 py-1 text-[0.75rem] font-medium text-warn transition-colors hover:bg-warn-line/40"
                  >
                    {showSource ? "Hide source" : "Show source"}
                  </button>
                ) : null}
              </div>
            ) : null}

            {assessment.sourceText ? (
              showSource ? (
                <p
                  id={sourceId}
                  className="mt-2 text-[0.75rem] leading-relaxed text-ink-soft"
                >
                  From the syllabus: “{assessment.sourceText}”
                </p>
              ) : null
            ) : (
              <p className="mt-1.5 text-[0.75rem] leading-relaxed text-ink-soft">
                The extractor could not point at a clear line in the syllabus
                for this one. Check it against the original.
              </p>
            )}

            {error ? (
              <p
                role="alert"
                className="mt-2 text-[0.75rem] leading-relaxed text-danger"
              >
                {error}
              </p>
            ) : null}
          </div>
        ) : editable ? (
          <div className="mt-1">
            <button
              type="button"
              onClick={openEditor}
              className={`-ml-1.5 rounded-md px-1.5 py-1 text-[0.75rem] font-medium text-muted transition-colors hover:bg-raised hover:text-ink focus-visible:opacity-100 ${
                coarsePointer
                  ? "opacity-100"
                  : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
              }`}
            >
              Edit
            </button>
          </div>
        ) : null}
      </div>
      {showRelative ? (
        <div className="shrink-0 text-right">
          <span className="font-mono text-[0.75rem] whitespace-nowrap text-ink-soft tabular-nums">
            {formatRelative(assessment.dueDate)}
          </span>
          {flagged ? (
            <span className="mt-1 block">
              <Badge tone="warn">check</Badge>
            </span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Label + optional inline clear, so every control is named and nullable. */
export function FormField({
  label,
  htmlFor,
  className,
  onClear,
  clearLabel,
  children,
}: {
  label: string;
  htmlFor: string;
  className?: string;
  onClear?: () => void;
  clearLabel?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label htmlFor={htmlFor} className={FORM_LABEL}>
          {label}
        </label>
        {onClear ? (
          <button
            type="button"
            onClick={onClear}
            aria-label={clearLabel ?? `Clear ${label.toLowerCase()}`}
            className="rounded-sm text-[0.6875rem] font-medium text-muted transition-colors hover:text-ink"
          >
            Clear
          </button>
        ) : null}
      </div>
      {children}
    </div>
  );
}
