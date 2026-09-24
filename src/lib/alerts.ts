/**
 * Email alerts for the things nobody would otherwise see.
 *
 * Every failure in this app is already logged, in a structured, greppable,
 * secret-redacted line. That is the right thing to have and it solves a
 * different problem: a log drain answers questions you have already thought to
 * ask, *after* somebody complains. `stripe.webhook_grant_missed` -- a student
 * paid and did not get access -- is logged perfectly and will be read by nobody,
 * because nobody sits watching a log drain.
 *
 * So: a small number of events push, rather than waiting to be pulled.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not a monitoring product, and deliberately not on the path to becoming one.
 * There are no dashboards, no escalation, no acknowledgement, no on-call. It
 * sends an email when something happens that a person should act on, at most
 * once an hour per kind, and stops there. If this deployment ever needs
 * severity routing or paging, that is a vendor's job and this file is the seam
 * to replace -- `sendAlert` is the only thing that talks to a provider.
 *
 * Unconfigured is a supported state: with no `RESEND_API_KEY` and
 * `ALERT_EMAIL_TO`, nothing here does anything and the logs are unchanged.
 *
 * Server-only. Never imports `@/lib/log` -- see `note` below.
 */

import { checkLimit } from "@/lib/ratelimit";

/**
 * Events that page a human even though they are only `warn`.
 *
 * Alerting on `error` level alone would miss every one of these, which is the
 * reason this list exists rather than a simple severity threshold. They are all
 * money: the webhook ran, did not throw, and decided not to grant something --
 * which from the student's side is indistinguishable from the payment failing,
 * except that they have been charged.
 *
 * The value is what to DO about it. An alert that names a problem without
 * naming the next step is a notification, not an alert, and at 3am the
 * difference matters.
 */
const CRITICAL_WARNINGS: Record<string, string> = {
  "stripe.webhook_grant_missed":
    "A payment succeeded but premium was NOT granted. Find the term by the ids below and grant it by hand, then work out why the write failed. The student has been charged and has nothing to show for it.",
  "stripe.webhook_term_not_found":
    "A paid Checkout Session names a term that does not exist, or does not belong to the user in its metadata. Either a term was deleted between checkout and payment, or someone is replaying sessions. Check before refunding.",
  "stripe.webhook_term_without_end_date":
    "A term was paid for but has no end date, so its expiry cannot be computed and premium was not granted. Set the dates with the student, then grant it.",
  "stripe.webhook_missing_metadata":
    "A Checkout Session arrived without the user/term metadata the grant is keyed on. Nothing was granted. If this is a real purchase it has to be resolved by hand from the Stripe Dashboard.",
  "stripe.webhook_unverified":
    "A request to the Stripe webhook failed signature verification. One or two is internet noise; a stream of them means STRIPE_WEBHOOK_SECRET is wrong -- in which case every real payment is being rejected too, and nobody is getting access.",
};

function configured(): { apiKey: string; to: string; from: string } | null {
  const apiKey = (process.env.RESEND_API_KEY ?? "").trim();
  const to = (process.env.ALERT_EMAIL_TO ?? "").trim();
  if (!apiKey || !to) return null;
  return {
    apiKey,
    to,
    // Must be on a domain verified with the provider, or the send is rejected.
    from: (process.env.ALERT_EMAIL_FROM ?? "").trim() || "alerts@syllabuscenter.com",
  };
}

/**
 * This module's own failures go to `console`, never to `log`.
 *
 * `log.emit` is what calls this, so a `log.warn` in here would be a logger that
 * calls the alerter that calls the logger. On a bad day -- the alert provider
 * down while the app is erroring -- that is an unbounded loop inside a catch
 * block, which is a far worse outage than the missing email it was reporting.
 */
function note(message: string, detail?: unknown): void {
  try {
    console.warn(`[alerts] ${message}`, detail ?? "");
  } catch {
    /* nothing left to try */
  }
}

/**
 * Should this line become an email?
 *
 * Exported for the tests, because the decision is the part worth pinning down:
 * everything else here is a POST.
 */
export function shouldAlert(level: string, event: string): boolean {
  if (level === "error") return true;
  return level === "warn" && event in CRITICAL_WARNINGS;
}

/**
 * The hook `log.emit` calls on every line. Cheap and silent for almost all of
 * them: one string comparison for `info` and `debug`, which is everything the
 * app logs in normal operation.
 *
 * `fields` arrive ALREADY REDACTED -- `emit` redacts before calling this, so
 * this function never has to know what a secret looks like, and cannot be the
 * place one leaks.
 *
 * Fire and forget. Nothing awaits it, it never throws, and it is called from
 * inside catch blocks where a rejection would replace a handled error with an
 * unhandled one.
 */
