import { fail, messageOf, ok } from "@/lib/api";
import { logApiError } from "@/lib/log";
import { buildSemesterPlan } from "@/lib/plan";
import { ensureDemoSeed } from "@/lib/demo";
import { readSession } from "@/lib/session";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const userId = await readSession();
  if (!userId) return fail("Sign in first.", 401);
  await ensureDemoSeed(userId);
  try {
    const [courses, assessments] = await Promise.all([
      store.listCourses(userId),
      store.listAssessments(userId),
    ]);
    return ok(buildSemesterPlan(courses, assessments));
  } catch (err) {
    logApiError("plan.build_failed", err, { userId });
    return fail("Could not build your plan.", 500, messageOf(err));
  }
}
