import { fail, messageOf, ok } from "@/lib/api";
import { logApiError } from "@/lib/log";
import { readSession } from "@/lib/session";
import { store } from "@/lib/store";
import type { User } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Rejects anything that is not a plausible IANA zone before it reaches the
 * store -- this value is echoed straight into Google Calendar event payloads,
 * so it must not be attacker-shaped free text.
 */
function isValidTimezone(value: string): boolean {
  if (value.length > 64 || !/^[A-Za-z0-9+_\-]+(\/[A-Za-z0-9+_\-]+)*$/.test(value)) return false;
  try {
    // The runtime's own tz database is the only authority worth trusting here.
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * The browser reports its zone; the server stores it.
 *
 * Calendar events are floating local datetimes, so the zone decides what
 * "23:59" means. Taking it from the server put every user's deadlines in the
 * host's zone -- 23:59 in New York became 19:59 on a UTC box.
 */
export async function POST(req: Request) {
  const userId = await readSession();
  if (!userId) return fail("Sign in first.", 401);

  let timezone = "";
  try {
    const body = (await req.json()) as { timezone?: unknown };
    if (typeof body?.timezone === "string") timezone = body.timezone.trim();
  } catch {
    return fail("Could not read that request.", 400);
  }

  if (!timezone) return fail("No timezone provided.", 400);
  if (!isValidTimezone(timezone)) return fail("That is not a recognized IANA timezone.", 422);

  try {
    const user = await store.setUserTimezone(userId, timezone);
    if (!user) return fail("Account not found.", 404);
    return ok<User>(user);
  } catch (err) {
    logApiError("me.timezone_failed", err, { userId, timezone });
    return fail("Could not save your timezone.", 500, messageOf(err));
  }
}