export function maybeAlert(
  level: string,
  event: string,
  fields: Record<string, unknown>,
): void {
  try {
    if (!shouldAlert(level, event)) return;
    // Vitest sets this. A test suite that emails the operator on every expected
    // error is a test suite nobody runs twice.
    if (process.env.NODE_ENV === "test") return;

    const config = configured();
    if (!config) return;

    // Keyed by event NAME, so a hundred failures of one route are one email and
    // a second, different failure still gets through.
    const verdict = checkLimit(`alert:${event}`, "alert:email");
    if (!verdict.allowed) return;

    void send(config, level, event, fields);
  } catch (err) {
    note("could not evaluate alert", err);
  }
}

/** What the provider said. Returned to the test button, logged everywhere else. */
export interface DeliveryResult {
  ok: boolean;
  /** HTTP status, or 0 when the request never completed. */
  status: number;
  /** The provider's own words on failure -- the part worth reading. */
  detail: string | null;
}

async function send(
  config: { apiKey: string; to: string; from: string },
  level: string,
  event: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const result = await deliver(config, level, event, fields);
  if (!result.ok) {
    note(`provider rejected the alert for "${event}" (${result.status}): ${result.detail ?? ""}`);
  }
}

/**
 * Whether alerting is switched on at all. A boolean for `/api/health`; the
 * values are never reported.
 */
export function isAlertingConfigured(): boolean {
  return configured() !== null;
}

/**
 * One real email, right now, past the throttle -- for the operator to prove
 * the wiring works without waiting for something to break.
 *
 * Returns the provider's answer rather than swallowing it, because the whole
 * point is to see WHY nothing arrived: an unverified sending domain, a wrong
 * key, a typo in the address. Only ever called from the admin-gated route.
 */
export async function sendTestAlert(): Promise<DeliveryResult> {
  const config = configured();
  if (!config) {
    return {
      ok: false,
      status: 0,
      detail: "Not configured: RESEND_API_KEY and ALERT_EMAIL_TO must both be set in this environment.",
    };
  }
  return deliver(config, "info", "alerts.test", {
    note: "Sent from the /admin page to confirm alert email is working. Nothing is wrong.",
  });
}

async function deliver(
  config: { apiKey: string; to: string; from: string },
  level: string,
  event: string,
  fields: Record<string, unknown>,
): Promise<DeliveryResult> {
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: config.from,
        // Comma-separated in the env, an array on the wire.
        to: config.to.split(",").map((address) => address.trim()).filter(Boolean),
        // The event name is the whole subject, unprefixed after the tag, so the
        // inbox can be filtered and threaded on it without opening anything.
        subject: `[Syllabus Center] ${event}`,
        text: body(level, event, fields),
      }),
      // Short: this runs inside a request that has already failed, and on
      // serverless the instance may be frozen the moment that request returns.
      signal: AbortSignal.timeout(5000),
    });

    if (response.ok) return { ok: true, status: response.status, detail: null };
    // Resend answers a rejection with JSON naming the reason -- "domain is not
    // verified", "invalid API key" -- and that sentence is the diagnosis.
    let detail: string | null = null;
    try {
      const body = (await response.json()) as { message?: unknown; name?: unknown };
      detail = [body.name, body.message].filter((v) => typeof v === "string").join(": ") || null;
    } catch {
      detail = null;
    }
    return { ok: false, status: response.status, detail };
  } catch (err) {
    // Never thrown. An alert that cannot be delivered is bad; an alert that
    // takes down the request it was reporting on is worse.
    return { ok: false, status: 0, detail: err instanceof Error ? err.message : "network failure" };
  }
}

/** Plain text, not HTML: this is read on a phone, at speed, possibly at 3am. */
function body(level: string, event: string, fields: Record<string, unknown>): string {
  const lines = [
    `${level.toUpperCase()}  ${event}`,
    new Date().toISOString(),
    "",
  ];

  const hint = CRITICAL_WARNINGS[event];
  if (hint) lines.push(hint, "");

  lines.push("Details");
  lines.push("-------");
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: ${format(value)}`);
  }

  lines.push(
    "",
    "Only the first of these per hour is emailed, and at most 20 alerts an hour",
    "in total. Search the logs for the event name above to see the rest.",
  );
  return lines.join("\n");
}

const MAX_VALUE_CHARS = 800;

function format(value: unknown): string {
  if (typeof value === "string") return truncate(value);
  // A normalised Error: the stack is the reason anyone opened the email.
  if (value && typeof value === "object" && "stack" in value) {
    return truncate(String((value as { stack: unknown }).stack));
  }
  try {
    return truncate(JSON.stringify(value) ?? String(value));
  } catch {
    return "[unserializable]";
  }
}

function truncate(value: string): string {
  return value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}…` : value;
}
