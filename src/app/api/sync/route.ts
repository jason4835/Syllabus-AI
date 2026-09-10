import { fail, messageOf, ok, rateLimited } from "@/lib/api";
import { logApiError } from "@/lib/log";
import { isGoogleConfigured } from "@/lib/google/oauth";
import { syncToCalendar } from "@/lib/google/calendar";
import { buildSemesterPlan } from "@/lib/plan";
import { ensureDemoSeed } from "@/lib/demo";
import { checkLimit, describeLimit } from "@/lib/ratelimit";
import { resolveSession } from "@/lib/session";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";
// A full-semester sync writes many calendar events one at a time.
// See the ceiling note in the upload route.
export const maxDuration = 120;

export async function POST(req: Request) {
  const { userId } = await resolveSession();
  if (!userId) return fail("Sign in first.", 401);
  await ensureDemoSeed(userId);

  const limit = checkLimit(`user:${userId}`, "sync:user");
  if (!limit.allowed) return rateLimited(describeLimit(limit));


  let courseId: string | undefined;
  // "Show me what this would do." Preview is the only way to answer the
  // question a reconciliation raises -- which of my events are about to be
  // removed, and why -- BEFORE it is carried out. Without it a connected user
  // has to run the real thing and read the receipt afterwards.
  let previewOnly = false;
  try {
    const body = (await req.json()) as { courseId?: string; dryRun?: boolean } | null;
    courseId = body?.courseId;
    previewOnly = body?.dryRun === true;
  } catch {
    // An empty body means "sync everything" -- not an error.
  }

  try {
    const [allCourses, allAssessments] = await Promise.all([
      store.listCourses(userId),
      store.listAssessments(userId),
    ]);
    const courses = courseId ? allCourses.filter((c) => c.id === courseId) : allCourses;
    if (courseId && courses.length === 0) return fail("Course not found.", 404);
    const ids = new Set(courses.map((c) => c.id));
    const assessments = allAssessments.filter((a) => ids.has(a.courseId));

    // Read before planning: "today" decides which study sessions are still
    // ahead of the student, and on a UTC host that is not the server's today.
    const user = await store.getUser(userId);
    const plan = buildSemesterPlan(courses, assessments, {
      timeZone: user?.timezone ?? undefined,
    });
    // Without Google credentials we still report exactly what a real sync
    // would do, so the demo tells the truth instead of faking success. A
    // connected user gets the same honesty on request: `dryRun` walks the
    // identical plan-and-diff and skips only the network, so the counts it
    // returns are the counts a real run would produce.
    const dryRun = previewOnly || !isGoogleConfigured() || !user?.googleRefreshToken;

    const result = await syncToCalendar(userId, {
      courses,
      assessments,
      studyBlocks: plan.studyBlocks,
      dryRun,
    });
    return ok({ ...result, dryRun });
  } catch (err) {
    logApiError("sync.failed", err, { userId, courseId });
    return fail("Calendar sync failed.", 502, messageOf(err));
  }
}
