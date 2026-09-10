import { fail, messageOf, ok, rateLimited } from "@/lib/api";
import { deleteCalendarEvents } from "@/lib/google/calendar";
import { archiveNotionPages } from "@/lib/notion/sync";
import { logApiError } from "@/lib/log";
import { checkLimit, describeLimit } from "@/lib/ratelimit";
import { resolveSession } from "@/lib/session";
import { reconcileSections } from "@/lib/sections";
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
 *
 * It is also where a student answers "which section am I in?", which is the one
 * field here that validation alone cannot settle: whether a label is real is a
 * fact about THIS syllabus. See `reconcileSections` below.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { userId } = await resolveSession();
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

    if (patch.sections !== undefined) {
      // Validation checked the shape; only the course itself can say whether
      // these labels are real. Reconciling against the syllabus is what stops a
      // stale or hand-made request enrolling someone in a section that does not
      // exist, and what makes re-answering one question REPLACE that question's
      // answer instead of piling a second lab on top of the first.
      //
      // Judged against the meeting times this same request is installing, when
      // it carries them: a student correcting a mistyped lab label and picking
      // that lab in one go must not have their pick rejected by the old list.
      patch.sections = reconcileSections(
        { ...current, meetingTimes: patch.meetingTimes ?? current.meetingTimes },
        patch.sections,
      );
    }

    const updated = await store.updateCourse(userId, id, patch);
    if (!updated) return fail("Course not found.", 404);
    return ok<Course>(updated);
  } catch (err) {
    logApiError("courses.update_failed", err, { userId, courseId: id });
    return fail("Could not save that change.", 500, messageOf(err));
  }
}

/**
 * Deletes a course, the Google events it put on the student's calendar, and
 * the rows it put in their Notion databases.
 *
 * Neither cleanup is optional bookkeeping. Nothing else can do them: both
 * sync passes only look at the courses they are syncing, so the moment this
 * course's row is gone its events and its Coursework rows are beyond the reach
 * of every code path in the app -- a deleted class that keeps announcing its
 * deadlines until the student clears forty of them by hand.
 *
 * Both are still best effort. A Google or Notion failure is reported as a
 * smaller `calendarEventsRemoved` / `notionPagesRemoved`, never as a failed
 * delete: the student asked for the course to go, and it is already gone.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { userId } = await resolveSession();
  if (!userId) return fail("Sign in first.", 401);
  const { id } = await ctx.params;
  try {
    // The store scopes the delete by userId, so a stranger's id 404s here
    // rather than deleting someone else's course. It hands back the calendar
    // links it dropped, because they are the last record of the event ids.
    const deletion = await store.deleteCourse(userId, id);
    if (!deletion) return fail("Course not found.", 404);

    let calendarEventsRemoved = 0;
    try {
      const removal = await deleteCalendarEvents(userId, deletion.calendarLinks);
      calendarEventsRemoved = removal.removed;
      if (removal.errors.length > 0) {
        logApiError("courses.calendar_cleanup_failed", removal.errors[0], {
          userId,
          courseId: id,
        });
      }
    } catch (err) {
      // Belt and braces: `deleteCalendarEvents` reports rather than throws,
      // and even if that changes the course stays deleted.
      logApiError("courses.calendar_cleanup_failed", err, { userId, courseId: id });
    }

    // The same cleanup on the other integration, for the same reason: the
    // rows in the Coursework database describe deadlines that no longer
    // exist, and the links that named them are gone. The class page itself is
    // not in `notionPages` and stays where it is.
    let notionPagesRemoved = 0;
    try {
      const removal = await archiveNotionPages(userId, deletion.notionPages);
      notionPagesRemoved = removal.removed;
      if (removal.errors.length > 0) {
        logApiError("courses.notion_cleanup_failed", removal.errors[0], {
          userId,
          courseId: id,
        });
      }
    } catch (err) {
      logApiError("courses.notion_cleanup_failed", err, { userId, courseId: id });
    }

    return ok({ deleted: true, calendarEventsRemoved, notionPagesRemoved });
  } catch (err) {
    logApiError("courses.delete_failed", err, { userId, courseId: id });
    return fail("Could not delete that course.", 500, messageOf(err));
  }
}
