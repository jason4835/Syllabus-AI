import { isAnalyticsEvent, track } from "@/lib/analytics";
import { crossSiteDenied, fail, ok, rateLimited } from "@/lib/api";
import { resolveVisitor } from "@/lib/demo";
import { checkLimit, describeLimit } from "@/lib/ratelimit";
import type { LogFields } from "@/lib/log";

export const dynamic = "force-dynamic";

/** The most fields one event may carry. A log line, not a payload. */
const MAX_FIELDS = 10;
/** Enough for an id or a short label; anything longer is not a funnel field. */
const MAX_VALUE_LENGTH = 120;
const MAX_KEY_LENGTH = 40;

/**
 * The funnel events only the browser can see -- a paywall shown, a checkout
 * opened -- recorded through the same logger as the server's own.
 *
 * Everything here is about not letting a client write arbitrary log lines. The
 * event NAME is an allow-list (`isAnalyticsEvent`), because a free-text name is a
 * free-text log line and a log drain is something people read and alert on. The
 * fields are capped in count, key length and value length, and anything that is
 * not a string, number or boolean is dropped rather than rejected: a client
 * sending one odd value should still have its event counted.
 *
 * `userId` is the server's, never the body's -- otherwise the one honest field in
 * the line would be the one a caller chose.
 */
export async function POST(req: Request) {
  const denied = crossSiteDenied(req);
  if (denied) return denied;

  const { userId } = await resolveVisitor();
  if (!userId) return fail("Sign in first.", 401);

  // Shares the edit budget: this route writes nothing, but it does write log
  // lines, and an unmetered one is a way to flood a drain.
  const limit = checkLimit(`user:${userId}`, "edit:user");
  if (!limit.allowed) return rateLimited(describeLimit(limit));

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return fail("Send a JSON object.", 400);
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return fail("Could not read that request.", 400);
  }

  if (!isAnalyticsEvent(body.event)) {
    return fail("Unknown event.", 422, "event must be one of the known funnel events");
  }

  track(body.event, { userId, ...flatFields(body.fields) });
  return ok({ tracked: true });
}

/** At most ten short scalars; everything else is dropped. */
function flatFields(value: unknown): LogFields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: LogFields = {};
  for (const [key, raw] of Object.entries(value)) {
    if (Object.keys(out).length >= MAX_FIELDS) break;
    if (key.length === 0 || key.length > MAX_KEY_LENGTH) continue;
    // `userId` is added by the caller above and must not be overwritten here.
    if (key === "userId") continue;
    if (typeof raw === "number" && Number.isFinite(raw)) out[key] = raw;
    else if (typeof raw === "boolean") out[key] = raw;
    else if (typeof raw === "string" && raw.length <= MAX_VALUE_LENGTH) out[key] = raw;
  }
  return out;
}
