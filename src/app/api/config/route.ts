import { ok } from "@/lib/api";
import { isGoogleConfigured } from "@/lib/google/oauth";
import { isAiParsingAvailable } from "@/lib/parse";
import { resolveSession } from "@/lib/session";

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
 * calls `resolveSession()`: it is a route handler, so it may set the session
 * cookie, and it is the first request the dashboard makes.
 */
export async function GET() {
  const { isDemo } = await resolveSession();
  return ok({
    demoMode: isDemo,
    googleReady: isGoogleConfigured(),
    openaiReady: isAiParsingAvailable(),
  });
}
