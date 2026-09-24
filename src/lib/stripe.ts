/**
 * The one file that talks to Stripe.
 *
 * Server-only: it reads the secret key and the webhook secret, neither of
 * which may reach a client bundle. Tests mock this module rather than the
 * SDK, so the two functions below are the whole contract the routes depend on.
 */
import Stripe from "stripe";

import type { VariantOf } from "@/lib/experiments";
import { TERMS_VERSION } from "@/lib/legal";
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

/**
 * The Stripe price id for one arm of the price experiment.
 *
 * The control arm is `STRIPE_TERM_PASS_PRICE_ID`, which is the variable that
 * already existed -- an existing deployment keeps working and is simply not
 * running the test. Each other arm reads `STRIPE_TERM_PASS_PRICE_ID_<ARM>`, and
 * **falls back to the control when that is unset**. That fallback is the whole
 * on/off switch: set the second price id to start the experiment, unset it to
 * end it, no deploy either way, and a half-configured environment charges the
 * normal price rather than failing checkout.
 */
export function termPassPriceId(variant: VariantOf<"termPassPrice">): string {
  const control = process.env.STRIPE_TERM_PASS_PRICE_ID?.trim();
  if (variant === "control") {
    if (!control) throw new Error("Billing is not configured (STRIPE_TERM_PASS_PRICE_ID is unset).");
    return control;
  }
  const arm = process.env[`STRIPE_TERM_PASS_PRICE_ID_${variant.toUpperCase()}`]?.trim();
  if (arm) return arm;
  if (!control) throw new Error("Billing is not configured (STRIPE_TERM_PASS_PRICE_ID is unset).");
  return control;
}

export interface PriceFacts {
  amountCents: number;
  currency: string;
}

/**
 * What Stripe will actually charge for a price id.
 *
 * Read from Stripe rather than configured anywhere, because the Terms promise
 * that the price a student is shown is the price they are charged, and the only
 * way to keep that promise is to never hold a second copy of the number. An env
 * variable carrying the amount alongside the price id would be exactly that
 * second copy, and it would be wrong the first time somebody edited a price in
 * the Dashboard and forgot the deploy.
 *
 * Cached for the life of the process, keyed by price id. A price is immutable in
 * Stripe -- changing an amount means creating a new price and pointing the env
 * at it -- so there is nothing to invalidate, and this keeps a Stripe round trip
 * off the dashboard's first paint after the first visitor of each cold start.
 */
const priceCache = new Map<string, PriceFacts>();

export async function fetchPriceFacts(priceId: string): Promise<PriceFacts> {
  const cached = priceCache.get(priceId);
  if (cached) return cached;

  const price = await stripe().prices.retrieve(priceId);
  if (typeof price.unit_amount !== "number") {
    // A metered or tiered price has no single amount to print. Nothing here
    // creates one, so this means the env points at the wrong kind of price.
    throw new Error(`Stripe price ${priceId} has no unit_amount to display.`);
  }
  const facts: PriceFacts = { amountCents: price.unit_amount, currency: price.currency };
  priceCache.set(priceId, facts);
  return facts;
}

export interface TermPassCheckoutInput {
  userId: string;
  termId: string;
  /** Pre-fills the Checkout email field; Stripe may create a customer from it. */
  customerEmail: string | null;
  /** Absolute URLs on APP_URL; Stripe appends nothing to them. */
  successUrl: string;
  cancelUrl: string;
  /**
   * Which arm of the price experiment this student is in, resolved on the
   * server from their user id. NEVER taken from the request body: a variant the
   * browser chose is a price the browser chose.
   */
  priceVariant: VariantOf<"termPassPrice">;
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
  const price = termPassPriceId(input.priceVariant);

  const session = await stripe().checkout.sessions.create(
    {
      mode: "payment",
      allow_promotion_codes: true,
      line_items: [{ price, quantity: 1 }],
      client_reference_id: input.termId,
      // The arm rides in metadata so Stripe's own records say which price sold,
      // independently of anything this app stores -- and so a refund question
      // months later can be answered from the Dashboard alone.
      metadata: {
        user_id: input.userId,
        term_id: input.termId,
        price_variant: input.priceVariant,
        // Which Terms the buyer agreed to, readable from the Dashboard alone.
        terms_version: TERMS_VERSION,
      },
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
