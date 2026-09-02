import { NextResponse } from "next/server";
import type { ApiResult } from "@/lib/types";

/**
 * Every route answers in one envelope so the client has a single shape to
 * branch on -- including failures, which still return 200-shaped JSON bodies
 * with the real status code attached.
 */
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
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "Unexpected error";
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

