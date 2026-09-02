import { fail, messageOf, ok, rateLimited } from "@/lib/api";
import { logApiError } from "@/lib/log";
import { isNotionConfigured } from "@/lib/notion/oauth";
import { syncToNotion } from "@/lib/notion/sync";
import { buildSemesterPlan } from "@/lib/plan";
import { parseSyllabus } from "@/lib/parse";
import { checkLimit, describeLimit } from "@/lib/ratelimit";
import { readSession } from "@/lib/session";
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
  const userId = await readSession();
  if (!userId) return fail("Sign in first.", 401);

  const limit = checkLimit(`user:${userId}`, "upload:user");
  if (!limit.allowed) return rateLimited(describeLimit(limit));


  let file: File | null = null;
  try {
    const form = await req.formData();
    const field = form.get("file");
    if (field instanceof File) file = field;
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
    const { course, assessments } = await store.createCourse(userId, parsed);
    const notion = await createNotionPage(userId, course, assessments);
    return ok({ courseId: course.id, course, assessments, warnings: parsed.warnings, notion });
  } catch (err) {
    logApiError("upload.failed", err, { userId, filename: name, bytes: file.size });
    return fail("Could not read that syllabus.", 422, messageOf(err));
  }
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
    const plan = buildSemesterPlan([course], assessments);
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
