import { fail, messageOf, ok, rateLimited } from "@/lib/api";
import { logApiError } from "@/lib/log";
import { checkLimit, describeLimit } from "@/lib/ratelimit";
import { readSession } from "@/lib/session";
import { store } from "@/lib/store";
import type { Course } from "@/lib/types";
import { Invalid, validateCoursePatch } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * Corrects what the extractor got wrong about the course itself.
 *
 * The term window is the reason this route exists. `GET /api/plan` numbers
 * every week from `startDate`/`endDate` when a syllabus states them, and falls
 * back to guessing from a term label or, last resort, the span of the deadlines
 * -- so a student whose syllabus buried its dates gets a heatmap whose "week 1"
 * is wrong until they can type them in. Setting them here flips the plan's
 * `term.source` to `"syllabus"` and renumbers the weeks.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await readSession();
  if (!userId) return fail("Sign in first.", 401);

  const limit = checkLimit(`user:${userId}`, "edit:user");
  if (!limit.allowed) return rateLimited(describeLimit(limit));

  const { id } = await ctx.params;
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return fail("Send a JSON object.", 400);
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return fail("Could not read that request.", 400);
  }

  try {
    // Loaded first so the date-ordering check can see the values the patch
    // leaves in place. Scoped to the owner here as well as in the store, so a
    // stranger's id cannot even reach validation.
    const current = await store.getCourse(id);
    if (!current || current.userId !== userId) return fail("Course not found.", 404);

    let patch;
    try {
      patch = validateCoursePatch(body, current);
    } catch (err) {
      if (err instanceof Invalid) return fail("Invalid change.", 422, err.message);
      throw err;
    }

    const updated = await store.updateCourse(userId, id, patch);
    if (!updated) return fail("Course not found.", 404);
    return ok<Course>(updated);
  } catch (err) {
    logApiError("courses.update_failed", err, { userId, courseId: id });
    return fail("Could not save that change.", 500, messageOf(err));
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await readSession();
  if (!userId) return fail("Sign in first.", 401);
  const { id } = await ctx.params;
  try {
    // The store scopes the delete by userId, so a stranger's id 404s here
    // rather than deleting someone else's course.
    const deleted = await store.deleteCourse(userId, id);
    if (!deleted) return fail("Course not found.", 404);
    return ok({ deleted: true });
  } catch (err) {
    logApiError("courses.delete_failed", err, { userId, courseId: id });
    return fail("Could not delete that course.", 500, messageOf(err));
  }
}
