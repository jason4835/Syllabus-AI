import { crossSiteDenied, fail, messageOf, ok, rateLimited } from "@/lib/api";
import { resolveVisitor } from "@/lib/demo";
import { summarizeTermFor, type TermSummary } from "@/lib/entitlement";
import { logApiError } from "@/lib/log";
import { checkLimit, describeLimit } from "@/lib/ratelimit";
import { store } from "@/lib/store";
import { premiumEndDateAllowed, premiumExpiresAt, validateTermInput } from "@/lib/terms";
import { Invalid } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** The only keys this route accepts, so a typo is an error rather than a no-op. */
const PATCHABLE = ["name", "termType", "startDate", "endDate", "confirm"] as const;

/**
 * Corrects a term, or confirms one the server inferred from a syllabus.
 *
 * Two rules make this more than a field write:
 *
 * The patch is validated as the MERGED term, not as the fields it carries. A
 * request that moves only `startDate` still has to be judged against the
 * `endDate` already stored, or a two-step edit could park a term backwards or
 * past six months -- and `requireDates` is tied to the term's own state so a
 * confirmed term can never be edited back into a dateless one.
 *
 * A premium term's end date is bounded against what was actually bought
 * (`premiumEndDateAllowed`), and when it moves, the expiry moves with it through
 * the one function that knows the grace period. Shortening is always allowed and
 * pulls the expiry earlier; extending is allowed only inside the slack, so a paid
 * term can be corrected but not renewed.
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

  const unknown = Object.keys(body).filter(
    (key) => !(PATCHABLE as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    return fail("Invalid change.", 422, `unknown field: ${unknown[0]}`);
  }

  if (body.confirm !== undefined && typeof body.confirm !== "boolean") {
    return fail("Invalid change.", 422, "confirm must be true");
  }
  const confirm = body.confirm === true;

  try {
    // Scoped to the owner here as well as in the store, so a stranger's id
    // cannot even reach validation. Missing and not-yours are one answer.
    const term = await store.getTerm(userId, id);
    if (!term) return fail("That term was not found.", 404);

    let input;
    try {
      input = validateTermInput(
        { name: term.name, termType: term.termType, startDate: term.startDate, endDate: term.endDate, ...body },
        // Confirming requires dates, and a term that already has them keeps
        // them: an expiry has to be computable for anything that gets paid for.
        { requireDates: confirm || term.confirmedAt !== null },
      );
    } catch (err) {
      if (err instanceof Invalid) return fail("Invalid change.", 422, err.message);
      throw err;
    }

    const patch: Parameters<typeof store.updateTerm>[2] = {};
    if ("name" in body) patch.name = input.name;
    if ("termType" in body) patch.termType = input.termType;
    if ("startDate" in body) patch.startDate = input.startDate;
    if ("endDate" in body) patch.endDate = input.endDate;

    if (term.premium && input.endDate !== null && input.endDate !== term.endDate) {
      const verdict = premiumEndDateAllowed(term, input.endDate);
      // 409 rather than 422: the request is well formed, it is the term's paid
      // state that refuses it, and the reason is written to be shown as-is.
      if (!verdict.ok) return fail(verdict.reason, 409);
      // The pass follows the term it was bought for. `premiumExpiresAt` is the
      // only place the grace arithmetic lives, and the bound above is what keeps
      // this inside what was paid for.
      patch.premiumExpiresAt = premiumExpiresAt(input.endDate);
    }

    if (confirm) patch.confirmedAt = new Date().toISOString();

    const updated = await store.updateTerm(userId, id, patch);
    if (!updated) return fail("That term was not found.", 404);

    return ok<{ term: TermSummary }>({ term: await summarizeTermFor(userId, updated) });
  } catch (err) {
    logApiError("terms.update_failed", err, { userId, termId: id });
    return fail("Could not save that change.", 500, messageOf(err));
  }
}

/**
 * Deletes an empty term.
 *
 * A term holding courses is refused rather than emptied. The store would set
 * their `termId` to null and keep them -- deleting a term must never delete
 * coursework -- but they would then be term-less courses in an app where the
 * backfill's whole job is that there are none, and the next read would invent a
 * term for them. Asking the student to move them first is the honest order.
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = crossSiteDenied(req);
  if (denied) return denied;

  const { userId } = await resolveVisitor();
  if (!userId) return fail("Sign in first.", 401);

  const limit = checkLimit(`user:${userId}`, "edit:user");
  if (!limit.allowed) return rateLimited(describeLimit(limit));

  const { id } = await ctx.params;
  try {
    const term = await store.getTerm(userId, id);
    if (!term) return fail("That term was not found.", 404);

    const courses = await store.listCourses(userId);
    if (courses.some((c) => c.termId === id)) {
      return fail("Move or delete its courses first.", 409);
    }

    const deleted = await store.deleteTerm(userId, id);
    if (!deleted) return fail("That term was not found.", 404);
    return ok({ deleted: true });
  } catch (err) {
    logApiError("terms.delete_failed", err, { userId, termId: id });
    return fail("Could not delete that term.", 500, messageOf(err));
  }
}
