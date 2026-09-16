import { NextResponse } from "next/server";

import { crossSiteDenied, fail, messageOf, ok, rateLimited } from "@/lib/api";
import { track } from "@/lib/analytics";
import {
  PaywallError,
  assertCanAddCourse,
  paywallResponse,
  resolveTermForUpload,
  summarizeTermFor,
  type TermSummary,
} from "@/lib/entitlement";
import { deleteCalendarEvents } from "@/lib/google/calendar";
import { logApiError } from "@/lib/log";
import { isNotionConfigured } from "@/lib/notion/oauth";
import { archiveNotionPages, syncToNotion } from "@/lib/notion/sync";
import { buildSemesterPlan } from "@/lib/plan";
import { parseSyllabus } from "@/lib/parse";
import { AiBusyError } from "@/lib/parse/extract";
import { checkLimit, describeLimit } from "@/lib/ratelimit";
import { store } from "@/lib/store";
import type { Assessment, Course } from "@/lib/types";
import { Invalid } from "@/lib/validation";
import { attachWeights } from "@/lib/weights";
import { resolveVisitor } from "@/lib/demo";

export const dynamic = "force-dynamic";
// Parsing a long syllabus through an LLM comfortably exceeds the default.
// A long syllabus through the model can genuinely take a minute or more.
// Must not exceed your host's per-function ceiling -- check Vercel's current
// plan limits before changing it, since a value over the cap fails the deploy.
export const maxDuration = 120;

const MAX_BYTES = 15 * 1024 * 1024;

export async function POST(req: Request) {
  const denied = crossSiteDenied(req);
  if (denied) return denied;

  const { userId } = await resolveVisitor();
  if (!userId) return fail("Sign in first.", 401);

  const limit = checkLimit(`user:${userId}`, "upload:user");
  if (!limit.allowed) return rateLimited(describeLimit(limit));


  /**
   * The declared length first, before `formData()` reads the body into memory.
   *
   * The size check below is the real one -- `Content-Length` is a claim, and a
   * chunked request carries none -- but without this a 60 MB body was fully
   * buffered only to be rejected for being 60 MB. Checking the claim costs
   * nothing and turns the common case of an oversized upload into a header read.
   */
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    return fail(
      `That file is ${(declared / 1048576).toFixed(1)} MB. The limit is 15 MB.`,
      413,
    );
  }

  let file: File | null = null;
  // Both duplicate answers ride on the same multipart body as the file: the
  // client re-posts the identical form with one extra field, so nothing here
  // has to hold the parsed syllabus between two requests.
  let replaceId: string | null = null;
  let allowDuplicate = false;
  /**
   * Which term this syllabus belongs to, when the client knows: an existing term
   * (`termId`) or one the student just typed (`newTerm`, a JSON object in a
   * multipart field). Neither is required -- the server infers a term from the
   * parse when they are absent, which is what keeps the first upload a single
   * step (docs/TERM-PASS.md, "Upload flow").
   */
  let termId: string | null = null;
  let newTerm: unknown;
  let newTermUnreadable = false;
  try {
    const form = await req.formData();
    const field = form.get("file");
    if (field instanceof File) file = field;
    const replace = form.get("replace");
    if (typeof replace === "string" && replace.trim()) replaceId = replace.trim();
    allowDuplicate = form.get("allowDuplicate") === "1";
    const chosenTerm = form.get("termId");
    if (typeof chosenTerm === "string" && chosenTerm.trim()) termId = chosenTerm.trim();
    const typedTerm = form.get("newTerm");
    if (typeof typedTerm === "string" && typedTerm.trim()) {
      try {
        newTerm = JSON.parse(typedTerm);
      } catch {
        // Reported after the form is read rather than thrown, so a bad term
        // field cannot be mistaken for an unreadable upload.
        newTermUnreadable = true;
      }
    }
  } catch {
    return fail("Could not read the upload.", 400);
  }
  if (newTermUnreadable) {
    return fail("Could not read the term you entered.", 422, "newTerm must be JSON");
  }
  if (!file) return fail("No file received. Attach your syllabus.", 400);
  if (file.size === 0) return fail("That file is empty.", 400);
  if (file.size > MAX_BYTES) {
    return fail(`That file is ${(file.size / 1048576).toFixed(1)} MB. The limit is 15 MB.`, 413);
  }

  const name = file.name || "syllabus.pdf";
  /**
   * Extension only, deliberately: what the bytes actually are is decided in the
   * parser, which has the header checks and the wording for each way a file can
   * lie about itself. This is the cheap gate that keeps an obvious .jpg or .zip
   * from reaching it.
   *
   * Both Word formats pass: the parser reads a legacy `.doc` as well as a
   * `.docx`, and tells the two apart by their bytes, not their names.
   */
  if (!/\.(pdf|docx?|txt)$/i.test(name)) {
    return fail("Upload a PDF, a Word document (.docx or .doc), or a .txt syllabus.", 415);
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

    /**
     * The term, then the paywall, then the write -- in that order, and all of it
     * before anything is created. A student who is going to be refused must be
     * refused before a course exists, or the 402 would be a lie told next to a
     * new course on their dashboard.
     *
     * A replace is exempted from its own count: the course being replaced is
     * about to be deleted, so counting it would make "re-upload a corrected
     * syllabus" hit the paywall in a term the student is not adding anything to.
     */
    let term;
    let termSuggested: boolean;
    let before: TermSummary;
    try {
      const resolved = await resolveTermForUpload(userId, parsed, { termId, newTerm });
      term = resolved.term;
      termSuggested = resolved.suggested;
      before = await assertCanAddCourse(userId, term, {
        excludingCourseId: replacing ?? undefined,
      });
    } catch (err) {
      if (err instanceof PaywallError) return paywallResponse(err);
      if (err instanceof Invalid) return fail("Invalid term.", 422, err.message);
      throw err;
    }

    const { course, assessments } = await store.createCourse(userId, parsed, term.id);
    // The activation moment, counted once: a replace is not a first course, even
    // when it is the only one in the term.
    if (!replacing && before.courseCount === 0) {
      track("first_course_created", { userId, termId: term.id });
    }
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
      // Recomputed after the write (and after a replace's delete), so the count
      // and the free slot the client reads are the ones that are now true.
      term: await summarizeTermFor(userId, term),
      // True only when the server INFERRED this term: the setup card asks the
      // student to confirm it, and nothing else in the flow does.
      termSuggested,
    });
  } catch (err) {
    logApiError("upload.failed", err, { userId, filename: name, bytes: file.size });
    if (err instanceof AiBusyError) {
      return fail(
        "The syllabus reader is busy right now.",
        503,
        "Several syllabi are being read at once. Nothing was saved -- try again in a minute.",
        { "Retry-After": "60" },
      );
    }
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
