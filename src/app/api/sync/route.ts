import { track } from "@/lib/analytics";
import { crossSiteDenied, fail, messageOf, ok, rateLimited } from "@/lib/api";
import { logApiError } from "@/lib/log";
import { isGoogleConfigured } from "@/lib/google/oauth";
import { syncToCalendar } from "@/lib/google/calendar";
import { buildSemesterPlan } from "@/lib/plan";
import { ensureDemoSeed, resolveVisitor } from "@/lib/demo";
import { checkLimit, describeLimit } from "@/lib/ratelimit";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";
// A full-semester sync writes many calendar events one at a time.
// See the ceiling note in the upload route.
export const maxDuration = 120;

export async function POST(req: Request) {
  const denied = crossSiteDenied(req);
  if (denied) return denied;

  const { userId } = await resolveVisitor();
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

    /**
     * Streamed when the client asks for it, so a progress bar can be real.
     *
     * A full-semester sync is one Google API call per event, in sequence, and
     * a couple of hundred of those takes long enough that a spinner reads as
     * "hung" -- students refreshed mid-run, which then raced the run they had
     * just abandoned. Newline-delimited JSON: `{"progress":{done,total}}` per
     * event, then the same `ApiResult` envelope this route has always
     * returned as the final line. A client that sends the ordinary `Accept`
     * gets the ordinary JSON, so nothing older breaks and the tests need no
     * stream reader.
     *
     * The status is 200 even when the sync fails partway: the failure travels
     * in the final envelope, because an HTTP status cannot be changed after
     * the first progress byte has been sent.
     */
    const wantsStream = (req.headers.get("accept") ?? "").includes("application/x-ndjson");
    const run = (onProgress?: (p: { done: number; total: number }) => void) =>
      syncToCalendar(userId, {
        courses,
        assessments,
        studyBlocks: plan.studyBlocks,
        dryRun,
        onProgress,
      });

    if (wantsStream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const line = (value: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
          try {
            const result = await run((progress) => line({ progress }));
            // Analytics, same fields as the non-streamed path below.
            track("calendar_synced", {
              userId,
              dryRun,
              created: result.created,
              updated: result.updated,
              removed: result.removed,
              scope: courseId ? "course" : "all",
            });
            line({ ok: true, data: { ...result, dryRun } });
          } catch (err) {
            logApiError("sync.failed", err, { userId, courseId });
            line({ ok: false, error: "Calendar sync failed.", detail: messageOf(err) });
          } finally {
            controller.close();
          }
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    const result = await run();
    /**
     * Deadlines reaching a real calendar is the strongest retention signal the
     * app has -- it is the point at which the plan stops living in this tab.
     * Dry runs are recorded too, flagged: a student whose sync is always a dry
     * run has not connected Google, which is a funnel problem, not a sync one.
     */
    track("calendar_synced", {
      userId,
      dryRun,
      created: result.created,
      updated: result.updated,
      removed: result.removed,
      scope: courseId ? "course" : "all",
    });
    return ok({ ...result, dryRun });
  } catch (err) {
    logApiError("sync.failed", err, { userId, courseId });
    return fail("Calendar sync failed.", 502, messageOf(err));
  }
}
