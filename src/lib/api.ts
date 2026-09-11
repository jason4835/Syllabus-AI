import { NextResponse } from "next/server";
import type { ApiResult } from "@/lib/types";
import { redactSecrets } from "@/lib/log";

/**
 * Every route answers in one envelope so the client has a single shape to
 * branch on -- including failures, which still return 200-shaped JSON bodies
 * with the real status code attached.
 */
/**
 * Rejects a state-changing request that a different site caused the browser to
 * send. Returns a response to hand straight back, or null when the request is
 * fine.
 *
 * `SameSite=Lax` on the session cookie is what actually stops cross-site CSRF
 * today: a cross-origin `fetch` or form POST does not get the cookie, and a
 * `DELETE` would be preflighted and blocked because no CORS headers are sent.
 * That is one control, though, and it is the kind that stops being true
 * quietly -- `SameSite` relaxed to `None` for some future embed, or a
 * side-effecting handler added to a GET, which Lax *does* send the cookie on.
 * The routes behind it delete every course a student owns.
 *
 * So: a second, independent check. `Origin` is set by the browser and cannot be
 * altered by page script, and it is compared against the host the request
 * actually arrived on rather than a configured origin -- that way apex and www
 * both work, and it keeps working the day the domain changes. A request with no
 * `Origin` at all is allowed: curl and the ICS-feed pollers send none, and they
 * are not the threat this addresses, since an attacker's lever is a browser
 * that always sends one.
 */
export function crossSiteDenied(req: Request): Response | null {
  const origin = req.headers.get("origin");
  if (!origin) return null;

  const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "")
    .split(",")[0]
    .trim();

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return fail("That request did not come from this site.", 403);
  }

  const configured = (() => {
    const explicit = (process.env.APP_URL ?? "").trim();
    if (!explicit) return null;
    try {
      return new URL(explicit).host;
    } catch {
      return null;
    }
  })();

  if (originHost === host || (configured && originHost === configured)) return null;
  return fail("That request did not come from this site.", 403);
}

export function ok<T>(data: T, status = 200) {
  return NextResponse.json<ApiResult<T>>({ ok: true, data }, { status });
}

export function fail(
  error: string,
  status = 400,
  detail?: string,
  headers?: Record<string, string>,
) {
  return NextResponse.json<ApiResult<never>>(
    detail ? { ok: false, error, detail } : { ok: false, error },
    headers ? { status, headers } : { status },
  );
}

/**
 * A 429 in the same envelope as every other failure, plus the headers a client
 * (or a well-behaved script) needs to back off intelligently instead of
 * retrying immediately and digging the hole deeper.
 */
export function rateLimited(denial: {
  message: string;
  retryAfterSeconds: number;
  resetAt: number;
}) {
  return fail(denial.message, 429, undefined, {
    "Retry-After": String(denial.retryAfterSeconds),
    "X-RateLimit-Reset": String(Math.ceil(denial.resetAt / 1000)),
  });
}

/** Turns an unknown thrown value into a message safe to show a user. */
export function messageOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "Unexpected error";
  /**
   * Redacted on the way out, because this text is not ours.
   *
   * It goes into a `detail` field on roughly ten routes and into a query
   * parameter on two OAuth callbacks, and it comes from Google, Notion, OpenAI
   * and Supabase clients, which are entitled to put whatever they like in an
   * error message. The log path has always been careful about that; this one was
   * not, and a redirect parameter is worse than a log line -- it survives in
   * browser history and in any proxy that records URLs.
   */
  return redactSecrets(raw);
}

/**
 * The origin users actually see, for building redirects.
 *
 * Behind a reverse proxy (Railway, Fly, most hosts) `req.url` is the INTERNAL
 * address -- `http://localhost:8080/...` -- so `new URL("/dashboard", req.url)`
 * sends a real user to localhost on their own machine after a successful
 * sign-in. The proxy tells us the public host in `X-Forwarded-Host`; an
 * explicit `APP_URL` wins over even that, for hosts that do not set it.
 */
export function publicOrigin(req: Request): string {
  const explicit = (process.env.APP_URL ?? "").trim().replace(/\/+$/, "");
  if (explicit) return explicit;

  /**
   * Past this point the origin is taken from a request header, which the client
   * may have chosen. That matters because two of the things built on it are
   * sensitive: the calendar feed URL, which embeds the student's live feed
   * token, and the OAuth return redirect. A forged `X-Forwarded-Host` turns the
   * feed panel's "Open in Apple Calendar" link into a subscription to someone
   * else's host, handing them a credential that reads the whole semester on
   * every poll.
   *
   * Railway overwrites the header, so this is a fallback rather than the live
   * path -- but the protection should not be "the host happens to be careful".
   * `APP_URL` is the fix and is documented in .env.example and docs/DEPLOY.md;
   * set it and this branch is never reached.
   */
  const headers = req.headers;
  // X-Forwarded-Host may carry a comma-separated chain; the first is the edge.
  const host = (headers.get("x-forwarded-host") ?? headers.get("host") ?? "")
    .split(",")[0]
    .trim();
  if (host) {
    const proto =
      headers.get("x-forwarded-proto")?.split(",")[0].trim() ||
      (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https");
    return `${proto}://${host}`;
  }
  return new URL(req.url).origin;
}

