import { fail, messageOf, ok, publicOrigin } from "@/lib/api";
import { logApiError } from "@/lib/log";
import { readSession } from "@/lib/session";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";

interface FeedUrls {
  url: string | null;
  webcal: string | null;
}

/**
 * Both schemes for the same address: https for clients with a "subscribe by
 * URL" box, webcal for the ones (Apple Calendar, notably) that register a
 * handler for it and open straight into the subscribe dialog.
 */
function urlsFor(req: Request, token: string | null): FeedUrls {
  if (!token) return { url: null, webcal: null };
  const https = `${publicOrigin(req)}/api/feed/${token}.ics`;
  return { url: https, webcal: https.replace(/^https?:/, "webcal:") };
}

export async function GET(req: Request) {
  const userId = await readSession();
  if (!userId) return fail("Sign in first.", 401);
  try {
    const user = await store.getUser(userId);
    return ok<FeedUrls>(urlsFor(req, user?.calendarFeedToken ?? null));
  } catch (err) {
    logApiError("feed.lookup_failed", err, { userId });
    return fail("Could not load your feed link.", 500, messageOf(err));
  }
}

export async function POST(req: Request) {
  const userId = await readSession();
  if (!userId) return fail("Sign in first.", 401);

  let reset = false;
  try {
    const body = (await req.json().catch(() => ({}))) as { reset?: unknown };
    reset = body?.reset === true;
  } catch {
    // An empty body is the common case.
  }

  try {
    const token = reset
      ? await store.resetCalendarFeedToken(userId)
      : await store.ensureCalendarFeedToken(userId);
    if (!token) return fail("Account not found.", 404);
    // The token is a secret; the response carries it inside a URL the user
    // asked for, and nothing about it reaches the logs.
    return ok<FeedUrls>(urlsFor(req, token));
  } catch (err) {
    logApiError("feed.token_failed", err, { userId, reset });
    return fail("Could not create your feed link.", 500, messageOf(err));
  }
}
