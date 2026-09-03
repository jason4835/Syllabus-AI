import { fail, messageOf, ok, rateLimited } from "@/lib/api";
import { logApiError } from "@/lib/log";
import { checkLimit, describeLimit } from "@/lib/ratelimit";
import { readSession } from "@/lib/session";
import { store } from "@/lib/store";
import type { Assessment } from "@/lib/types";
import {
  ASSESSMENT_FIELD_KEYS,
  Invalid,
  collectAssessmentFields,
  requireDateForTime, requireStartForEnd } from "@/lib/validation";

export const dynamic = "force-dynamic";

const ALLOWED_KEYS = new Set<string>(ASSESSMENT_FIELD_KEYS);

/**
 * Adds an item the extractor missed.
 *
 * Field rules are the same ones `PATCH /api/assessments/[id]` enforces (shared
 * in `@/lib/validation`), with one difference: `title` and `kind` have no
 * stored value to fall back on, so they are required rather than optional.
 *
 * `confidence: 1` and a set `reviewedAt` are not flattery -- a person typed
 * this, so there is nothing for anyone to review, and `needsReview()` reads
 * both fields. `sourceText` is null because there is no syllabus line to quote;
 * "show source" correctly has nothing to show.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await readSession();
  if (!userId) return fail("Sign in first.", 401);

  const limit = checkLimit(`user:${userId}`, "edit:user");
  if (!limit.allowed) return rateLimited(describeLimit(limit));

  const { id: courseId } = await ctx.params;
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

  let draft: Omit<Assessment, "id" | "courseId">;
  try {
    draft = build(body);
  } catch (err) {
    if (err instanceof Invalid) return fail("Invalid item.", 422, err.message);
    throw err;
  }

  try {
    // The store proves ownership through the course, so an id that is not the
    // caller's writes nothing and 404s exactly like one that does not exist.
    const created = await store.createAssessment(userId, courseId, draft);
    if (!created) return fail("Course not found.", 404);
    // 200, not 201: every other route in this app answers a success with 200
    // and the client branches on the envelope, not the status code.
    return ok<Assessment>(created);
  } catch (err) {
    logApiError("assessment.create_failed", err, { userId, courseId });
    return fail("Could not add that item.", 500, messageOf(err));
  }
}

/** Untrusted body -> a complete new assessment, or `Invalid` naming the field. */
function build(body: Record<string, unknown>): Omit<Assessment, "id" | "courseId"> {
  for (const key of Object.keys(body)) {
    if (!ALLOWED_KEYS.has(key)) throw new Invalid(`${key} is not a settable field`);
  }
  if (!("title" in body)) throw new Invalid("title is required");
  if (!("kind" in body)) throw new Invalid("kind is required");

  const fields = collectAssessmentFields(body);
  const dueDate = fields.dueDate ?? null;
  const dueTime = fields.dueTime ?? null;
  requireDateForTime(dueDate, dueTime);
  const endTime = fields.endTime ?? null;
  requireStartForEnd(dueTime, endTime);

  const now = new Date().toISOString();
  return {
    // Non-null after the required-key checks above; the validators return the
    // trimmed/normalised values.
    title: fields.title as string,
    kind: fields.kind as Assessment["kind"],
    dueDate,
    dueTime,
    endTime,
    weightPercent: fields.weightPercent ?? null,
    // Nothing was extracted, so there is nothing to quote.
    sourceText: null,
    // A person typed it: certain, and already reviewed.
    confidence: 1,
    reviewedAt: now,
    notes: fields.notes ?? null,
  };
}
