import { fail, messageOf, ok } from "@/lib/api";
import { logApiError } from "@/lib/log";
import { buildNotionStatus } from "@/lib/notion-status";
import { chooseParent } from "@/lib/notion/sync";
import { readSession } from "@/lib/session";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";
// Building the hub is one page plus three databases, throttled at ~3 req/s.
export const maxDuration = 60;

export async function POST(req: Request) {
  const userId = await readSession();
  if (!userId) return fail("Sign in first.", 401);

  let pageId = "";
  try {
    const body = (await req.json()) as { pageId?: unknown };
    if (typeof body?.pageId === "string") pageId = body.pageId.trim();
  } catch {
    return fail("Could not read that request.", 400);
  }
  // Notion ids are 32 hex chars, optionally dashed as a UUID.
  if (!/^[0-9a-f]{32}$|^[0-9a-f-]{36}$/i.test(pageId)) return fail("That is not a Notion page id.", 422);

  const conn = await store.getNotionConnection(userId);
  if (!conn) return fail("Connect Notion first.", 409);

  try {
    await chooseParent(userId, pageId);
    return ok(await buildNotionStatus(userId));
  } catch (err) {
    logApiError("notion.parent_failed", err, { userId, pageId });
    return fail("Could not build the Syllabus AI hub in Notion.", 502, messageOf(err));
  }
}
