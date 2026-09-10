import { NextResponse } from "next/server";

import { fail, messageOf, ok, rateLimited } from "@/lib/api";
import { deleteCalendarEvents } from "@/lib/google/calendar";
import { logApiError } from "@/lib/log";
import { isNotionConfigured } from "@/lib/notion/oauth";
import { archiveNotionPages, syncToNotion } from "@/lib/notion/sync";
import { buildSemesterPlan } from "@/lib/plan";
import { parseSyllabus } from "@/lib/parse";
import { checkLimit, describeLimit } from "@/lib/ratelimit";
import { resolveSession } from "@/lib/session";
import { store } from "@/lib/store";
import type { Assessment, Course } from "@/lib/types";
import { attachWeights } from "@/lib/weights";

export const dynamic = "force-dynamic";
// Parsing a long syllabus through an LLM comfortably exceeds the default.
// A long syllabus through the model can genuinely take a minute or more.
// Must not exceed your host's per-function ceiling -- check Vercel's current
// plan limits before changing it, since a value over the cap fails the deploy.
export const maxDuration = 120;

const MAX_BYTES = 15 * 1024 * 1024;

export async function POST(req: Request) {
  const { userId } = await resolveSession();
  if (!userId) return fail("Sign in first.", 401);

  const limit = checkLimit(`user:${userId}`, "upload:user");
  if (!limit.allowed) return rateLimited(describeLimit(limit));


  let file: File | null = null;
  // Both duplicate answers ride on the same multipart body as the file: the
  // client re-posts the identical form with one extra field, so nothing here
  // has to hold the parsed syllabus between two requests.
  let replaceId: string | null = null;
  let allowDuplicate = false;
  try {
    const form = await req.formData();
    const field = form.get("file");
    if (field instanceof File) file = field;
    const replace = form.get("replace");
    if (typeof replace === "string" && replace.trim()) replaceId = replace.trim();
    allowDuplicate = form.get("allowDuplicate") === "1";
  } catch {
    return fail("Could not read the upload.", 400);
  }
  if (!file) return fail("No file received. Attach a syllabus PDF.", 400);
  if (file.size === 0) return fail("That file is empty.", 400);
  if (file.size > MAX_BYTES) {
    return fail(`That file is ${(file.size / 1048576).toFixed(1)} MB. The limit is 15 MB.`, 413);
  }

  const name = file.name || "syllabus.pdf";
  if (!/\.(pdf|txt)$/i.test(name)) {
    return fail("Upload a PDF (or a .txt) syllabus.", 415);
  }

  try {
    const buf = Buffer.from(await file.arrayBuffer());
    // The grading table and the schedule are extracted separately; join them
    // before persisting so the workload model sees real weights.
    const parsed = attachWeights(await parseSyllabus(buf, name));

    // Duplicate check BEFORE the write: the common way to end up with two
    // copies of one class is uploading the same PDF twice (a failed-looking
    // request that actually succeeded, a re-download of the same file), and a
    // second copy is worse than a blocked upload -- it doubles every deadline
    // in the heatmap and the plan, and nothing on screen says which is which.
    const existing = (await store.listCourses(userId)).find(
      (c) =>
        normalizeCode(c.code) === normalizeCode(parsed.course.code) &&
        normalizeTerm(c.term) === normalizeTerm(parsed.course.term),
    );

    if (existing && !replaceId && !allowDuplicate) {
      // The one response in the app that carries a field outside the envelope:
      // the client needs the existing course to offer "replace it" or "keep
      // both", and `detail` is a string. `ok`/`error` keep their usual meaning,
      // so a client that ignores `duplicateOf` still shows a sane message.
      return NextResponse.json(
        {
          ok: false as const,
          error: `You already have ${existing.code} for this term.`,
          duplicateOf: {
            id: existing.id,
            code: existing.code,
            title: existing.title,
            term: existing.term,
          },
        },
        { status: 409 },
      );
    }

    // `replace` only means anything for the course this upload actually
    // collides with. A mismatched id is a stale or hand-made request, and
    // deleting whatever it happens to name would be catastrophic.
    const replacing = existing && replaceId === existing.id ? existing.id : null;
    if (replaceId && !replacing) {
      return fail("That course is not the one this upload duplicates.", 409);
    }

    const { course, assessments } = await store.createCourse(userId, parsed);
    // Deleted only after the new course is safely stored: the reverse order
    // would lose the old syllabus if the write failed.
    //
    // The old course's Google events go with it. Every id in the new course is
    // freshly minted, so nothing the next sync writes will land on top of the
    // old events -- leaving them behind means a re-upload silently doubles the
    // whole semester on the student's calendar, which is the single worst
    // outcome of a flow whose entire point is "this replaces that". Best
    // effort, like the delete route: the upload has already succeeded.
    if (replacing) {
      const deletion = await store.deleteCourse(userId, replacing);
      if (deletion && deletion.calendarLinks.length > 0) {
        try {
          const removal = await deleteCalendarEvents(userId, deletion.calendarLinks);
          if (removal.errors.length > 0) {
            logApiError("upload.calendar_cleanup_failed", removal.errors[0], {
              userId,
              courseId: replacing,
            });
          }
        } catch (err) {
          logApiError("upload.calendar_cleanup_failed", err, {
            userId,
            courseId: replacing,
          });
        }
      }
      // And the old course's Notion rows, for the identical reason: the new
      // course's ids are all fresh, so the rows this upload writes sit beside
      // the old ones rather than on top of them, and a re-upload would double
      // the Coursework database the same way it would double the calendar.
      if (deletion && deletion.notionPages.length > 0) {
        try {
          const removal = await archiveNotionPages(userId, deletion.notionPages);
          if (removal.errors.length > 0) {
            logApiError("upload.notion_cleanup_failed", removal.errors[0], {
              userId,
              courseId: replacing,
            });
          }
        } catch (err) {
          logApiError("upload.notion_cleanup_failed", err, {
            userId,
            courseId: replacing,
          });
        }
      }
    }

    const notion = await createNotionPage(userId, course, assessments);
    return ok({
      courseId: course.id,
      course,
      assessments,
      warnings: parsed.warnings,
      replaced: replacing,
      notion,
    });
  } catch (err) {
    logApiError("upload.failed", err, { userId, filename: name, bytes: file.size });
    return fail("Could not read that syllabus.", 422, messageOf(err));
  }
}

