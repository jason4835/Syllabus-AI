import { fail, messageOf, ok, rateLimited } from "@/lib/api";
import { logApiError } from "@/lib/log";
import { answerQuestion, buildSemesterPlan } from "@/lib/plan";
import { ensureDemoSeed } from "@/lib/demo";
import { checkLimit, describeLimit } from "@/lib/ratelimit";
import { readSession } from "@/lib/session";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const userId = await readSession();
  if (!userId) return fail("Sign in first.", 401);
  await ensureDemoSeed(userId);

  const limit = checkLimit(`user:${userId}`, "chat:user");
  if (!limit.allowed) return rateLimited(describeLimit(limit));


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
    const plan = buildSemesterPlan(courses, assessments);
    const reply = await answerQuestion(message, { courses, assessments, plan });
    return ok({ reply });
  } catch (err) {
    logApiError("chat.failed", err, { userId });
    return fail("Could not answer that.", 500, messageOf(err));
  }
}
