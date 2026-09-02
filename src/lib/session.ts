/**
 * Cookie-based sessions, signed with an HMAC.
 *
 * We deliberately avoid a session library: the only thing we need to carry
 * between requests is a user id, and a stateless signed cookie means there is
 * no session store to run, expire, or keep in sync with the user store.
 *
 * The cookie is *signed, not encrypted*. The user id is not a secret; the
 * signature only has to stop a client from handing us somebody else's id.
 *
 * Server-only: `next/headers` throws outside a request scope.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

/** Name is short and app-scoped so it cannot collide with a host app's cookies. */
export const SESSION_COOKIE_NAME = "sylb_session";

/** 30 days -- long enough that a student is not re-authing every semester week. */
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/**
 * Stable id for the seeded demo account. Demo mode has to work with zero
 * config, so this id is a constant rather than something generated at boot --
 * seeded fixtures in the store can reference it directly.
 */
export const DEMO_USER_ID = "demo-user";

/**
 * Only ever used when SESSION_SECRET is unset, i.e. local dev and demo. It is
 * a published constant, so a session signed with it is forgeable -- which is
 * exactly why production refuses to use it (see getSecret).
 */
const DEV_ONLY_SECRET = "syllabus-ai-dev-only-insecure-session-secret";

/**
 * 32 chars is `openssl rand -hex 32` truncated by half -- short enough that no
 * legitimately generated secret trips it, long enough to reject the "changeme"
 * and "secret123" values that otherwise sail through a presence check.
 */
export const MIN_SESSION_SECRET_LENGTH = 32;

let warnedAboutMissingSecret = false;

/**
 * Production must never sign sessions with a guessable key.
 *
 * The cookie is `userId.HMAC(userId)`, so anyone who knows the signing key can
 * mint a valid session for ANY user id -- reading their courses, deleting them,
 * and writing to their Google Calendar. With the published dev constant that is
 * not an attack, it is arithmetic. A warning is not enough: warnings scroll past
 * during a deploy and the app keeps serving forgeable sessions indefinitely.
 *
 * So in production this throws. It throws per-request rather than at module
 * load because `next build` also runs with NODE_ENV=production, and a
 * build-time throw would break the build rather than the deploy. Every caller
 * is a force-dynamic route, so the first real request fails loudly and
 * GET /api/health reports the same problem as `degraded`.
 */
function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  const isProduction = process.env.NODE_ENV === "production";

  if (secret && secret.length >= MIN_SESSION_SECRET_LENGTH) return secret;

  if (isProduction) {
    throw new Error(
      secret
        ? `SESSION_SECRET is only ${secret.length} characters; at least ${MIN_SESSION_SECRET_LENGTH} are required. Generate one with: openssl rand -hex 32`
        : "SESSION_SECRET is not set. Refusing to sign sessions with the public dev-only secret in production. Generate one with: openssl rand -hex 32",
    );
  }

  // Outside production a short secret is the developer's own choice.
  if (secret) return secret;

  // Warn once per process: a per-request warning would drown the dev log.
  if (!warnedAboutMissingSecret) {
    warnedAboutMissingSecret = true;
    console.warn(
      "[session] SESSION_SECRET is not set -- falling back to a PUBLIC dev-only " +
        "secret. Sessions are forgeable. Set SESSION_SECRET before deploying.",
    );
  }
  return DEV_ONLY_SECRET;
}

/**
 * Google credentials are read directly here instead of importing
 * `isGoogleConfigured()` from ./google/oauth. Session reading happens on every
 * request, and that import would pull the (large) googleapis module into paths
 * that never talk to Google. The two checks read the same variables -- keep
 * them in step.
 */
export function isDemoMode(): boolean {
  return !process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET;
}

function base64url(input: Buffer): string {
  return input.toString("base64url");
}

function sign(payload: string): string {
  return base64url(createHmac("sha256", getSecret()).update(payload).digest());
}

/**
 * Cookie value is `<base64url(userId)>.<signature>`. The id is encoded rather
 * than embedded raw so a user id containing "." (or any non-cookie-safe byte)
 * cannot make the value ambiguous to parse.
 */
export function signUserId(userId: string): string {
  const payload = base64url(Buffer.from(userId, "utf8"));
  return `${payload}.${sign(payload)}`;
}

/** Returns the user id when the signature checks out, otherwise null. */
export function verifySessionValue(value: string): string | null {
  const separator = value.indexOf(".");
  if (separator <= 0) return null;

  const payload = value.slice(0, separator);
  const provided = value.slice(separator + 1);
  const expected = sign(payload);

  const providedBytes = Buffer.from(provided, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");

  // timingSafeEqual throws on length mismatch, and the length of a SHA-256 MAC
  // is fixed and public anyway, so comparing lengths first leaks nothing.
  if (providedBytes.length !== expectedBytes.length) return null;
  if (!timingSafeEqual(providedBytes, expectedBytes)) return null;

  const userId = Buffer.from(payload, "base64url").toString("utf8");
  return userId.length > 0 ? userId : null;
}

export async function createSession(userId: string): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE_NAME, signUserId(userId), {
    httpOnly: true,
    sameSite: "lax", // "lax" so the Google OAuth redirect back to us keeps the cookie.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

/**
 * Resolves to the signed-in user id, or null.
 *
 * A valid cookie always wins. Only when there is no usable cookie does demo
 * mode kick in, so a developer who *has* signed in with real credentials is
 * never silently downgraded to the demo account.
 */
export async function readSession(): Promise<string | null> {
  // Called for its validation side effect: without this, a production deploy
  // missing SESSION_SECRET would happily serve the demo path and only blow up
  // later, when someone finally arrived holding a cookie.
  getSecret();

  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE_NAME)?.value;

  if (raw) {
    const userId = verifySessionValue(raw);
    if (userId) return userId;
    // Fall through on a bad signature: a tampered cookie is treated exactly
    // like no cookie at all.
  }

  return isDemoMode() ? DEMO_USER_ID : null;
}

/**
 * Same answer as readSession(), named for call sites that are about to act on
 * behalf of a user. It returns null rather than throwing so routes can shape
 * their own ApiResult error instead of unwinding through an exception.
 */
export async function requireUserId(): Promise<string | null> {
  return readSession();
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  // Overwrite with an expired cookie rather than delete() alone: the same
  // attributes must be sent back or some browsers keep the original.
  jar.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}
