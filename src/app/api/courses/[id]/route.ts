import { crossSiteDenied, fail, messageOf, ok, rateLimited } from "@/lib/api";
import {
  PaywallError,
  assertCanAddCourse,
  paywallResponse,
} from "@/lib/entitlement";
import { deleteCalendarEvents } from "@/lib/google/calendar";
import { archiveNotionPages } from "@/lib/notion/sync";
import { log, logApiError } from "@/lib/log";
import { checkLimit, describeLimit } from "@/lib/ratelimit";
import { reconcileSections } from "@/lib/sections";
import { resolveWeekRefs } from "@/lib/setup";
import { store } from "@/lib/store";
import type { Course } from "@/lib/types";
import { Invalid, validateCoursePatch } from "@/lib/validation";
import { resolveVisitor } from "@/lib/demo";

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
  const denied = crossSiteDenied(req);
  if (denied) return denied;

  const { userId } = await resolveVisitor();
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

    /**
     * Moving a course into another term is the second way a course can enter one,
     * so it meets the same two checks the upload does: the term has to be the
     * student's, and it has to have room. Without this, the paywall would be one
     * PATCH away from being optional.
     *
     * The course excludes itself from the count, so re-sending the term it is
     * already in, or moving it out and back, is not refused by its own presence.
     * Clearing `termId` (null) is always allowed -- it adds nothing to any term --
     * and the backfill will file the course again on the next read.
     */
    if (patch.termId !== undefined && patch.termId !== null && patch.termId !== current.termId) {
      const term = await store.getTerm(userId, patch.termId);
      // 422 rather than 404: the missing thing is a field in this request, not
      // the course the URL names. Not-yours and no-such-term are one answer.
      if (!term) return fail("That term is not yours.", 422);
      try {
        await assertCanAddCourse(userId, term, { excludingCourseId: id });
      } catch (err) {
        if (err instanceof PaywallError) return paywallResponse(err);
        throw err;
      }
    }

    const updated = await store.updateCourse(userId, id, patch);
    if (!updated) return fail("Course not found.", 404);

    // A term start is not one field among several: it is the answer to "when
    // does Week 1 begin?", and every "End of Week 10" in this course has been
    // undated waiting for it. Placing them here rather than in the browser is
    // the same rule as everywhere else in this app -- the inference belongs to
    // the server, so the dashboard and a script get the same dates -- and
    // `resolveWeekRefs` only ever touches items that are still undated, so an
    // item the student dated by hand is never overwritten.
    if (patch.startDate) await placeWeekItems(userId, updated);

    // Still the `Course`, unchanged: every existing caller reads this response
    // as the course it patched, and the client refetches its items anyway.
    return ok<Course>(updated);
  } catch (err) {
    logApiError("courses.update_failed", err, { userId, courseId: id });
    return fail("Could not save that change.", 500, messageOf(err));
  }
}

/**
 * Dates this course's week-numbered items from the term start it just gained.
 *
 * Best effort, and deliberately not allowed to fail the PATCH: the course
 * change the student asked for is already saved, and telling them it failed --
 * over a follow-on write they never asked for -- would send them to re-edit a
 * field that is already correct. A failure is logged with the count it managed,
 * and re-entering the term start runs the whole placement again, because the
 * items it did not reach are still undated.
 */
async function placeWeekItems(userId: string, course: Course): Promise<void> {
  let placed = 0;
  try {
    const mine = (await store.listAssessments(userId)).filter((a) => a.courseId === course.id);
    const placements = resolveWeekRefs(course, mine);
    for (const placement of placements) {
      await store.updateAssessment(userId, placement.id, {
        dueDate: placement.dueDate,
        notes: placement.notes,
        // The review threshold exactly, because that is what this date is: the
        // week is the document's, the day inside it is this app's inference, so
        // the item stays flagged for the student to confirm.
        confidence: 0.6,
      });
      placed += 1;
    }
    if (placed > 0) log.info("courses.week_items_placed", { userId, courseId: course.id, placed });
  } catch (err) {
    logApiError("courses.week_items_failed", err, { userId, courseId: course.id, placed });
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
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = crossSiteDenied(req);
  if (denied) return denied;

  const { userId } = await resolveVisitor();
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
