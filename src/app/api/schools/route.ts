import { ok } from "@/lib/api";
import { findSchools } from "@/lib/schools";

export const dynamic = "force-dynamic";

const MAX_QUERY_CHARS = 80;

/**
 * Typeahead for the onboarding card's school field.
 *
 * Unauthenticated on purpose: the list is public knowledge, the search is an
 * in-memory scan over a few thousand strings with no store or network behind
 * it, and requiring a session would only add a round trip to a keystroke.
 * The query is capped so the one thing a caller controls stays small.
 */
export async function GET(req: Request) {
  const q = (new URL(req.url).searchParams.get("q") ?? "").slice(0, MAX_QUERY_CHARS);
  return ok({ schools: findSchools(q) });
}
