import { fail, messageOf, ok } from "@/lib/api";
import { logApiError } from "@/lib/log";
import { buildSemesterPlan } from "@/lib/plan";
import { ensureDemoSeed } from "@/lib/demo";
import { resolveSession } from "@/lib/session";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const { userId } = await resolveSession();
  if (!userId) return fail("Sign in first.", 401);
  await ensureDemoSeed(userId);
  try {
    const [courses, assessments] = await Promise.all([
      store.listCourses(userId),
      store.listAssessments(userId),
    ]);
    // The student's zone, not the host's: on a UTC box a New York student's
    // evening already counts as tomorrow, and this evening's study block
    // silently disappears as "past".
    const timeZone = (await store.getUser(userId))?.timezone ?? undefined;
    return ok(buildSemesterPlan(courses, assessments, { timeZone }));
  } catch (err) {
    logApiError("plan.build_failed", err, { userId });
    return fail("Could not build your plan.", 500, messageOf(err));
  }
}
