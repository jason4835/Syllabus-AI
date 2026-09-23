/**
 * Google sign-in, leg 2 of 2: verify the handshake and open a session.
 *
 * Paired with `/api/auth/google`, which minted the `state` checked below. Three
 * things have to hold before anyone is signed in: Google did not report an
 * error, a code came back, and the `state` matches the cookie exactly. Any miss
 * is a redirect to the landing page with a reason, because this is a browser
 * navigation and a JSON error body would leave the user staring at raw text.
 *
 * The signature on the `id_token` is verified inside `exchangeCode`, not here.
 * That is the step that decides *who* this is, so it is not optional and it is
 * not a decode.
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { track } from "@/lib/analytics";
import { messageOf, publicOrigin } from "@/lib/api";
import { logApiError } from "@/lib/log";
import { exchangeCode } from "@/lib/google/oauth";
import { createSession } from "@/lib/session";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";

function backToLanding(req: Request, reason: string) {
  const url = new URL("/", publicOrigin(req));
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
    // Look up by email first, and keep the id already on file.
    //
    // New accounts are keyed by Google's `sub`, which is stable and is the
    // right thing to key on. But rows written by earlier builds used other
    // ids, and every course, assessment and calendar link points at whatever
    // this row's id is. Preferring `profile.sub` for a user who already exists
    // would mint a SECOND account on the same email and strand their whole
    // semester behind an id nothing signs in as any more.
    //
    // Email is safe to *look up* by here precisely because it is not what
    // authenticated anyone: the verified `id_token` did that, one line above.
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
    // The conversion the landing page is judged on. `isReturning` rather than a
    // separate event, so one funnel step covers both and the split is a filter.
    track("signed_in", { userId: user.id, isReturning: existing !== null });
    return NextResponse.redirect(new URL("/dashboard", publicOrigin(req)));
  } catch (err) {
    logApiError("auth.callback_failed", err);
    return backToLanding(req, encodeURIComponent(messageOf(err)));
  }
}
