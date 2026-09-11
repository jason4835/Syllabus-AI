import { NextResponse } from "next/server";

import { resolveSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Mints a visitor's sandbox, then sends them where they were going.
 *
 * This exists because of where cookies can be set. A visitor with no cookie has
 * no sandbox, and every route creates one when it does not find one -- so the
 * dashboard's own fetches used to race each other, mint several sandboxes, seed
 * several sample semesters, and keep whichever one won the right to set the
 * cookie. `/api/courses` then answered from one sandbox while `/api/plan`
 * answered from another, and the heatmap told a brand-new visitor that nothing
 * was due all term.
 *
 * Serializing the dashboard's own fetches is not a fix, only a narrowing: any
 * panel that later fetches on mount re-opens the race, and one already did.
 * The reliable place to settle it is before any client code runs at all -- but
 * a server component cannot set a cookie, and middleware here would have to
 * sign sessions on the Edge runtime, which `node:crypto` rules out. A route
 * handler can set cookies, so the page bounces a cookieless visitor through
 * this one and the cookie exists before the first fetch is made.
 *
 * Costs one redirect, on a first visit only.
 */
export async function GET(req: Request) {
  await resolveSession();

  const requested = new URL(req.url).searchParams.get("next");
  return NextResponse.redirect(new URL(safeNext(requested), req.url), {
    // 303: the browser must GET the destination, and this answer is specific to
    // one visitor's brand-new cookie -- it must never be cached or replayed.
    status: 303,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Only a path on this site, never a URL someone else chose.
 *
 * A redirect target taken from a query parameter is an open redirect unless it
 * is checked, and this one is reachable by anyone. Rejected: absolute URLs
 * ("https://evil.example"), protocol-relative paths ("//evil.example", which a
 * browser reads as a host), and backslashes, which some clients normalise to
 * forward slashes and which would smuggle a host past a naive check.
 */
function safeNext(value: string | null): string {
  if (!value || !value.startsWith("/")) return "/dashboard";
  if (value.startsWith("//") || value.includes("\\")) return "/dashboard";
  return value;
}
