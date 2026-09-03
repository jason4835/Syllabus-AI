import { fail, messageOf, ok } from "@/lib/api";
import { logApiError } from "@/lib/log";
import { readSession } from "@/lib/session";
import { store } from "@/lib/store";
import type { CalendarPrefs } from "@/lib/types";
import { DEFAULT_CALENDAR_PREFS } from "@/lib/types";

export const dynamic = "force-dynamic";

const KEYS = Object.keys(DEFAULT_CALENDAR_PREFS) as (keyof CalendarPrefs)[];

/**
 * What the Google sync and the feed include. Persisted so a choice made once
 * holds for every later sync -- and so the feed, which has no UI at fetch
 * time, can honour it too.
 */
export async function PATCH(req: Request) {
  const userId = await readSession();
  if (!userId) return fail("Sign in first.", 401);

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail("Send a JSON object.", 400);
    body = parsed as Record<string, unknown>;
  } catch {
    return fail("Could not read that request.", 400);
  }

  const patch: Partial<CalendarPrefs> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!KEYS.includes(key as keyof CalendarPrefs)) return fail("Invalid change.", 422, `${key} is not a calendar preference`);
    if (typeof value !== "boolean") return fail("Invalid change.", 422, `${key} must be true or false`);
    patch[key as keyof CalendarPrefs] = value;
  }
  if (Object.keys(patch).length === 0) return fail("Invalid change.", 422, "nothing to change");

  try {
    const user = await store.setCalendarPrefs(userId, patch);
    if (!user) return fail("Account not found.", 404);
    return ok<CalendarPrefs>(user.calendarPrefs);
  } catch (err) {
    logApiError("calendar_prefs.update_failed", err, { userId });
    return fail("Could not save your calendar preferences.", 500, messageOf(err));
  }
}
