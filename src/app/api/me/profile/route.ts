import { track } from "@/lib/analytics";
import { crossSiteDenied, fail, messageOf, ok } from "@/lib/api";
import { logApiError } from "@/lib/log";
import { checkLimit, describeLimit } from "@/lib/ratelimit";
import { rateLimited } from "@/lib/api";
import { isDemoUser, requireUserId } from "@/lib/session";
import { canonicalSchool } from "@/lib/schools";
import { store } from "@/lib/store";
import type { UserProfile } from "@/lib/types";

export const dynamic = "force-dynamic";

const YEARS = new Set(["freshman", "sophomore", "junior", "senior", "grad", "other"]);
const SOURCES = new Set(["search", "social", "friend", "ad", "professor", "other"]);
const MAX_SCHOOL_CHARS = 80;

/**
 * The onboarding card's one submission: up to three answers, or a skip.
 *
 * Both paths set `completedAt`, because the card is shown until that is set
 * and "asked once" is the promise -- a student who skipped it must not meet
 * it again on every visit. The answers are the only thing in the app that a
 * syllabus cannot tell it, and they exist to judge an ad campaign by who it
 * actually brought in; nothing in the product reads them.
 *
 * Demo sandboxes are refused: there is no account to attach an answer to, and
 * the card is never shown to one anyway. Validation is an enum check and a
 * length cap -- `school` is free text on purpose (nobody maintains the list of
 * every college), so the cap is what keeps it a label rather than a paragraph.
 */
export async function POST(req: Request) {
  const denied = crossSiteDenied(req);
  if (denied) return denied;

  const userId = await requireUserId();
  if (!userId) return fail("Sign in first.", 401);
  if (isDemoUser(userId)) return fail("Sign in to save your answers.", 403);

  const limit = checkLimit(`user:${userId}`, "edit:user");
  if (!limit.allowed) return rateLimited(describeLimit(limit));

  let body: { school?: unknown; year?: unknown; source?: unknown; skip?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return fail("Could not read that.", 400);
  }

  const patch: Partial<UserProfile> = { completedAt: new Date().toISOString() };
  if (body.skip !== true) {
    if (typeof body.school === "string" && body.school.trim()) {
      // Canonical or nothing: the typed text is matched against the list and
      // only the list's spelling is stored. A miss is kept aside as
      // `schoolOther` rather than dropped -- it is the signal for what the
      // list is missing -- but it never lands in the column that gets grouped.
      const typed = body.school.trim().slice(0, MAX_SCHOOL_CHARS);
      const canonical = canonicalSchool(typed);
      if (canonical) patch.school = canonical;
      else patch.schoolOther = typed;
    }
    if (typeof body.year === "string" && YEARS.has(body.year)) {
      patch.year = body.year as UserProfile["year"];
    }
    if (typeof body.source === "string" && SOURCES.has(body.source)) {
      patch.source = body.source as UserProfile["source"];
    }
  }

  try {
    const user = await store.setUserProfile(userId, patch);
    if (!user) return fail("Account not found.", 404);
    // Coarse labels only. `year` and `source` are enums; `school` is the one
    // free-text answer and is sent as typed -- it is a label, not an identity,
    // and it is the whole reason the question is asked.
    track("onboarding_completed", {
      userId,
      skipped: body.skip === true,
      year: patch.year ?? "unknown",
      source: patch.source ?? "unknown",
      // "other" when it matched nothing: the raw text is a label for nobody
      // but the person who typed it, and is not sent.
      school: patch.school ?? (patch.schoolOther ? "other" : "unknown"),
    });
    return ok({ profile: user.profile ?? {} });
  } catch (err) {
    logApiError("me.profile_failed", err, { userId });
    return fail("Could not save that.", 500, messageOf(err));
  }
}
