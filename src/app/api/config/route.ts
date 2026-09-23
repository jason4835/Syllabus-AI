import { ok } from "@/lib/api";
import { isGoogleConfigured } from "@/lib/google/oauth";
import { isAiParsingAvailable } from "@/lib/parse";
import { resolveTermPassPrice } from "@/lib/pricing";
import { isStripeConfigured } from "@/lib/stripe";
import { resolveVisitor } from "@/lib/demo";
import { assignmentsFor, variantOf } from "@/lib/experiments";

export const dynamic = "force-dynamic";

/**
 * Lets the client tell the user the truth about what is wired up, rather than
 * silently pretending a dry run was a real calendar sync.
 *
 * `demoMode` is about the CALLER, not the server. It used to be `!googleReady`
 * -- a server-wide flag -- which meant a deployment with Google configured
 * offered no demo at all, and one without it offered no sign-in. They are
 * independent facts, so they are now reported independently and the UI can
 * offer both at once.
 *
 * This is also where a first-time visitor's sandbox is minted, which is why it
 * calls `resolveVisitor()`: it is a route handler, so it may set the session
 * cookie, and it is the first request the dashboard makes.
 */
export async function GET() {
  const { isDemo, userId } = await resolveVisitor();

  /**
   * Assignments are resolved here, from the session, and shipped to the client
   * as an answer rather than a question. The browser renders whichever variant
   * it is told; it never decides, because for the price experiment deciding
   * would mean choosing what to pay (see `@/lib/experiments`).
   */
  const experiments = assignmentsFor(userId);
  const termPass = await resolveTermPassPrice(variantOf("termPassPrice", userId));

  return ok({
    demoMode: isDemo,
    /**
     * Which arm of each running A/B test this visitor is in, keyed by the
     * experiment's wire key. An experiment that has been deleted from the
     * registry simply stops appearing, and the UI's control branch takes over.
     */
    experiments,
    googleReady: isGoogleConfigured(),
    openaiReady: isAiParsingAvailable(),
    /**
     * `ready` is the same kind of fact as `googleReady`: whether this deployment
     * can actually take money. The price travels with it so the paywall has one
     * number to print, and it comes from the server because the client must never
     * be the thing that says what something costs.
     *
     * With the price experiment running, `termPass` is THIS visitor's price, read
     * back from the Stripe price their checkout will actually use. The paywall
     * and the charge therefore come from one resolution of one pure function,
     * which is what lets the Terms promise they always match.
     */
    billing: { ready: isStripeConfigured(), termPass },
  });
}
