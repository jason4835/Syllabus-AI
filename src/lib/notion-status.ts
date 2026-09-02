import { logApiError } from "@/lib/log";
import { isNotionConfigured } from "@/lib/notion/oauth";
import { listParentCandidates } from "@/lib/notion/sync";
import { store } from "@/lib/store";
import type { NotionConnection } from "@/lib/types";

/**
 * The status shape two routes answer with (status, and parent after it builds
 * the hub). Lives outside the route files because Next.js only permits HTTP
 * verbs and config exports there.
 */
export interface NotionStatus {
  configured: boolean;
  connected: boolean;
  status: NotionConnection["status"] | null;
  workspaceName: string | null;
  hubUrl: string | null;
  needsParent: boolean;
  candidates: { id: string; title: string; url: string }[];
  coursePages: Record<string, string>;
}

/** Shared with the parent route, which answers with the same shape. */
export async function buildNotionStatus(userId: string): Promise<NotionStatus> {
  const configured = isNotionConfigured();
  const conn = await store.getNotionConnection(userId);
  const empty: NotionStatus = {
    configured,
    connected: false,
    status: null,
    workspaceName: null,
    hubUrl: null,
    needsParent: false,
    candidates: [],
    coursePages: {},
  };
  if (!conn) return empty;

  const coursePages: Record<string, string> = {};
  for (const link of await store.listNotionLinks(userId)) {
    if (link.kind === "course" && link.url) coursePages[link.entityId] = link.url;
  }

  const needsParent = conn.status === "needs_parent";
  let candidates: NotionStatus["candidates"] = [];
  if (needsParent) {
    try {
      candidates = await listParentCandidates(conn);
    } catch (err) {
      // A failed search should not hide the connection; the picker just shows
      // "check again" until Notion answers.
      logApiError("notion.candidates_failed", err, { userId });
    }
  }

  return {
    configured,
    connected: conn.status !== "revoked",
    status: conn.status,
    workspaceName: conn.workspaceName,
    hubUrl: conn.hubUrl,
    needsParent,
    candidates,
    coursePages,
  };
}
