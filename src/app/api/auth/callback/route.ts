import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { messageOf } from "@/lib/api";
import { logApiError } from "@/lib/log";
import { exchangeCode } from "@/lib/google/oauth";
import { createSession } from "@/lib/session";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";

function backToLanding(req: Request, reason: string) {
  const url = new URL("/", req.url);
  url.searchParams.set("auth_error", reason);
  return NextResponse.redirect(url);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const denied = url.searchParams.get("error");
  if (denied) return backToLanding(req, denied);
  if (!code) return backToLanding(req, "missing_code");

  const jar = await cookies();
  const expected = jar.get("sylb_oauth_state")?.value;
  if (!expected || expected !== state) return backToLanding(req, "bad_state");
  jar.delete("sylb_oauth_state");

  try {
    const { profile, refreshToken } = await exchangeCode(code);
    const existing = await store.getUserByEmail(profile.email);
    const user = await store.upsertUser({
      id: existing?.id ?? profile.sub,
      email: profile.email,
      name: profile.name ?? null,
      picture: profile.picture ?? null,
      // Google only returns a refresh token on first consent; keep the old one
      // rather than nulling out calendar access on a repeat sign-in.
      googleRefreshToken: refreshToken ?? existing?.googleRefreshToken ?? null,
    });
    await createSession(user.id);
    return NextResponse.redirect(new URL("/dashboard", req.url));
  } catch (err) {
    logApiError("auth.callback_failed", err);
    return backToLanding(req, encodeURIComponent(messageOf(err)));
  }
}
