import { fail, messageOf, ok } from "@/lib/api";
import { logApiError } from "@/lib/log";
import { readSession } from "@/lib/session";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Forgets the token and our page links. Deliberately touches nothing inside
 * Notion: the pages are the student's notes now, and deleting them is not a
 * decision this app gets to make.
 */
export async function POST() {
  const userId = await readSession();
  if (!userId) return fail("Sign in first.", 401);
  try {
    await store.deleteNotionConnection(userId);
    return ok({ disconnected: true });
  } catch (err) {
    logApiError("notion.disconnect_failed", err, { userId });
    return fail("Could not disconnect Notion.", 500, messageOf(err));
  }
}
