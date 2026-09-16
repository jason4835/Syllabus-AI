"use client";

import { useId, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import type { AcademicTerm } from "@/lib/types";
import {
  apiDelete,
  apiPatch,
  apiPost,
} from "@/components/api-client";
import type { AppConfig, TermSummary } from "@/components/api-client";
import { premiumExpiresAt } from "@/lib/terms";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Button, Spinner, TOUCH_TARGET } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/states";
import { LoadingRegion, SkeletonRows } from "@/components/ui/skeleton";
import { CalendarIcon, CheckIcon } from "@/components/icons";
import { formatDateRange, formatDateWithYear } from "@/components/format";
import { termTypeLabel } from "@/components/labels";
import { TermPassCard } from "@/components/dashboard/term-pass-card";
import {
  PREMIUM_EDIT_HINT,
  TermFields,
  emptyTermDraft,
  toTermDraft,
  validateTermDraft,
} from "@/components/dashboard/term-form";
import type { TermDraft } from "@/components/dashboard/term-form";

/**
 * The terms a student has, one line each.
 *
 * Deliberately the quietest panel on the page: a term is not something anyone
 * came here to manage, it is the thing their courses are grouped by and the
 * thing a pass is bought for. So the default state is rows -- name, kind, dates,
 * where it stands -- and every form (new, edit, the paywall itself) opens inline
 * under the row it belongs to rather than as a dialog over the dashboard.
 *
 * What a row must answer without being opened: how many free courses are left,
 * whether the pass is active and until when, and whether this term has run out.
 * "Free · 1 of 1 free" is a count, not a warning; the Unlock button only appears
 * on a term where another course actually needs one.
 */

/** Which inline form, if any, is open. Only ever one at a time. */
type Open =
  | { kind: "none" }
  | { kind: "new" }
  | { kind: "edit"; termId: string }
  | { kind: "unlock"; termId: string }
  | { kind: "delete"; termId: string };