/**
 * "MATH 221", "math221" and " MATH  221 " are one course code.
 *
 * Whitespace goes entirely rather than collapsing to a single space: the same
 * class arrives as "MATH 221" from one syllabus and "MATH221" from the next,
 * and a duplicate check that misses that is a duplicate check that never fires.
 */
function normalizeCode(code: string): string {
  return code.replace(/\s+/g, "").toUpperCase();
}

/**
 * Terms are compared loosely (case and surrounding space) but not restructured:
 * "Fall 2026" and "Spring 2026" are different semesters of the same course and
 * must both be allowed to exist. Two nulls match -- an unstated term is not a
 * different term, and treating null as unique would let the same syllabus be
 * uploaded any number of times whenever the parser failed to find a term.
 */
function normalizeTerm(term: string | null): string {
  return (term ?? "").trim().toLowerCase();
}

type UploadNotion = { pageUrl: string | null; hubUrl: string | null; error: string | null } | null;

/**
 * The promise of the feature: the class page exists the moment the upload
 * finishes. Best-effort by design -- the syllabus is already saved, so a Notion
 * failure is reported on the response, never allowed to fail the upload.
 * Returns null when Notion simply is not connected, so the client can tell
 * "not set up" apart from "tried and failed".
 */
async function createNotionPage(
  userId: string,
  course: Course,
  assessments: Assessment[],
): Promise<UploadNotion> {
  if (!isNotionConfigured()) return null;
  const conn = await store.getNotionConnection(userId);
  if (!conn || conn.status !== "connected") return null;
  try {
    const plan = buildSemesterPlan([course], assessments, {
      // The student's zone, not the host's — otherwise an evening upload can
      // lose its first study session to a "today" that has already rolled over.
      timeZone: (await store.getUser(userId))?.timezone ?? undefined,
    });
    const result = await syncToNotion(userId, {
      courses: [course],
      assessments,
      studyBlocks: plan.studyBlocks,
    });
    return {
      pageUrl: result.coursePages[course.id] ?? null,
      hubUrl: result.hubUrl,
      error: result.errors.length > 0 ? result.errors[0] : null,
    };
  } catch (err) {
    logApiError("upload.notion_failed", err, { userId, courseId: course.id });
    return { pageUrl: null, hubUrl: conn.hubUrl, error: messageOf(err) };
  }
}
