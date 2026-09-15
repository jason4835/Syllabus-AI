import { ok } from "@/lib/api";
import { isGoogleConfigured } from "@/lib/google/oauth";
import { isAiParsingAvailable } from "@/lib/parse";
import { TERM_PASS } from "@/lib/pricing";
import { isStripeConfigured } from "@/lib/stripe";
import { resolveVisitor } from "@/lib/demo";

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
  const { isDemo } = await resolveVisitor();
  return ok({
    demoMode: isDemo,
    googleReady: isGoogleConfigured(),
    openaiReady: isAiParsingAvailable(),
    /**
     * `ready` is the same kind of fact as `googleReady`: whether this deployment
     * can actually take money. The price travels with it so the paywall has one
     * number to print, and it comes from the server because the client must never
     * be the thing that says what something costs -- Stripe charges the price id
     * in the environment, and this is only what the student reads.
     */
    billing: { ready: isStripeConfigured(), termPass: TERM_PASS },
  });
}
