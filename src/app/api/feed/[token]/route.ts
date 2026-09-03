import { NextResponse } from "next/server";
import { fail, rateLimited } from "@/lib/api";
import { buildCalendarEvents } from "@/lib/calendar/events";
import { renderIcs } from "@/lib/calendar/ics";
import { logApiError } from "@/lib/log";
import { buildSemesterPlan } from "@/lib/plan";
import { checkLimit, describeLimit } from "@/lib/ratelimit";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * The private calendar feed. Unauthenticated on purpose: subscription clients
 * cannot log in, so the token in the path IS the credential. That is why the
 * token is 32 random bytes, why an unknown one 404s identically to a missing
 * user, and why a wrong guess costs the guesser a rate-limit window.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token: raw } = await ctx.params;
  const token = raw.replace(/\.ics$/i, "");
  if (token.length < 32 || !/^[A-Za-z0-9_-]+$/.test(token)) return fail("Not found.", 404);

  const limit = checkLimit(`feed:${token}`, "feed:token");
  if (!limit.allowed) return rateLimited(describeLimit(limit));

  try {
    const user = await store.getUserByFeedToken(token);
    if (!user) return fail("Not found.", 404);

    const [courses, assessments] = await Promise.all([
      store.listCourses(user.id),
      store.listAssessments(user.id),
    ]);
    const plan = buildSemesterPlan(courses, assessments);
    const timeZone = user.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const events = buildCalendarEvents({
      courses,
      assessments,
      studyBlocks: plan.studyBlocks,
      timeZone,
      term: plan.term ? { start: plan.term.start, end: plan.term.end } : null,
    });
    const body = renderIcs(events, { name: "Syllabus AI", timeZone });

    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'inline; filename="syllabus-ai.ics"',
        // Clients poll on their own schedule; five minutes keeps a manual
        // refresh honest without hammering the store.
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (err) {
    // Never log the token: it is the credential.
    logApiError("feed.render_failed", err, { tokenLength: token.length });
    return fail("Could not build the feed.", 500);
  }
}
