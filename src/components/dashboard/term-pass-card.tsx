"use client";

import { useEffect, useState } from "react";
import {
  apiPost,
  errorCodeOf,
  trackEvent,
  variantFor,
} from "@/components/api-client";
import type { AppConfig, TermSummary } from "@/components/api-client";
import { Button, LinkButton, Spinner } from "@/components/ui/button";
import { GoogleMark } from "@/components/icons";
import { formatDateRange } from "@/components/format";
import { termTypeLabel } from "@/components/labels";

/**
 * The paywall, and the only one in the app.
 *
 * Not a modal and not a pricing page: a card, in the same ground as every other
 * card on this dashboard, rendered where the thing it is about was being done --
 * in the upload panel instead of the dropzone, under the term's own row, inside
 * the course editor. A student meeting it has just tried to add a second course
 * to a term, so the card's job is to say what that costs and what they get, in
 * four lines, and then get out of the way. No countdown, no crossed-out price,
 * no "limited time": the offer is the same tomorrow.
 *
 * It states one fact and one sentence of value, then the price from the server.
 * The number is never written in this file -- `config.billing.termPass.display`
 * comes from `src/lib/pricing.ts`, which is the only place in the tree that
 * knows what the pass costs.
 */

/** The same sign-in the header, the demo banner and the account panel use. */
export const SIGN_IN_HREF = "/api/auth/google";

/**
 * Terms this page has already reported a paywall view for.
 *
 * Module scope, not a ref: the card is *derived* in the upload panel -- select a
 * full term, the card appears; select another, it unmounts -- so "once per
 * mount" would count one student flipping a select as a dozen students seeing a
 * paywall, and would spend the shared edit budget `/api/analytics` is metered
 * against doing it. One line per term per page load is the honest number.
 */
const reportedTerms = new Set<string>();

type Phase =
  | { kind: "idle" }
  | { kind: "pending" }
  /** The server said this visitor has no account to attach a payment to. */
  | { kind: "sign_in" }
  | { kind: "error"; error: string; detail?: string };

/**
 * The two paywall framings under test. Same price, same palette, same button.
 *
 * Declared here rather than inline so both arms are readable side by side --
 * an A/B test whose variants are scattered through JSX is one nobody can
 * review, and reviewing the copy is most of the work of writing it.
 */
const PAYWALL_COPY = {
  control: {
    heading: "Build your full term",
    body: "Your first course is free. Unlock all of your classes for this academic term.",
  },
  outcome: {
    heading: "Put the whole semester on your calendar",
    body: "One course is free. A Term Pass covers every class you are taking this term \u2014 every deadline, every study block, one payment, no subscription.",
  },
} as const;

