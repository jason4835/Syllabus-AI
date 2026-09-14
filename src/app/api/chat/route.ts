import { crossSiteDenied, fail, messageOf, ok, rateLimited } from "@/lib/api";
import { logApiError } from "@/lib/log";
import { answerQuestion, buildSemesterPlan } from "@/lib/plan";
import { ensureDemoSeed, resolveVisitor } from "@/lib/demo";
import { checkLimit, describeLimit } from "@/lib/ratelimit";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const denied = crossSiteDenied(req);
  if (denied) return denied;

  const { userId } = await resolveVisitor();
  if (!userId) return fail("Sign in first.", 401);
  await ensureDemoSeed(userId);

  /**
   * Two denials with opposite meanings come out of one call.
   *
   * `chat:user:*` means THIS visitor is asking too fast -- their own doing, and
   * a 429 is the honest answer. `global:openai:*` means someone else exhausted
   * the shared model budget, and answering a stranger's question with "try
   * again in 45 seconds" punishes them for traffic they never generated. The
   * app can already answer without the model: `answerLocally` is a complete
   * deterministic answerer, and it is what runs for every visitor when no API
   * key is configured at all. So a global denial degrades to it instead of
   * failing -- one heavy user can no longer take chat away from everyone.
   */
  const limit = checkLimit(`user:${userId}`, "chat:user");
  const budgetSpent = !limit.allowed && limit.rule.startsWith("global:");
  if (!limit.allowed && !budgetSpent) return rateLimited(describeLimit(limit));


  let message = "";
  try {
    const body = (await req.json()) as { message?: unknown };
    if (typeof body?.message === "string") message = body.message.trim();
  } catch {
    return fail("Could not read your message.", 400);
  }
  if (!message) return fail("Ask a question first.", 400);
  if (message.length > 2000) return fail("That question is too long.", 413);

  try {
    const [courses, assessments] = await Promise.all([
      store.listCourses(userId),
      store.listAssessments(userId),
    ]);
    const timeZone = (await store.getUser(userId))?.timezone ?? undefined;
    const plan = buildSemesterPlan(courses, assessments, { timeZone });
    const reply = await answerQuestion(
      message,
      { courses, assessments, plan },
      // An empty key is `answerQuestion`'s documented way to force the local
      // path; it never reaches the network, so it spends nothing.
      { timeZone, ...(budgetSpent ? { apiKey: "" } : {}) },
    );
    return ok({ reply });
  } catch (err) {
    logApiError("chat.failed", err, { userId });
    return fail("Could not answer that.", 500, messageOf(err));
  }
}
