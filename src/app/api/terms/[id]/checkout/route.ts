import { NextResponse } from "next/server";

import { track } from "@/lib/analytics";
import { crossSiteDenied, fail, messageOf, ok, publicOrigin, rateLimited } from "@/lib/api";
import { resolveVisitor } from "@/lib/demo";
import { logApiError } from "@/lib/log";
import { checkLimit, describeLimit } from "@/lib/ratelimit";
import { store } from "@/lib/store";
import { variantOf } from "@/lib/experiments";
import { createTermPassCheckout, isStripeConfigured } from "@/lib/stripe";
import { termHasPremiumAccess } from "@/lib/terms";

export const dynamic = "force-dynamic";

/**
 * Starts a Stripe Checkout Session for one term and hands back its URL.
 *
 * Nothing about money is in the request or the response. The price id is a
 * server-only environment variable, the amount is Stripe's, and this route's
 * whole input is a term id it then proves belongs to the caller. A client that
 * could name a price could name a cheaper one.
 *
 * The checks are ordered from the cheapest and most specific to the most
 * expensive, so a student is told the most useful thing: who they are, then
 * whether this server can take money at all, then whether the term is theirs,
 * then whether it is in a state worth paying for.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = crossSiteDenied(req);
  if (denied) return denied;

  const { userId, isDemo } = await resolveVisitor();
  if (!userId) return fail("Sign in first.", 401);

  /**
   * A demo sandbox cannot buy anything, and this is not a limitation to work
   * around: the sandbox IS its cookie. There is no durable identity to attach a
   * purchase to, so a pass bought here would be paid for and then lost with the
   * next cleared cookie -- and the webhook's `user_id` would name a user row
   * nobody can ever sign in as again. `code` is here rather than in `detail`
   * because the UI switches on it to offer Google sign-in instead of an error.
   */
  if (isDemo) {
    return NextResponse.json(
      {
        ok: false as const,
        error: "Sign in with Google to buy a Term Pass.",
        code: "sign_in_required",
      },
      { status: 403 },
    );
  }

  // Before ownership, because it is a fact about the server rather than about
  // this student, and telling them "not found" when the real answer is "this
  // deployment has no payments" would be a lie they cannot act on.
  if (!isStripeConfigured()) {
    return fail("Payments are not set up on this server yet.", 503);
  }

  const limit = checkLimit(`user:${userId}`, "edit:user");
  if (!limit.allowed) return rateLimited(describeLimit(limit));

  const { id } = await ctx.params;
  try {
    const term = await store.getTerm(userId, id);
    if (!term) return fail("That term was not found.", 404);

    // An unconfirmed or dateless term has no end date to compute an expiry
    // from, so a pass bought for it could not say what it covers. Asking for
    // the dates first is cheaper than refunding.
    if (term.confirmedAt === null || term.startDate === null || term.endDate === null) {
      return fail("Confirm the term's dates first.", 409);
    }
    if (termHasPremiumAccess(term)) {
      return fail("This term already has a Term Pass.", 409);
    }

    const origin = publicOrigin(req);
    /**
     * Resolved here, from the user id, and never read from the request.
     *
     * This is the line that makes the price experiment safe: the same pure
     * function that decided which price the paywall displayed decides which
     * Stripe price is charged, so the two cannot disagree, and a client that
     * posts `{"variant":"control"}` at this route changes nothing.
     */
    const priceVariant = variantOf("termPassPrice", userId);

    const checkout = await createTermPassCheckout({
      userId,
      termId: term.id,
      priceVariant,
      customerEmail: customerEmailOf((await store.getUser(userId))?.email ?? null),
      // The redirect grants nothing -- the dashboard polls `GET /api/terms`
      // until the webhook has granted premium, and activates nothing itself.
      successUrl: `${origin}/dashboard?checkout=success&term=${encodeURIComponent(term.id)}`,
      cancelUrl: `${origin}/dashboard?checkout=cancelled&term=${encodeURIComponent(term.id)}`,
    });

    // Stored so a later delivery can be tied back to the session this term
    // started, and so support has something to look up. Best effort in the sense
    // that the session already exists either way, but a failure here is a real
    // failure of the route: the student has not been sent anywhere yet.
    await store.updateTerm(userId, id, { stripeCheckoutSessionId: checkout.sessionId });
    track("term_checkout_started", { userId, termId: term.id, priceVariant });

    return ok({ url: checkout.url });
  } catch (err) {
    logApiError("terms.checkout_failed", err, { userId, termId: id });
    return fail("Could not start checkout.", 500, messageOf(err));
  }
}

/**
 * The address to pre-fill Checkout with, or null.
 *
 * A demo sandbox never reaches this route, but its address is synthetic
 * (`demo+<hash>@syllabuscenter.com`, see `@/lib/demo`) and would become a real
 * Stripe customer with a mailbox nobody reads, so the shape is refused here too
 * rather than trusted not to arrive.
 */
function customerEmailOf(email: string | null): string | null {
  if (!email) return null;
  if (/^demo\+[^@]*@/i.test(email)) return null;
  return email;
}
