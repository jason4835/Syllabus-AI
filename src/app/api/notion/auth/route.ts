/**
 * Notion connect, leg 1 of 2: send the browser to Notion's consent screen.
 *
 * Same two-leg shape as Google sign-in, with its own state cookie, and leg 2 is
 * `/api/notion/callback`. The difference is that this one requires an existing
 * session: connecting Notion is something a signed-in student does to an
 * account that already exists, not a way to get one.
 */
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
