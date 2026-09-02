import { fail, messageOf, ok } from "@/lib/api";
import { logApiError } from "@/lib/log";
import { readSession } from "@/lib/session";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";

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
