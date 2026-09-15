/**
 * What the Academic Term Pass costs, as the UI states it.
 *
 * Stripe is the source of truth for what is actually charged: the Checkout
 * Session is built from `STRIPE_TERM_PASS_PRICE_ID`, and the client never
 * sends a price. This object exists so the number the student reads on the
 * paywall lives in one place. When the price changes, change it in the Stripe
 * Dashboard and here; nothing else in the tree says 5.99.
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

/** Formats minor units as the UI prints them ("$5.99"). */
export function formatCents(amountCents: number, currency: DisplayPrice["currency"] = "usd"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(amountCents / 100);
}
