import { crossSiteDenied, fail, messageOf, ok, rateLimited } from "@/lib/api";
import { deleteCalendarEvents } from "@/lib/google/calendar";
import { archiveNotionPages } from "@/lib/notion/sync";
import { log, logApiError } from "@/lib/log";
import { checkLimit, describeLimit } from "@/lib/ratelimit";
import { expandWeekly } from "@/lib/setup";
import { store } from "@/lib/store";
import { isRealTime } from "@/lib/validation";
import { resolveVisitor } from "@/lib/demo";

export const dynamic = "force-dynamic";

/**
 * How many weekly items one rule may become.
 *
 * Term dates are user-editable and validated only as real dates, so
 * `0001-01-01` to `9999-12-31` is an accepted term -- about 600,000 Sundays,
 * each of which this route would happily write as a row. The plan's own term
 * walk is capped at 80 weeks for the same reason (`MAX_TERM_WEEKS` in
 * `@/lib/plan/workload`), so the same ceiling applies here, and a term above it
 * is refused rather than truncated: 80 of a student's 600,000 quizzes is not a
 * smaller version of the right answer, it is a wrong one they would have to
 * find and delete.
 */
const MAX_WEEKLY_ITEMS = 80;

/**
 * Turns "due each Sunday at 11:59PM" into one dated item per week of the term.
 *
 * The syllabus states the rule and never the dates; the student states the day
 * (and, when the document did not, the time). This is the `weekly-day` question
 * of `@/lib/setup` being answered, and the answer is a series of real deadlines
 * -- because "Business article review, weekly" as one undated row is a row the
 * calendar cannot carry, the heatmap cannot count, and the student cannot use.
 *
 * The placeholder goes when the series arrives. Keeping it would double every
 * week's workload and leave an undated duplicate of thirteen real items, and it
 * is deleted through the same cascade `DELETE /api/assessments/[id]` uses --
 * the store's `deleteAssessment` plus the two best-effort cleanups -- because
 * an extractor placeholder can already have been synced to a calendar and a
 * Notion row, and those are the last records of the ids that name them.
 *
 * The week bounds come from the course, so a course with no term window cannot
 * answer this question yet: `expandWeekly` returns nothing and this route says
 * which dates are missing instead of inventing a term.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; assessmentId: string }> },
) {
  const denied = crossSiteDenied(req);
  if (denied) return denied;

  const { userId } = await resolveVisitor();
  if (!userId) return fail("Sign in first.", 401);

  const limit = checkLimit(`user:${userId}`, "edit:user");
  if (!limit.allowed) return rateLimited(describeLimit(limit));

  const { id: courseId, assessmentId } = await ctx.params;
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

  const weekday = body.weekday;
  if (typeof weekday !== "number" || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    return fail("Invalid change.", 422, "weekday must be an integer from 0 (Sunday) to 6 (Saturday)");
  }
  // Absent and null both mean "the syllabus already said when, or nobody has":
  // `expandWeekly` falls back to the placeholder's own `dueTime`, which is
  // where the document's "11:59PM" is if it stated one.
  const rawTime = body.time ?? null;
  if (rawTime !== null && !(typeof rawTime === "string" && isRealTime(rawTime))) {
    return fail("Invalid change.", 422, "time must be HH:MM (24h) or null");
  }
  const time = rawTime as string | null;

  try {
    // Ownership the same way its siblings prove it: the course is checked
    // against the caller, and the item is found in the caller's own list, so a
    // stranger's id 404s exactly like one that does not exist.
    const course = await store.getCourse(courseId);
    if (!course || course.userId !== userId) return fail("Course not found.", 404);

    const placeholder = (await store.listAssessments(userId)).find(
      (a) => a.id === assessmentId && a.courseId === courseId,
    );
    if (!placeholder) return fail("Assessment not found.", 404);

    const items = expandWeekly(course, placeholder, weekday, time);
    if (items.length === 0) {
      return fail(
        "Add the term dates first.",
        422,
        "A weekly item needs the term's start and end dates to know how many weeks to create. Set them on the course, then answer this again.",
      );
    }
    if (items.length > MAX_WEEKLY_ITEMS) {
      return fail(
        "Check the term dates.",
        422,
        `That term is ${items.length} weeks long, which would create ${items.length} items. Correct the course's start and end dates first.`,
      );
    }

    let created = 0;
    for (const item of items) {
      const saved = await store.createAssessment(userId, courseId, item);
      // Ownership was proved above, so this is the course vanishing underneath
      // a concurrent delete. Stop rather than write the rest into nothing.
      if (!saved) break;
      created += 1;
    }
    if (created === 0) return fail("Course not found.", 404);

    // The placeholder only goes once its replacements exist: a delete that ran
    // first and a create that then failed would leave the student with neither
    // the rule nor the dates.
    const deletion = await store.deleteAssessment(userId, assessmentId);
    if (deletion) {
      // Best effort and reported, never thrown -- the same rule the assessment
      // DELETE route follows: the rows are already gone, and an outage at
      // Google or Notion is not a reason to fail the student's answer.
      try {
        const removal = await deleteCalendarEvents(userId, deletion.calendarLinks);
        if (removal.errors.length > 0) {
          logApiError("assessment.calendar_cleanup_failed", removal.errors[0], {
            userId,
            assessmentId,
          });
        }
      } catch (err) {
        logApiError("assessment.calendar_cleanup_failed", err, { userId, assessmentId });
      }
      try {
        const removal = await archiveNotionPages(userId, deletion.notionPages);
        if (removal.errors.length > 0) {
          logApiError("assessment.notion_cleanup_failed", removal.errors[0], {
            userId,
            assessmentId,
          });
        }
      } catch (err) {
        logApiError("assessment.notion_cleanup_failed", err, { userId, assessmentId });
      }
    }

    log.info("assessment.weekly_expanded", { userId, courseId, assessmentId, created, weekday });
    return ok({ created, deleted: assessmentId });
  } catch (err) {
    logApiError("assessment.weekly_expand_failed", err, { userId, courseId, assessmentId });
    return fail("Could not add those items.", 500, messageOf(err));
  }
}
