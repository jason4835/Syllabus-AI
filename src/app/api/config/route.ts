import { ok } from "@/lib/api";
import { isGoogleConfigured } from "@/lib/google/oauth";
import { isAiParsingAvailable } from "@/lib/parse";

export const dynamic = "force-dynamic";

/**
 * Lets the client tell the user the truth about what is wired up, rather than
 * silently pretending a dry run was a real calendar sync.
 */
export async function GET() {
  const googleReady = isGoogleConfigured();
  const openaiReady = isAiParsingAvailable();
  return ok({ demoMode: !googleReady, googleReady, openaiReady });
}