export function TermsPanel({
  loading,
  error,
  terms,
  config,
  onRetry,
  onChanged,
}: {
  loading: boolean;
  error?: { error: string; detail?: string };
  terms: TermSummary[];
  config: AppConfig | null;
  onRetry: () => void;
  /**
   * A term created, edited or deleted. The shell re-reads `/api/terms` (and the
   * courses with them: a deleted term takes a `termId` off nothing, but an
   * edited one changes the name every course header prints).
   */
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<Open>({ kind: "none" });
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function close() {
    setOpen({ kind: "none" });
    setDeleteError(null);
  }

  async function removeTerm(term: TermSummary) {
    setDeleting(true);
    setDeleteError(null);
    const result = await apiDelete<{ deleted: boolean }>(
      `/api/terms/${term.id}`,
    );
    setDeleting(false);
    if (!result.ok) {
      setDeleteError(result.detail ?? result.error);
      return;
    }
    close();
    onChanged();
  }

  return (
    <Panel
      id="terms"
      title="Academic terms"
      icon={<CalendarIcon width={17} height={17} />}
      description="One course free in every term. The Term Pass unlocks the rest of that term."
      action={
        <Button
          variant="secondary"
          size="sm"
          aria-expanded={open.kind === "new"}
          onClick={() =>
            setOpen((current) =>
              current.kind === "new" ? { kind: "none" } : { kind: "new" },
            )
          }
        >
          New term
        </Button>
      }
    >
      {loading && terms.length === 0 ? (
        <LoadingRegion label="Loading your terms">
          <SkeletonRows rows={2} />
        </LoadingRegion>
      ) : error && terms.length === 0 ? (
        <ErrorState error={error.error} detail={error.detail} onRetry={onRetry} />
      ) : (
        <div className="space-y-3">
          {open.kind === "new" ? (
            <TermForm
              mode="create"
              onSaved={() => {
                close();
                onChanged();
              }}
              onCancel={close}
            />
          ) : null}

          {terms.length === 0 ? (
            <p className="text-[0.8125rem] leading-relaxed text-muted">
              No terms yet. Uploading a syllabus creates one from the dates in
              it, or add your own above.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {terms.map((term) => {
                const editing =
                  open.kind === "edit" && open.termId === term.id;
                const unlocking =
                  open.kind === "unlock" && open.termId === term.id;
                const confirmingDelete =
                  open.kind === "delete" && open.termId === term.id;
                /**
                 * Offered where another course in this term needs a pass: the
                 * free slot is used up, or the pass that covered it has lapsed.
                 * Never on a term that still has room -- an Unlock button on a
                 * term nothing is blocked in is an advert.
                 */
                const needsPass =
                  term.access !== "premium" &&
                  (!term.canAddCourse || term.access === "expired");
                const expires =
                  term.premiumExpiresAt ??
                  (term.endDate ? premiumExpiresAt(term.endDate) : null);

                return (
                  <li key={term.id} className="py-2.5 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
                      <div className="min-w-0">
                        <p className="text-[0.875rem] leading-snug font-medium text-ink">
                          {term.name}
                        </p>
                        <p className="mt-0.5 text-[0.75rem] leading-snug text-muted">
                          {termTypeLabel(term.termType)} ·{" "}
                          {formatDateRange(term.startDate, term.endDate)}
                        </p>
                        {term.access === "premium" && expires ? (
                          <p className="mt-0.5 text-[0.75rem] leading-snug text-muted">
                            Access through {formatDateWithYear(expires)}
                          </p>
                        ) : null}
                      </div>

                      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                        {term.access === "premium" ? (
                          <Badge tone="accent">Term Pass Active</Badge>
                        ) : term.access === "expired" ? (
                          <Badge tone="warn">Term Pass expired</Badge>
                        ) : (
                          <Badge tone="neutral">
                            Free · {term.courseCount} of {term.freeCourses} free
                          </Badge>
                        )}

                        {needsPass ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            aria-expanded={unlocking}
                            aria-label={`Unlock ${term.name}`}
                            onClick={() =>
                              setOpen(
                                unlocking
                                  ? { kind: "none" }
                                  : { kind: "unlock", termId: term.id },
                              )
                            }
                          >
                            Unlock
                          </Button>
                        ) : null}

                        <RowButton
                          expanded={editing}
                          label={`Edit ${term.name}`}
                          onClick={() =>
                            setOpen(
                              editing
                                ? { kind: "none" }
                                : { kind: "edit", termId: term.id },
                            )
                          }
                        >
                          Edit
                        </RowButton>

                        {/* Only an empty term can go: deleting one that holds
                            courses would either orphan them or take them with
                            it, and the server refuses either way (409). */}
                        {term.courseCount === 0 ? (
                          <RowButton
                            expanded={confirmingDelete}
                            label={`Delete ${term.name}`}
                            danger
                            onClick={() => {
                              setDeleteError(null);
                              setOpen(
                                confirmingDelete
                                  ? { kind: "none" }
                                  : { kind: "delete", termId: term.id },
                              );
                            }}
                          >
                            Delete
                          </RowButton>
                        ) : null}
                      </div>
                    </div>

                    {editing ? (
                      <div className="mt-2.5">
                        <TermForm
                          mode="edit"
                          term={term}
                          onSaved={() => {
                            close();
                            onChanged();
                          }}
                          onCancel={close}
                        />
                      </div>
                    ) : null}

                    {confirmingDelete ? (
                      <div className="mt-2.5 rounded-md border border-danger-line bg-danger-soft px-3 py-2.5">
                        <p className="text-[0.8125rem] leading-relaxed text-ink">
                          Delete {term.name}? It holds no courses, so nothing
                          else goes with it.
                        </p>
                        {deleteError ? (
                          <p
                            role="alert"
                            className="mt-1.5 text-[0.75rem] leading-relaxed text-danger"
                          >
                            That didn&rsquo;t delete — {deleteError}
                          </p>
                        ) : null}
                        <div className="mt-2.5 flex flex-wrap gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            aria-label={`Yes, delete ${term.name}`}
                            disabled={deleting}
                            onClick={() => void removeTerm(term)}
                            className="border-danger-line text-danger hover:bg-danger-soft"
                          >
                            {deleting ? <Spinner label="Deleting" /> : null}
                            Delete this term
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={deleting}
                            onClick={close}
                          >
                            Keep it
                          </Button>
                        </div>
                      </div>
                    ) : null}

                    {unlocking && config ? (
                      <div className="mt-2.5">
                        <TermPassCard term={term} config={config} />
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* One row's controls                                                         */
/* -------------------------------------------------------------------------- */

/** The quiet text button the roadmap's course header uses, so rows match it. */
function RowButton({
  label,
  expanded,
  danger,
  onClick,
  children,
}: {
  label: string;
  expanded: boolean;
  danger?: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={expanded}
      onClick={onClick}
      className={`rounded-md px-1.5 py-1 text-[0.75rem] font-medium text-muted transition-colors ${TOUCH_TARGET} ${
        danger
          ? "hover:bg-danger-soft hover:text-danger"
          : "hover:bg-raised hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* New / edit                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One form for both, because they ask for the same four things and a student
 * editing a term should not meet a different layout from the one they typed it
 * into. The only difference is where it POSTs and what it says on the button.
 */
function TermForm({
  mode,
  term,
  onSaved,
  onCancel,
}: {
  mode: "create" | "edit";
  term?: TermSummary;
  onSaved: (saved: AcademicTerm) => void;
  onCancel: () => void;
}) {
  const fieldId = useId();
  const [draft, setDraft] = useState<TermDraft>(() =>
    term ? toTermDraft(term) : emptyTermDraft(),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const checked = validateTermDraft(draft);
    if ("error" in checked) {
      setError(checked.error);
      return;
    }

    setPending(true);
    setError(null);
    const result =
      mode === "edit" && term
        ? await apiPatch<{ term: AcademicTerm }>(
            `/api/terms/${term.id}`,
            checked.input,
          )
        : await apiPost<{ term: AcademicTerm }>("/api/terms", checked.input);
    setPending(false);
    if (!result.ok) {
      // A 422 names the field and a 409 explains the premium bound; both put
      // the sentence worth reading in `detail`.
      setError(result.detail ?? result.error);
      return;
    }
    onSaved(result.data.term);
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
      aria-label={mode === "edit" && term ? `Edit ${term.name}` : "New term"}
      className="rounded-lg border border-line bg-raised p-3"
    >
      <p className="text-[0.75rem] font-semibold tracking-wide text-ink-soft">
        {mode === "edit" ? "Term details" : "New term"}
      </p>

      <div className="mt-2">
        <TermFields
          draft={draft}
          fieldId={fieldId}
          disabled={pending}
          onChange={(changes) =>
            setDraft((current) => ({ ...current, ...changes }))
          }
        />
      </div>

      {term?.premium ? (
        <p className="mt-2 text-[0.75rem] leading-relaxed text-muted">
          {PREMIUM_EDIT_HINT}
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="mt-2.5 rounded-md border border-danger-line bg-danger-soft px-2.5 py-1.5 text-[0.75rem] leading-relaxed text-danger"
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
          {mode === "edit" ? "Save term" : "Add term"}
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
