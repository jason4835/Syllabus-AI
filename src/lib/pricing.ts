import type { VariantOf } from "@/lib/experiments";
import { log } from "@/lib/log";
import { fetchPriceFacts, isStripeConfigured, termPassPriceId } from "@/lib/stripe";

/**
 * What the Academic Term Pass costs, as the UI states it.
 *
 * Stripe is the source of truth in both directions now. It has always been
 * authoritative for what is CHARGED -- the Checkout Session is built from a
 * price id in the environment and the client never sends a price -- and
 * `resolveTermPassPrice` below now reads the amount back from Stripe for what
 * is DISPLAYED too.
 *
 * That closes a gap that only mattered once prices could vary. The Terms
 * promise that the price a student is shown is the price they are charged, and
 * a hard-coded 5.99 next to a price id is a second copy of the number: edit the
 * price in the Stripe Dashboard, forget the deploy, and the paywall advertises
 * one figure while the card is charged another. With an A/B test running there
 * are several price ids and the chance of drift multiplies.
 *
 * `TERM_PASS` below stays as the fallback for a deployment with no Stripe keys
 * at all (demo mode), where there is nothing to charge and nothing to read.
 *
 * Server-only, since that lookup pulls in the Stripe SDK and its secret key.
 * The client is told the price by `/api/config` and never computes one -- see
 * `TermPassDisplay` in `@/components/api-client`.
 */
export interface DisplayPrice {
  /** Product name as shown. */
  name: string;
  /** Minor units, so arithmetic never touches a float. */
  amountCents: number;
  currency: "usd";
  /** The formatted string the UI prints. */
  display: string;
  /** Always true today: the pass is one payment, never a subscription. */
  oneTime: true;
}

export const TERM_PASS: DisplayPrice = {
  name: "Academic Term Pass",
  amountCents: 599,
  currency: "usd",
  display: "$5.99",
  oneTime: true,
};

/**
 * The price to show this student, for their arm of the price experiment.
 *
 * Falls back to `TERM_PASS` in the two cases where Stripe cannot answer: a
 * deployment with no billing configured (demo mode, local dev), and a Stripe
 * call that fails. The fallback is deliberate rather than an error -- the
 * paywall's job on a server that cannot take money is to describe the product,
 * and a dashboard that fails to render because an analytics-adjacent price
 * lookup timed out would be a far worse bug than a stale figure on a screen
 * with no working Buy button.
 *
 * A failure IS logged, because a live deployment quietly showing the fallback
 * price while charging something else is the exact condition worth knowing
 * about.
 */
export async function resolveTermPassPrice(
  variant: VariantOf<"termPassPrice">,
): Promise<DisplayPrice> {
  if (!isStripeConfigured()) return TERM_PASS;
  try {
    const { amountCents, currency } = await fetchPriceFacts(termPassPriceId(variant));
    return {
      name: TERM_PASS.name,
      amountCents,
      currency: currency as DisplayPrice["currency"],
      display: formatCents(amountCents, currency as DisplayPrice["currency"]),
      oneTime: true,
    };
  } catch (err) {
    log.warn("pricing.stripe_lookup_failed", {
      variant,
      reason: err instanceof Error ? err.message : "unknown",
    });
    return TERM_PASS;
  }
}

/** Formats minor units as the UI prints them ("$5.99"). */
export function formatCents(amountCents: number, currency: DisplayPrice["currency"] = "usd"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(amountCents / 100);
}
