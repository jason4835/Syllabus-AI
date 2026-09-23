import { NextResponse } from "next/server";
import type { ApiResult } from "@/lib/types";
import { isDemoUser } from "@/lib/types";
import { redactSecrets } from "@/lib/log";
import { checkLimit, type LimitVerdict } from "@/lib/ratelimit";

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

/**
 * The network-level budget for a visitor who has not signed in, or null when
 * the rule does not apply.
 *
 * Call this on every route that spends money on a visitor's behalf, IN ADDITION
 * to the per-user check. The reason is in the `demo:ip` rule itself: a demo
 * sandbox is free to mint, so a per-user cap on one is a cap on nothing -- drop
 * the cookie, get a fresh allowance. This is the meter that a new cookie does
 * not reset.
 *
 * Returns null, meaning "not metered", in two cases. A signed-in user is
 * metered by their user id, which is strictly better. And a request whose IP
 * this host cannot determine is let through to the per-user and global rules
 * rather than denied, because the alternative -- a hosting change quietly
 * removing a header and every visitor being refused -- is a worse outage than
 * the abuse it would prevent.
 *
 * A caller that can degrade instead of failing should: `/api/chat` answers from
 * its deterministic answerer, which is a better experience than a 429 and costs
 * nothing. A caller that cannot degrade honestly should deny and offer sign-in.
 */
export function demoSpendVerdict(req: Request, userId: string): LimitVerdict | null {
  if (!isDemoUser(userId)) return null;
  const ip = clientIp(req);
  if (!ip) return null;
  return checkLimit(`ip:${ip}`, "demo:ip");
}

/**
 * The 429 for a demo visitor who has used up the trial, worded as the invitation
 * it actually is.
 *
 * Deliberately NOT `rateLimited()`. That one says "come back in N seconds",
 * which is the right answer when a signed-in user is going too fast and the
 * wrong one here: the visitor is not doing anything wrong, they are at the end
 * of a free trial, and the thing they should do is sign in -- which takes one
 * click and lifts the limit immediately. `errorCode` lets the client show a
 * Google button instead of a stopwatch.
 */
export function demoBudgetSpent(what: string) {
  return NextResponse.json(
    {
      ok: false as const,
      error: `You have used up the free ${what} for this network.`,
      detail:
        "Signing in with Google lifts this limit right away, and it is free.",
      // Same key the checkout route uses for the same purpose, read by
      // `errorCodeOf` in the client: the UI shows a Google button, not a clock.
      code: "sign_in_required",
    },
    { status: 429 },
  );
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
/**
 * The caller's IP, as well as this host can know it, or null.
 *
 * Used for ONE thing: metering visitors who have no account yet (see
 * `demo:ip` in `@/lib/ratelimit`). A signed-in user is metered by user id,
 * which is better in every way -- an IP is shared by a whole dorm behind campus
 * NAT and is trivially rotated by anyone who cares.
 *
 * Header order matters. `x-forwarded-for` is a comma-separated chain that the
 * CLIENT writes the first entry of, so reading it naively lets anyone claim any
 * address and mint themselves an unlimited budget. Vercel's `x-real-ip` and
 * Cloudflare's `cf-connecting-ip` are set by the edge and cannot be forged from
 * outside, so they are preferred; the chain is the last resort, and then its
 * LAST entry is taken, which is the hop nearest this server rather than the one
 * the client authored.
 *
 * Null when nothing is available (local dev, a host that sets no headers). A
 * null IP is not metered -- the caller decides what that means, and for demo
 * budgets it means "fall back to the global backstop" rather than "deny", since
 * denying everyone is how a header change takes the whole site down.
 */
export function clientIp(req: Request): string | null {
  const h = req.headers;
  for (const name of ["cf-connecting-ip", "x-real-ip", "x-vercel-forwarded-for"]) {
    const value = h.get(name)?.trim();
    if (value) return value;
  }
  const chain = h.get("x-forwarded-for");
  if (!chain) return null;
  const hops = chain.split(",").map((hop) => hop.trim()).filter(Boolean);
  // Last hop: the one this server's proxy appended, not the one the client
  // wrote. Wrong only if there are proxies in front we do not know about, and
  // wrong in the safe direction -- it over-groups rather than under-groups.
  return hops.length > 0 ? hops[hops.length - 1] : null;
}

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

