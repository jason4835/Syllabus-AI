import { fail, messageOf, ok, rateLimited } from "@/lib/api";
import { logApiError } from "@/lib/log";
import { checkLimit, describeLimit } from "@/lib/ratelimit";
import { readSession } from "@/lib/session";
import { store } from "@/lib/store";
import type { Assessment, AssessmentKind } from "@/lib/types";

export const dynamic = "force-dynamic";

/** The one list the `kind` check is derived from; keep in step with the union. */
const KINDS: readonly AssessmentKind[] = [
  "assignment", "exam", "quiz", "project", "reading", "lab", "presentation", "other",
];

const ALLOWED_KEYS = new Set(["title", "kind", "dueDate", "dueTime", "weightPercent", "notes", "reviewed"]);

class Invalid extends Error {}

function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  // Feb 30 parses as Mar 2; round-tripping catches it.
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Turns an untrusted partial body into a store patch, or throws `Invalid`
 * naming the first bad field. Unknown keys are rejected rather than ignored:
 * a typo like `duedate` silently doing nothing is worse than an error.
 */
function validate(body: Record<string, unknown>, current: Assessment): Partial<Assessment> {
  for (const key of Object.keys(body)) {
    if (!ALLOWED_KEYS.has(key)) throw new Invalid(`${key} is not an editable field`);
  }
  const patch: Partial<Assessment> = {};

  if ("title" in body) {
    const t = typeof body.title === "string" ? body.title.trim() : "";
    if (t.length < 1 || t.length > 200) throw new Invalid("title must be 1-200 characters");
    patch.title = t;
  }
  if ("kind" in body) {
    if (!KINDS.includes(body.kind as AssessmentKind)) throw new Invalid(`kind must be one of: ${KINDS.join(", ")}`);
    patch.kind = body.kind as AssessmentKind;
  }
  if ("dueDate" in body) {
    if (body.dueDate !== null && !(typeof body.dueDate === "string" && isRealDate(body.dueDate))) {
      throw new Invalid("dueDate must be YYYY-MM-DD or null");
    }
    patch.dueDate = body.dueDate as string | null;
  }
  if ("dueTime" in body) {
    if (body.dueTime !== null && !(typeof body.dueTime === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.dueTime))) {
      throw new Invalid("dueTime must be HH:MM (24h) or null");
    }
    patch.dueTime = body.dueTime as string | null;
  }
  // A time with no date has no meaning; check against the date this patch
  // will leave in place, not just the one in the body.
  const finalDate = "dueDate" in patch ? patch.dueDate : current.dueDate;
  const finalTime = "dueTime" in patch ? patch.dueTime : current.dueTime;
  if (finalTime && !finalDate) throw new Invalid("dueTime requires a dueDate");

  if ("weightPercent" in body) {
    const w = body.weightPercent;
    if (w !== null && !(typeof w === "number" && Number.isFinite(w) && w >= 0 && w <= 100)) {
      throw new Invalid("weightPercent must be a number from 0 to 100, or null");
    }
    patch.weightPercent = w === null ? null : Math.round((w as number) * 100) / 100;
  }
  if ("notes" in body) {
    if (body.notes !== null && !(typeof body.notes === "string" && body.notes.length <= 2000)) {
      throw new Invalid("notes must be at most 2000 characters, or null");
    }
    patch.notes = body.notes as string | null;
  }
  if ("reviewed" in body && body.reviewed !== true) {
    // There is no un-review: once a person has looked, that fact stands.
    throw new Invalid("reviewed may only be true");
  }
  if (Object.keys(patch).length === 0 && body.reviewed !== true) throw new Invalid("nothing to change");

  // Editing is reviewing. Any accepted request clears the review flag.
  patch.reviewedAt = new Date().toISOString();
  return patch;
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await readSession();
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
