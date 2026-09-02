import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { messageOf, publicOrigin } from "@/lib/api";
import { logApiError } from "@/lib/log";
import { exchangeNotionCode } from "@/lib/notion/oauth";
import { chooseParent, listParentCandidates } from "@/lib/notion/sync";
import { readSession } from "@/lib/session";
import { store } from "@/lib/store";
import type { NotionConnection } from "@/lib/types";

export const dynamic = "force-dynamic";

function backToDashboard(req: Request, params: Record<string, string>) {
  const url = new URL("/dashboard", publicOrigin(req));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

export async function GET(req: Request) {
  const userId = await readSession();
  if (!userId) return NextResponse.redirect(new URL("/?auth_error=sign_in_first", publicOrigin(req)));

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (url.searchParams.get("error")) return backToDashboard(req, { notion_error: "denied" });
  if (!code) return backToDashboard(req, { notion_error: "missing_code" });

  const jar = await cookies();
  const expected = jar.get("sylb_notion_state")?.value;
  if (!expected || expected !== state) return backToDashboard(req, { notion_error: "bad_state" });
  jar.delete("sylb_notion_state");

  try {
    const token = await exchangeNotionCode(code);
    const conn: NotionConnection = {
      userId,
      accessToken: token.accessToken,
      workspaceId: token.workspaceId,
      workspaceName: token.workspaceName,
      botId: token.botId,
      parentPageId: null,
      hubPageId: null,
      hubUrl: null,
      coursesDbId: null,
      assignmentsDbId: null,
      sessionsDbId: null,
      status: "needs_parent",
      connectedAt: new Date().toISOString(),
    };
    await store.setNotionConnection(conn);

    // The common case is that the user shared exactly one page during consent.
    // Build the hub there straight away so the dashboard shows a finished
    // connection instead of a picker with a single option in it.
    const candidates = await listParentCandidates(conn);
    if (candidates.length === 1) await chooseParent(userId, candidates[0].id);

    return backToDashboard(req, { notion: "connected" });
  } catch (err) {
    logApiError("notion.callback_failed", err, { userId });
    return backToDashboard(req, { notion_error: encodeURIComponent(messageOf(err)) });
  }
}
