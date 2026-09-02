import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { fail, publicOrigin } from "@/lib/api";
import { getNotionAuthUrl, isNotionConfigured } from "@/lib/notion/oauth";
import { readSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const userId = await readSession();
  if (!userId) return NextResponse.redirect(new URL("/?auth_error=sign_in_first", publicOrigin(req)));
  if (!isNotionConfigured()) {
    return fail(
      "Notion is not configured on this server.",
      503,
      "Set NOTION_CLIENT_ID and NOTION_CLIENT_SECRET, then restart.",
    );
  }
  // Same CSRF pattern as Google: the state must come back unchanged.
  const state = randomBytes(16).toString("hex");
  const jar = await cookies();
  jar.set("sylb_notion_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });
  return NextResponse.redirect(getNotionAuthUrl(state));
}
