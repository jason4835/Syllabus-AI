import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { fail } from "@/lib/api";
import { getAuthUrl, isGoogleConfigured } from "@/lib/google/oauth";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!isGoogleConfigured()) {
    return fail(
      "Google sign-in is not configured on this server.",
      503,
      "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then restart. The demo at /dashboard works without them.",
    );
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