export function TermPassCard({
  term,
  config,
  onChooseDifferentTerm,
}: {
  term: TermSummary;
  config: AppConfig;
  /**
   * Offered where another term is a real answer -- the upload panel, where the
   * student may simply have had the wrong term selected. Absent inside the
   * course editor, where the term is the thing being decided.
   */
  onChooseDifferentTerm?: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  /**
   * The paywall copy experiment.
   *
   * Control states the mechanism ("your first course is free"); `outcome`
   * states what the money buys. Same price in both arms -- the price is a
   * separate experiment, resolved on the server, and mixing the two into one
   * card would make neither result readable.
   *
   * Read through `variantFor`, so a server that has retired this experiment
   * renders the control rather than an empty card.
   */
  const variant = variantFor(config, "paywall_copy");
  const copy = PAYWALL_COPY[variant as keyof typeof PAYWALL_COPY] ?? PAYWALL_COPY.control;


  /**
   * Once per term. Also once per StrictMode double-effect, which the set handles
   * for free -- a development-only double count is the kind of thing that
   * quietly halves a conversion rate on the way out.
   */
  useEffect(() => {
    if (reportedTerms.has(term.id)) return;
    reportedTerms.add(term.id);
    trackEvent("second_course_paywall_viewed", {
      termId: term.id,
      courseCount: term.courseCount,
      // The denominator of the paywall conversion rate. Without the arm on the
      // view event, the purchases can be split by variant and the views cannot,
      // which makes the rate itself unmeasurable.
      variant,
    });
  }, [term.id, term.courseCount, config]);

  const billing = config.billing;
  const pass = billing?.termPass ?? null;
  /** No Stripe on this server, or no billing half of `/api/config` at all. */
  const payable = billing?.ready === true && pass !== null;
  const demo = config.demoMode || phase.kind === "sign_in";

  async function unlock() {
    setPhase({ kind: "pending" });
    const result = await apiPost<{ url: string }>(
      `/api/terms/${term.id}/checkout`,
    );
    if (result.ok) {
      // Stripe hosts the payment; leaving the app is the point of the button.
      window.location.assign(result.data.url);
      return;
    }
    if (errorCodeOf(result) === "sign_in_required") {
      setPhase({ kind: "sign_in" });
      return;
    }
    setPhase({ kind: "error", error: result.error, detail: result.detail });
  }

  const pending = phase.kind === "pending";

  return (
    <div className="rise rounded-lg border border-accent-line bg-accent-soft p-4 sm:p-5">
      <h3 className="text-[1.0625rem] leading-tight text-ink">
        {copy.heading}
      </h3>

      <p className="mt-1.5 text-[0.875rem] leading-relaxed text-ink-soft">
        {copy.body}
      </p>

      {/* Which term this is about. The card can appear in three places, and in
          two of them the term's name is not otherwise on screen. */}
      <p className="mt-2.5 text-[0.8125rem] leading-snug text-muted">
        {term.name} · {termTypeLabel(term.termType)} ·{" "}
        {formatDateRange(term.startDate, term.endDate)}
      </p>

      {term.access === "expired" ? (
        <p className="mt-2 text-[0.8125rem] leading-relaxed text-ink-soft">
          The pass you bought for this term has run out. A new one covers it
          again.
        </p>
      ) : null}

      {/* The syllabus that was refused is not gone. Saying which one, by name,
          is the difference between a paywall and a receipt for work already
          done -- and it is what the purchase will finish. */}
      {term.pendingUpload ? (
        <p className="mt-2.5 rounded-md border border-accent-line bg-surface px-3 py-2 text-[0.8125rem] leading-relaxed text-ink-soft">
          <span className="font-medium text-ink">
            {term.pendingUpload.courseCode}
            {term.pendingUpload.courseTitle ? ` \u2014 ${term.pendingUpload.courseTitle}` : ""}
          </span>{" "}
          is parsed and waiting
          {term.pendingUpload.assessmentCount > 0
            ? ` (${term.pendingUpload.assessmentCount} deadline${term.pendingUpload.assessmentCount === 1 ? "" : "s"} found)`
            : ""}
          . Unlock the term and it is added automatically \u2014 no need to upload it
          again.
        </p>
      ) : null}

      {payable && pass ? (
        <>
          <p className="mt-3 text-[0.9375rem] font-medium text-ink">
            {pass.name} — {pass.display}
          </p>
          <p className="mt-0.5 text-[0.8125rem] text-muted">
            One-time payment. No subscription.
          </p>

          <div className="mt-3.5 flex flex-wrap items-center gap-2">
            {demo ? (
              // A demo sandbox has nothing to attach a payment to, so the honest
              // first step is an account. Same href as everywhere else.
              <LinkButton href={SIGN_IN_HREF} size="sm">
                <GoogleMark />
                Sign in with Google to unlock
              </LinkButton>
            ) : (
              <Button size="sm" disabled={pending} onClick={() => void unlock()}>
                {pending ? <Spinner label="Opening checkout" /> : null}
                Unlock This Term
              </Button>
            )}
            {onChooseDifferentTerm ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={onChooseDifferentTerm}
              >
                Choose a different term
              </Button>
            ) : null}
          </div>

          {phase.kind === "sign_in" ? (
            <p role="status" className="mt-2.5 text-[0.75rem] leading-relaxed text-ink-soft">
              Sample semesters can&rsquo;t be paid for. Sign in and this term
              comes with you.
            </p>
          ) : null}

          {phase.kind === "error" ? (
            <p
              role="alert"
              className="mt-2.5 rounded-md border border-danger-line bg-surface px-2.5 py-1.5 text-[0.75rem] leading-relaxed text-danger"
            >
              {phase.error}
              {phase.detail ? ` — ${phase.detail}` : ""}
            </p>
          ) : null}
        </>
      ) : (
        <>
          {/* No price, no button: a card that offered to take money a server
              cannot take would be worse than saying so. */}
          <p className="mt-3 text-[0.875rem] leading-relaxed text-ink-soft">
            Payments aren&rsquo;t set up on this server yet, so there is nothing
            to buy here. Your first course in this term still works exactly as
            it does everywhere else.
          </p>
          {onChooseDifferentTerm ? (
            <div className="mt-3">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={onChooseDifferentTerm}
              >
                Choose a different term
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
