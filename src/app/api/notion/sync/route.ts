import { fail, messageOf, ok, rateLimited } from "@/lib/api";
import { ensureDemoSeed } from "@/lib/demo";
import { logApiError } from "@/lib/log";
import { isNotionConfigured } from "@/lib/notion/oauth";
import { syncToNotion } from "@/lib/notion/sync";
import { buildSemesterPlan } from "@/lib/plan";
import { checkLimit, describeLimit } from "@/lib/ratelimit";
import { readSession } from "@/lib/session";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  const userId = await readSession();
  if (!userId) return fail("Sign in first.", 401);
  await ensureDemoSeed(userId);

  const limit = checkLimit(`user:${userId}`, "notion:user");
  if (!limit.allowed) return rateLimited(describeLimit(limit));

  let courseId: string | undefined;
  try {
    const body = (await req.json()) as { courseId?: string } | null;
    courseId = body?.courseId;
  } catch {
    // Empty body means "sync everything".
  }

  try {
    const [allCourses, allAssessments, conn] = await Promise.all([
      store.listCourses(userId),
      store.listAssessments(userId),
      store.getNotionConnection(userId),
    ]);
    const courses = courseId ? allCourses.filter((c) => c.id === courseId) : allCourses;
    if (courseId && courses.length === 0) return fail("Course not found.", 404);
    const ids = new Set(courses.map((c) => c.id));
    const assessments = allAssessments.filter((a) => ids.has(a.courseId));
    const plan = buildSemesterPlan(courses, assessments);

    // Same honesty rule as calendar: no credentials or no connection means we
    // report exactly what a real sync would do, and say it was a dry run.
    const dryRun = !isNotionConfigured() || !conn || conn.status !== "connected";
    const result = await syncToNotion(userId, {
      courses,
      assessments,
      studyBlocks: plan.studyBlocks,
      dryRun,
    });
    return ok({ ...result, dryRun });
  } catch (err) {
    logApiError("notion.sync_failed", err, { userId, courseId });
    return fail("Notion sync failed.", 502, messageOf(err));
  }
}
