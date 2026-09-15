import { track } from "@/lib/analytics";
import { fail, messageOf, ok } from "@/lib/api";
import { log, logApiError } from "@/lib/log";
import { store } from "@/lib/store";
import { verifyWebhook, type StripeCheckoutSession, type StripeEvent } from "@/lib/stripe";
import { premiumExpiresAt, termHasPremiumAccess, todayIso } from "@/lib/terms";

export const dynamic = "force-dynamic";

/**
 * The ONLY place premium is granted.
 *
 * No `crossSiteDenied` here, and that is not an omission: this request comes
 * from Stripe's servers, not a browser, so it carries no `Origin` for the check
 * to compare and a same-origin rule would reject every real delivery. Its
 * authentication is the signature over the raw body, which is strictly stronger
 * than an origin header -- it proves who sent it AND that nothing was altered.
 *
 * Everything the grant is keyed on (`user_id`, `term_id`, `payment_status`) is
 * read from Stripe's own copy of the session, never from a query string or a
 * body a browser could have written. The success redirect activates nothing.
 *
 * Status codes here are instructions to Stripe's retry machine, so they answer a
 * different question than the rest of the API: 200 means "stop sending this",
 * 400 means "this was not from you", and 500 means "try again". A situation this
 * server cannot fix by being asked again -- a term that does not exist, a
 * duplicate, an event type we ignore -- is a 200.
 */
export async function POST(req: Request) {
  // The raw text, before anything parses it: a re-serialised body has different
  // bytes and the signature covers the bytes.
  const raw = await req.text();

  let event: StripeEvent;
  try {
    event = verifyWebhook(raw, req.headers.get("stripe-signature"));
  } catch (err) {
    // Neither the body nor the signature header is logged, ever: the body is a
    // customer's payment record and the header is the credential this rejection
    // is about. `@/lib/stripe` has already logged the failure's type.
    log.warn("stripe.webhook_unverified", { reason: messageOf(err) });
    return fail("Webhook signature verification failed.", 400);
  }

  try {
    /**
     * The insert is the lock. Stripe delivers an event more than once whenever a
     * response is slow or lost, and `checkout.session.completed` is the one that
     * grants a pass -- so the first thing the handler does is claim the id.
     * `false` means some other delivery of this event already has it.
     */
    const fresh = await store.recordStripeEvent(event.id, event.type);
    if (!fresh) {
      log.info("stripe.webhook_duplicate", { eventId: event.id, type: event.type });
      return ok({ received: true, duplicate: true });
    }

    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        return await grant(event.data.object as StripeCheckoutSession, event);
      case "checkout.session.expired": {
        const ids = sessionIds(event.data.object as StripeCheckoutSession);
        if (ids) track("term_checkout_abandoned", { userId: ids.userId, termId: ids.termId });
        return ok({ received: true });
      }
      default:
        // Acknowledged and ignored. Stripe sends whatever the account is
        // subscribed to, and an unknown type is not an error.
        return ok({ received: true });
    }
  } catch (err) {
    // 500 on purpose: Stripe retries, and a transient store failure must not
    // lose a pass somebody paid for. The claim on the event id is released
    // first, so that retry runs the handler again instead of being answered
    // as a duplicate. If even the release fails, the log line is loud enough
    // to be fixed by hand.
    logApiError("stripe.webhook_failed", err, { eventId: event.id, type: event.type });
    try {
      await store.forgetStripeEvent(event.id);
    } catch (release) {
      logApiError("stripe.webhook_release_failed", release, { eventId: event.id });
    }
    return fail("Could not process that event.", 500);
  }
}

/** The user and term a session names, or null when it names neither properly. */
function sessionIds(
  session: StripeCheckoutSession,
): { userId: string; termId: string } | null {
  const userId = session.metadata?.user_id;
  // `client_reference_id` is the same term id by another route, kept as a
  // fallback because it survives places metadata does not.
  const termId = session.metadata?.term_id ?? session.client_reference_id;
  if (typeof userId !== "string" || userId.length === 0) return null;
  if (typeof termId !== "string" || termId.length === 0) return null;
  return { userId, termId };
}

/** A Stripe id field that is either the id or the expanded object. */
function idOf(value: string | { id: string } | null | undefined): string | null {
  if (typeof value === "string") return value;
  return value?.id ?? null;
}

/**
 * Turns one paid session into premium on one term.
 *
 * Every refusal in here answers 200. A session naming a term that is not this
 * user's, or an event for a payment that is not settled, is not something a
 * retry can improve -- and a 4xx would make Stripe redeliver it for days while
 * the dashboard filled with alerts about a request that was handled correctly
 * the first time.
 */
async function grant(session: StripeCheckoutSession, event: StripeEvent) {
  if (session.payment_status !== "paid") {
    // A completed session can still be awaiting funds (bank debits). The
    // `async_payment_succeeded` delivery is the one that will be paid.
    log.info("stripe.webhook_unpaid", {
      eventId: event.id,
      type: event.type,
      paymentStatus: session.payment_status,
    });
    return ok({ received: true });
  }

  const ids = sessionIds(session);
  if (!ids) {
    log.warn("stripe.webhook_missing_metadata", { eventId: event.id, type: event.type });
    return ok({ received: true });
  }
  const { userId, termId } = ids;

  /**
   * This IS the ownership check. `getTerm` is scoped by owner, so a term id
   * belonging to a different user returns null -- there is no path from a
   * session to premium on a stranger's term, even if the metadata were forged,
   * which the signature already prevents.
   */
  const term = await store.getTerm(userId, termId);
  if (!term) {
    log.warn("stripe.webhook_term_not_found", { eventId: event.id, userId, termId });
    return ok({ received: true });
  }

  // Idempotent even without the event table: a second grant would move the
  // expiry and overwrite `paidEndDate` with a date the student may since have
  // edited.
  if (termHasPremiumAccess(term)) {
    log.info("stripe.webhook_already_premium", { eventId: event.id, userId, termId });
    return ok({ received: true });
  }

  /**
   * Checkout refuses a term with no end date, so this fallback should be
   * unreachable. It exists because the alternative is throwing inside a paid
   * webhook: the student's money is gone and the only question left is whether
   * they get anything for it, so they get a window measured from today and a log
   * line that says the invariant broke.
   */
  const endDate = term.endDate;
  if (endDate === null) {
    log.warn("stripe.webhook_term_without_end_date", { eventId: event.id, userId, termId });
  }
  const expiresAt = premiumExpiresAt(endDate ?? todayIso());

  const granted = await store.grantTermPremium(userId, termId, {
    premiumStartedAt: new Date().toISOString(),
    premiumExpiresAt: expiresAt,
    // What was bought, so a later edit to the end date can be bounded against it.
    paidEndDate: endDate,
    stripeCheckoutSessionId: session.id,
    stripePaymentIntentId: idOf(session.payment_intent),
    stripeCustomerId: idOf(session.customer),
  });
  if (!granted) {
    // The term was read a moment ago, so this is a delete racing a payment.
    log.warn("stripe.webhook_grant_missed", { eventId: event.id, userId, termId });
    return ok({ received: true });
  }

  track("term_pass_purchased", {
    userId,
    termId,
    amountTotal: session.amount_total,
    currency: session.currency,
  });
  log.info("stripe.term_pass_granted", { userId, termId, premiumExpiresAt: expiresAt });
  return ok({ received: true });
}
