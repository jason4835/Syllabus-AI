import { ok } from "@/lib/api";
import { logApiError } from "@/lib/log";
import { buildNotionStatus, type NotionStatus } from "@/lib/notion-status";
import { resolveSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const { userId } = await resolveSession();
  if (!userId) return ok<NotionStatus | null>(null);
  try {
    return ok<NotionStatus | null>(await buildNotionStatus(userId));
  } catch (err) {
    // Status is informational; a Notion hiccup must not blank the dashboard.
    logApiError("notion.status_failed", err, { userId });
    return ok<NotionStatus | null>(null);
  }
}
