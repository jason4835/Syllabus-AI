import { crossSiteDenied, fail, messageOf, ok, rateLimited } from "@/lib/api";
import { track } from "@/lib/analytics";
import { ensureDemoSeed, resolveVisitor } from "@/lib/demo";
import { listTermSummaries, summarizeTerm, type TermSummary } from "@/lib/entitlement";
import { logApiError } from "@/lib/log";
import { checkLimit, describeLimit } from "@/lib/ratelimit";
import { store } from "@/lib/store";
import { validateTermInput } from "@/lib/terms";
import { Invalid } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * The student's terms, with the two things only the server can answer: how many
 * courses are in each, and whether the next one is free.
 *
 * Seeds a demo sandbox first, like `/api/courses` and `/api/me`, so a visitor
 * who lands here before the dashboard's course fetch sees their grandfathered
 * term rather than an empty list. `listTermSummaries` runs the term backfill,
 * which is what gives an account that predates this feature its terms.
 */
export async function GET() {
  const { userId } = await resolveVisitor();
  if (!userId) return fail("Sign in first.", 401);
  await ensureDemoSeed(userId);
  try {
    return ok({ terms: await listTermSummaries(userId) });
  } catch (err) {
    logApiError("terms.list_failed", err, { userId });
    return fail("Could not load your terms.", 500, messageOf(err));
  }
}

/**
 * Creates a term the student typed in themselves.
 *
 * Dates are required here, unlike on the inferred path: this is a form, the
 * student is looking at it, and a term with no dates is one nothing can compute
 * a premium expiry for. It is created confirmed for the same reason -- there is
 * nobody left to ask.
 */
export async function POST(req: Request) {
  const denied = crossSiteDenied(req);
  if (denied) return denied;

  const { userId } = await resolveVisitor();
  if (!userId) return fail("Sign in first.", 401);

  const limit = checkLimit(`user:${userId}`, "edit:user");
  if (!limit.allowed) return rateLimited(describeLimit(limit));

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("Could not read that request.", 400);
  }

  try {
    let input;
    try {
      input = validateTermInput(body);
    } catch (err) {
      if (err instanceof Invalid) return fail("Invalid term.", 422, err.message);
      throw err;
    }

    const term = await store.createTerm(userId, {
      ...input,
      confirmedAt: new Date().toISOString(),
    });
    track("term_created", { userId, termId: term.id });
    // Zero courses, necessarily: the term was created one statement ago.
    return ok<{ term: TermSummary }>({ term: summarizeTerm(term, 0) }, 201);
  } catch (err) {
    logApiError("terms.create_failed", err, { userId });
    return fail("Could not create that term.", 500, messageOf(err));
  }
}
