import { fail, messageOf, ok, rateLimited } from "@/lib/api";
import { deleteCalendarEvents } from "@/lib/google/calendar";
import { logApiError } from "@/lib/log";
import { archiveNotionPages } from "@/lib/notion/sync";
import { checkLimit, describeLimit } from "@/lib/ratelimit";
import { resolveSession } from "@/lib/session";
import { store } from "@/lib/store";
import type { Assessment } from "@/lib/types";
import {
  ASSESSMENT_FIELD_KEYS,
  Invalid,
  collectAssessmentFields,
  requireDateForTime, requireStartForEnd } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * `reviewed` is a PATCH-only verb -- it records that a person looked, which is
 * meaningless on a create.
 */
const ALLOWED_KEYS = new Set<string>([...ASSESSMENT_FIELD_KEYS, "reviewed"]);

/**
 * Turns an untrusted partial body into a store patch, or throws `Invalid`
 * naming the first bad field. Unknown keys are rejected rather than ignored:
 * a typo like `duedate` silently doing nothing is worse than an error.
 *
 * The per-field rules live in `@/lib/validation` because the create route
 * enforces exactly the same ones; what stays here is what is specific to a
 * PATCH -- which keys are editable, `reviewed`, and "nothing to change".
 */
function validate(body: Record<string, unknown>, current: Assessment): Partial<Assessment> {
  for (const key of Object.keys(body)) {
    if (!ALLOWED_KEYS.has(key)) throw new Invalid(`${key} is not an editable field`);
  }
  const fields = collectAssessmentFields(body);

  // A time with no date has no meaning; check against the values this patch
  // will leave in place, not just the ones in the body.
  requireDateForTime(
    fields.dueDate !== undefined ? fields.dueDate : current.dueDate,
    fields.dueTime !== undefined ? fields.dueTime : current.dueTime,
  );
  requireStartForEnd(
    fields.dueTime !== undefined ? fields.dueTime : current.dueTime,
    fields.endTime !== undefined ? fields.endTime : current.endTime,
  );

  if ("reviewed" in body && body.reviewed !== true) {
    // There is no un-review: once a person has looked, that fact stands.
    throw new Invalid("reviewed may only be true");
  }
  if (Object.keys(fields).length === 0 && body.reviewed !== true) throw new Invalid("nothing to change");

  const patch: Partial<Assessment> = { ...fields };

  // Editing is reviewing. Any accepted request clears the review flag.
  patch.reviewedAt = new Date().toISOString();
  return patch;
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { userId } = await resolveSession();
  if (!userId) return fail("Sign in first.", 401);

  const limit = checkLimit(`user:${userId}`, "edit:user");
  if (!limit.allowed) return rateLimited(describeLimit(limit));

  const { id } = await ctx.params;
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail("Send a JSON object.", 400);
    body = parsed as Record<string, unknown>;
  } catch {
    return fail("Could not read that request.", 400);
  }

  try {
    // Ownership is enforced by the store; fetching first lets validation see
    // the current date/time pair, and a stranger's id 404s identically.
    const mine = (await store.listAssessments(userId)).find((a) => a.id === id);
    if (!mine) return fail("Assessment not found.", 404);

    let patch: Partial<Assessment>;
    try {
      patch = validate(body, mine);
    } catch (err) {
      if (err instanceof Invalid) return fail("Invalid change.", 422, err.message);
      throw err;
    }

    const updated = await store.updateAssessment(userId, id, patch);
    if (!updated) return fail("Assessment not found.", 404);
    return ok<Assessment>(updated);
  } catch (err) {
    logApiError("assessment.update_failed", err, { userId, assessmentId: id });
    return fail("Could not save that change.", 500, messageOf(err));
  }
}

/**
 * Removes one item the extractor invented, or one the student dropped.
 *
 * The store does the cascade -- calendar link, Notion link, and the links for
 * the study sessions the planner minted from this deadline -- and hands the
 * dropped links back, because they are the last record of the event and page
 * ids they name. This is `DELETE /api/courses/[id]` narrowed to one row, and
 * it has the same reason to exist: once the links are gone, nothing in the app
 * can reach that deadline's calendar event or its Notion rows again, and a
 * deleted item would keep its 9pm reminder for the rest of the term.
 *
 * The plan itself needs no cleanup: study blocks are generated per request, so
 * they simply stop being generated.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { userId } = await resolveSession();
  if (!userId) return fail("Sign in first.", 401);

  const limit = checkLimit(`user:${userId}`, "edit:user");
  if (!limit.allowed) return rateLimited(describeLimit(limit));

  const { id } = await ctx.params;
  try {
    // Scoped by userId in the store, so a stranger's id 404s here rather than
    // deleting someone else's item -- and a second delete of your own 404s too.
    const deletion = await store.deleteAssessment(userId, id);
    if (!deletion) return fail("Assessment not found.", 404);

    // Best effort, both of them, and reported rather than thrown: the item is
    // already gone, and an outage at Google or Notion is not a reason to tell
    // the student otherwise.
    let calendarEventsRemoved = 0;
    try {
      const removal = await deleteCalendarEvents(userId, deletion.calendarLinks);
      calendarEventsRemoved = removal.removed;
      if (removal.errors.length > 0) {
        logApiError("assessment.calendar_cleanup_failed", removal.errors[0], {
          userId,
          assessmentId: id,
        });
      }
    } catch (err) {
      logApiError("assessment.calendar_cleanup_failed", err, {
        userId,
        assessmentId: id,
      });
    }

    let notionPagesRemoved = 0;
    try {
      const removal = await archiveNotionPages(userId, deletion.notionPages);
      notionPagesRemoved = removal.removed;
      if (removal.errors.length > 0) {
        logApiError("assessment.notion_cleanup_failed", removal.errors[0], {
          userId,
          assessmentId: id,
        });
      }
    } catch (err) {
      logApiError("assessment.notion_cleanup_failed", err, {
        userId,
        assessmentId: id,
      });
    }

    return ok({ deleted: true, calendarEventsRemoved, notionPagesRemoved });
  } catch (err) {
    logApiError("assessment.delete_failed", err, { userId, assessmentId: id });
    return fail("Could not delete that item.", 500, messageOf(err));
  }
}
