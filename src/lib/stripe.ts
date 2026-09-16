/**
 * The one file that talks to Stripe.
 *
 * Server-only: it reads the secret key and the webhook secret, neither of
 * which may reach a client bundle. Tests mock this module rather than the
 * SDK, so the two functions below are the whole contract the routes depend on.
 */
import Stripe from "stripe";

import { log } from "@/lib/log";

/** Which environment variables make billing usable, so /api/config can say so. */
export function isStripeConfigured(): boolean {
  return Boolean(
    process.env.STRIPE_SECRET_KEY?.trim() &&
      process.env.STRIPE_WEBHOOK_SECRET?.trim() &&
      process.env.STRIPE_TERM_PASS_PRICE_ID?.trim(),
  );
}

let client: Stripe | null = null;

function stripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw new Error("Billing is not configured (STRIPE_SECRET_KEY is unset).");
  if (!client) client = new Stripe(key, { maxNetworkRetries: 2, timeout: 20_000 });
  return client;
}

export interface TermPassCheckoutInput {
  userId: string;
  termId: string;
  /** Pre-fills the Checkout email field; Stripe may create a customer from it. */
  customerEmail: string | null;
  /** Absolute URLs on APP_URL; Stripe appends nothing to them. */
  successUrl: string;
  cancelUrl: string;
}

export interface TermPassCheckout {
  sessionId: string;
  url: string;
}

/**
 * A one-time Checkout Session for one term.
 *
 * `mode: "payment"` is the whole product model -- no subscription, no
 * renewal. The price comes from the environment, never from the caller. The
 * user and term ride in `metadata` (and the term in `client_reference_id`) so
 * the webhook can find them from Stripe's copy, not from anything a browser
 * sends. The idempotency key is per user+term, so a double click cannot
 * create two sessions for the same purchase.
 */
export async function createTermPassCheckout(input: TermPassCheckoutInput): Promise<TermPassCheckout> {
  const price = process.env.STRIPE_TERM_PASS_PRICE_ID?.trim();
  if (!price) throw new Error("Billing is not configured (STRIPE_TERM_PASS_PRICE_ID is unset).");

  const session = await stripe().checkout.sessions.create(
    {
      mode: "payment",
      allow_promotion_codes: true,
      line_items: [{ price, quantity: 1 }],
      client_reference_id: input.termId,
      metadata: { user_id: input.userId, term_id: input.termId },
      ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      // The session, not the page, carries the time limit: a link left open
      // in a tab for a day should not still be able to charge.
      expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
    },
    { idempotencyKey: `term-pass:${input.userId}:${input.termId}:${Date.now().toString(36).slice(0, -2)}` },
  );
  if (!session.url) throw new Error("Stripe did not return a Checkout URL.");
  return { sessionId: session.id, url: session.url };
}

/**
 * Verifies a webhook delivery and returns the event, or throws.
 *
 * The raw body is required: any re-serialisation changes the bytes the
 * signature covers. The secret is read here and nowhere else, and the error
 * Stripe raises is logged by type only -- it can contain the header.
 */
export function verifyWebhook(rawBody: string, signature: string | null): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) throw new Error("Billing is not configured (STRIPE_WEBHOOK_SECRET is unset).");
  if (!signature) throw new Error("Missing Stripe-Signature header.");
  try {
    return stripe().webhooks.constructEvent(rawBody, signature, secret);
  } catch (err) {
    log.warn("stripe.webhook_rejected", { reason: err instanceof Error ? err.name : "unknown" });
    throw new Error("Webhook signature verification failed.");
  }
}

/** Re-exported so routes can type events without importing the SDK themselves. */
export type StripeEvent = Stripe.Event;
export type StripeCheckoutSession = Stripe.Checkout.Session;
