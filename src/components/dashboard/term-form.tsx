"use client";

import type { TermInput, TermType } from "@/lib/types";
import { TERM_TYPES } from "@/lib/types";
import {
  MAX_TERM_DAYS,
  PREMIUM_EDIT_SLACK_DAYS,
  validateTermInput,
} from "@/lib/terms";
import { Invalid } from "@/lib/validation";
import { TERM_TYPE_LABEL } from "@/components/labels";
import {
  FORM_INPUT,
  FormField,
} from "@/components/dashboard/assessment-row";

/**
 * The four fields a term is, and the one rule the client is allowed to know.
 *
 * Shared by the terms panel (new and edit), the upload panel's "New term…" and
 * the setup card's "Create Fall 2026?" -- three places that ask for the same
 * four values, and would otherwise disagree about what a term is by the second
 * one. The *validation* is shared too, and not by copying the messages:
 * `validateTermInput` is the server's own validator, pure and client-safe, so a
 * student reads the sentence the route would have sent rather than our
 * paraphrase of it.
 *
 * The premium edit policy is deliberately NOT mirrored here. It depends on
 * `paidEndDate` and a clock the client does not own, so the server decides it
 * and answers 409; all this file does is say up front that a paid term's end
 * date is bounded, so the refusal is not a surprise.
 */

/** Form state is all strings -- an empty date field means "not stated". */
export interface TermDraft {
  name: string;
  termType: TermType;
  startDate: string;
  endDate: string;
}

export function emptyTermDraft(name = ""): TermDraft {
  return { name, termType: "custom", startDate: "", endDate: "" };
}

export function toTermDraft(term: {
  name: string;
  termType: TermType;
  startDate: string | null;
  endDate: string | null;
}): TermDraft {
  return {
    name: term.name,
    termType: term.termType,
    startDate: term.startDate ?? "",
    endDate: term.endDate ?? "",
  };
}

/**
 * The draft as the routes take it, or the sentence to print above the form.
 *
 * `requireDates` is false for the one caller that has to accept a dateless
 * term: the setup card confirming a term inferred from a syllabus that never
 * said when it runs. Everywhere a person is typing a term from scratch, both
 * dates are asked for -- see `validateTermInput`.
 */
export function validateTermDraft(
  draft: TermDraft,
  opts?: { requireDates?: boolean },
): { input: TermInput } | { error: string } {
  try {
    return {
      input: validateTermInput(
        {
          name: draft.name,
          termType: draft.termType,
          startDate: draft.startDate || null,
          endDate: draft.endDate || null,
        },
        opts,
      ),
    };
  } catch (error) {
    return {
      error:
        error instanceof Invalid
          ? error.message
          : "Check the term name and dates.",
    };
  }
}

/** The six-month cap, said the way the form should say it before it is broken. */
export const TERM_LENGTH_HINT = `A term runs at most ${MAX_TERM_DAYS} days — about six months.`;

/** What a paid term's editor has to say before the server refuses an extension. */
export const PREMIUM_EDIT_HINT = `This term is paid for. Shortening it is always fine; the end date can only move about ${PREMIUM_EDIT_SLACK_DAYS} days past what you bought.`;

export function TermFields({
  draft,
  fieldId,
  disabled,
  onChange,
  /** Legend for the group. Omitted when the surrounding form already names it. */
  nameLabel = "Term name",
}: {
  draft: TermDraft;
  /** Prefix for the field ids, so labels point at the right inputs. */
  fieldId: string;
  disabled?: boolean;
  onChange: (changes: Partial<TermDraft>) => void;
  nameLabel?: string;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <FormField label={nameLabel} htmlFor={`${fieldId}-name`}>
        <input
          id={`${fieldId}-name`}
          type="text"
          autoComplete="off"
          placeholder="Fall 2026"
          value={draft.name}
          disabled={disabled}
          onChange={(event) => onChange({ name: event.target.value })}
          className={FORM_INPUT}
        />
      </FormField>

      <FormField label="Kind of term" htmlFor={`${fieldId}-type`}>
        <select
          id={`${fieldId}-type`}
          value={draft.termType}
          disabled={disabled}
          onChange={(event) =>
            onChange({ termType: event.target.value as TermType })
          }
          className={FORM_INPUT}
        >
          {TERM_TYPES.map((type) => (
            <option key={type} value={type}>
              {TERM_TYPE_LABEL[type]}
            </option>
          ))}
        </select>
      </FormField>

      <FormField label="First day" htmlFor={`${fieldId}-start`}>
        <input
          id={`${fieldId}-start`}
          type="date"
          value={draft.startDate}
          disabled={disabled}
          onChange={(event) => onChange({ startDate: event.target.value })}
          className={FORM_INPUT}
        />
      </FormField>

      <FormField
        label="Last day"
        htmlFor={`${fieldId}-end`}
        hint={TERM_LENGTH_HINT}
      >
        <input
          id={`${fieldId}-end`}
          type="date"
          aria-describedby={`${fieldId}-end-hint`}
          value={draft.endDate}
          disabled={disabled}
          onChange={(event) => onChange({ endDate: event.target.value })}
          className={FORM_INPUT}
        />
      </FormField>
    </div>
  );
}
