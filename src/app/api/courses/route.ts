import { fail, messageOf, ok } from "@/lib/api";
import { logApiError } from "@/lib/log";
import { ensureDemoSeed, resolveVisitor } from "@/lib/demo";
import { store } from "@/lib/store";
import { ensureTermsBackfilled } from "@/lib/term-backfill";

export const dynamic = "force-dynamic";

export async function GET() {
  const { userId } = await resolveVisitor();
  if (!userId) return fail("Sign in first.", 401);
  await ensureDemoSeed(userId);
  try {
    // The lazy migration that gives every course a term, run here because this
    // is the read every client makes first: an account that predates terms gets
    // its grandfathered terms on the next dashboard load rather than needing a
    // SQL migration. A no-op once every course has a `termId`.
    await ensureTermsBackfilled(userId);
    const [courses, assessments] = await Promise.all([
      store.listCourses(userId),
      store.listAssessments(userId),
    ]);
    return ok({ courses, assessments });
  } catch (err) {
    logApiError("courses.list_failed", err, { userId });
    return fail("Could not load your courses.", 500, messageOf(err));
  }
}
