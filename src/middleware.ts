import { NextResponse, type NextRequest } from "next/server";

/**
 * Gives an anonymous visitor a stable id, and does nothing else.
 *
 * The landing page A/B test needs to put the same person in the same arm on
 * every visit, and a server component cannot set a cookie -- which is the same
 * constraint `/api/session/start` exists to work around for the dashboard. The
 * difference is that the dashboard's answer is a full sandbox ACCOUNT: a signed
 * session, a `users` row, a term and three seeded sample courses. That is the
 * right price for someone who has decided to try the product and far too much
 * for someone who has not finished reading the headline -- especially once an
 * ad campaign is pointing traffic here and a large share of it is crawlers.
 *
 * So the landing page gets the cheap half: one random value, no signature, no
 * database row, no account.
 *
 * NOT A CREDENTIAL, and deliberately not signed. It grants nothing, identifies
 * nobody, and the worst a forged one can do is move the forger between two arms
 * of a copy test. That is also why this can run on the Edge runtime at all --
 * signing would need `node:crypto`, which Edge does not have, and which is
 * exactly why sessions are minted in a route handler instead.
 *
 * `httpOnly` even so: nothing in the browser needs to read it, and a cookie
 * script cannot touch is one fewer thing for a future XSS to work with.
 */
export const VISITOR_COOKIE_NAME = "sylb_vid";

/** A year: long enough that a returning visitor stays in the arm they were in. */
const VISITOR_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function middleware(req: NextRequest) {
  const response = NextResponse.next();
  if (req.cookies.get(VISITOR_COOKIE_NAME)?.value) return response;

  response.cookies.set(VISITOR_COOKIE_NAME, crypto.randomUUID(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: VISITOR_MAX_AGE_SECONDS,
  });
  return response;
}

/**
 * The landing page and nothing else.
 *
 * Every other route either has a real session already or does not care, and a
 * middleware that ran on `/api/*` would add latency to the calendar feed --
 * which is polled by every subscriber's calendar app, several times a day, and
 * has no use for a bucketing id.
 */
export const config = { matcher: ["/"] };
