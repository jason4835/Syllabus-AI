import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { publicOrigin } from "@/lib/api";
import { getAuthUrl, isGoogleConfigured } from "@/lib/google/oauth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // This route is reached by a browser navigation, not by fetch, so a JSON
  // error body is a dead end: the user is left staring at raw text in a tab
  // with nothing to click. Send them back to the landing page with a reason
  // the page can phrase in English -- same contract as /api/auth/callback.
  if (!isGoogleConfigured()) {
    const url = new URL("/", publicOrigin(req));
    url.searchParams.set("auth_error", "google_not_configured");
    return NextResponse.redirect(url);
  }

  // CSRF: the state we hand Google must come back unchanged, so stash it in a
  // short-lived cookie the callback compares against.
  const state = randomBytes(16).toString("hex");
  const jar = await cookies();
  jar.set("sylb_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });
  return NextResponse.redirect(getAuthUrl(state));
}
