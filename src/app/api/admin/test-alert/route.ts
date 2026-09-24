import { sendTestAlert } from "@/lib/alerts";
import { crossSiteDenied, fail, ok } from "@/lib/api";
import { isAdminEmail } from "@/lib/metrics";
import { checkLimit, describeLimit } from "@/lib/ratelimit";
import { rateLimited } from "@/lib/api";
import { requireUserId } from "@/lib/session";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Sends one real alert email and returns exactly what the provider said.
 *
 * Exists because "no email has ever arrived" has three different causes that
 * look identical from an inbox -- not configured, wrong key, unverified
 * sending domain -- and the provider names which one in its response. The
 * throttle is bypassed (this is not an alert, it is a test of alerts), and
 * the edit budget stops a script from turning it into a spam gun.
 *
 * 404 rather than 403 for a non-admin, matching `/admin`: the route does not
 * confirm its own existence.
 */
export async function POST(req: Request) {
  const denied = crossSiteDenied(req);
  if (denied) return denied;

  const userId = await requireUserId();
  const user = userId ? await store.getUser(userId) : null;
  if (!isAdminEmail(user?.email)) return fail("Not found.", 404);

  const limit = checkLimit(`user:${userId}`, "edit:user");
  if (!limit.allowed) return rateLimited(describeLimit(limit));

  return ok(await sendTestAlert());
}
