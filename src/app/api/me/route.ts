import { fail, messageOf, ok } from "@/lib/api";
import { ensureDemoSeed } from "@/lib/demo";
import { log, logApiError } from "@/lib/log";
import { DEMO_USER_ID, destroySession, readSession } from "@/lib/session";
import { store } from "@/lib/store";
import type { User } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const userId = await readSession();
  if (!userId) return ok<User | null>(null);
  await ensureDemoSeed(userId);
  return ok<User | null>(await store.getUser(userId));
}

/** What a successful account deletion reports. See docs/API.md. */
export interface AccountDeletion {
  deleted: true;
  /**
   * Whether the "Syllabus AI" calendar was actually removed from Google.
   * False is a normal answer -- not asked for, no Google grant, nothing there,
   * or Google refused. The account is gone either way.
   */
  googleCalendarRemoved: boolean;
}

/**
 * Erases the account: every course, assessment, calendar link, Notion link and
 * the Notion connection, then the user row, then the session cookie.
 *
 * Optionally removes the "Syllabus AI" calendar from the user's Google account
 * first. Notion pages are never touched -- they are the student's own notes by
 * the time we would be deleting them (docs/NOTION.md).
 *
 * Not rate limited, on purpose. One successful call ends the account, so there
 * is no repeat to throttle; a limiter here would only add a way for the flow to
 * fail.
 */
export async function DELETE(req: Request) {
  const userId = await readSession();
  if (!userId) return fail("Sign in first.", 401);

  // In demo mode every visitor IS this account -- there is no sign-in to tell
  // them apart. Deleting it would wipe the shared demo out from under everyone
  // else currently reading it. It re-seeds on the next read, so this is rude
  // rather than fatal, which still is not a call one visitor gets to make on
  // behalf of the rest.
  if (userId === DEMO_USER_ID) {
    return fail(
      "The demo account cannot be deleted -- everyone viewing the demo shares it. Sign in with Google to manage a real account.",
      403,
    );
  }

  let confirm = "";
  let removeGoogleCalendar = false;
  try {
    const body = (await req.json()) as {
      confirm?: unknown;
      removeGoogleCalendar?: unknown;
    };
    if (typeof body?.confirm === "string") confirm = body.confirm;
    removeGoogleCalendar = body?.removeGoogleCalendar === true;
  } catch {
    return fail("Could not read that request.", 400);
  }

  // The server-side guard against an accidental call, independent of whatever
  // the UI does: a stray DELETE from a script, a link prefetcher or a
  // mis-wired button must not be able to end someone's account. Compared
  // exactly -- no trim, no case folding -- because "delete" is a plausible
  // accident and "DELETE" is not.
  if (confirm !== "DELETE") {
    return fail('Send {"confirm":"DELETE"} to delete your account.', 400);
  }

  let googleCalendarRemoved = false;
  if (removeGoogleCalendar) {
    try {
      const user = await store.getUser(userId);
      // No grant, nothing to delete -- and getAuthedClient would only throw.
      if (user?.googleRefreshToken) {
        // Imported here rather than at the top of the file so GET /api/me --
        // called on every dashboard load -- does not drag googleapis into its
        // cold start for a branch it never takes.
        const { deleteSyllabusCalendar } = await import("@/lib/google/calendar");
        // Before store.deleteUser, not after: this call authenticates with the
        // refresh token stored on the user row that is about to disappear.
        googleCalendarRemoved = await deleteSyllabusCalendar(userId);
      }
    } catch (err) {
      // Best effort by design. Google being down, a grant the user already
      // revoked, a calendar someone removed by hand -- none of those are
      // reasons to keep a person's data after they asked us to erase it. It is
      // logged and reported honestly, and the deletion carries on.
      logApiError("account.calendar_delete_failed", err, { userId });
      googleCalendarRemoved = false;
    }
  }

  try {
    const deleted = await store.deleteUser(userId);
    // A valid cookie for an id with no row: nothing to erase, but the stale
    // cookie is still worth clearing on the way out.
    if (!deleted) {
      await destroySession();
      return fail("Account not found.", 404);
    }
  } catch (err) {
    logApiError("account.delete_failed", err, { userId });
    return fail("Could not delete your account.", 500, messageOf(err));
  }

  // The cookie is signed and stateless, so it stays valid for its full 30 days
  // unless it is cleared here -- and it now names a user id that does not
  // exist.
  await destroySession();

  // The one place a user id belongs in a log line: it is about to stop
  // existing, so this is the only record that the deletion happened at all --
  // which is exactly what a "you did not delete my data" complaint needs.
  log.info("account.deleted", { userId, googleCalendarRemoved });

  return ok<AccountDeletion>({ deleted: true, googleCalendarRemoved });
}
