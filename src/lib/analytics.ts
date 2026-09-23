/**
 * Funnel events, sent two places at once.
 *
 * Every `track()` call writes a structured `analytics.<name>` log line AND, when
 * PostHog is configured, posts the same event to PostHog. The log line is the
 * durable record that lives in your own drain and survives any vendor; PostHog
 * is what turns a pile of lines into a funnel and a retention curve without
 * anybody writing SQL. Call sites know about neither.
 *
 * `track()` is the SERVER half. Its counterpart in the browser is
 * `trackEvent()` in `@/components/api-client`, which posts here through
 * `/api/analytics` and captures to PostHog directly. Both end up as the same
 * event name against the same `distinct_id`, so a funnel can cross the boundary
 * -- "saw the paywall" is a client moment and "paid" is a webhook moment, and
 * measuring conversion means joining them.
 *
 * Names are an allow-list, because the client can post one (`POST
 * /api/analytics`) and a free-text event name is a free-text log line.
 *
 * NOTHING HERE MAY CARRY SYLLABUS CONTENT, Google data, or a student's name or
 * email. Ids, counts, variants and enum-ish labels only -- that restriction is
 * what the privacy policy promises and what keeps the app inside Google's
 * Limited Use requirements.
 */
import { log, type LogFields } from "@/lib/log";

export const ANALYTICS_EVENTS = [
  // --- Acquisition -------------------------------------------------------
  /** A visitor with no cookie was handed a sandbox. The top of the funnel. */
  "demo_started",
  /** Landing page call-to-action clicked, whichever hero variant was shown. */
  "landing_cta_clicked",
  /** Google sign-in completed. The conversion the landing page is judged on. */
  "signed_in",
  /** The one-time onboarding card answered or skipped. Carries school/year/source labels. */
  "onboarding_completed",

  // --- Activation --------------------------------------------------------
  "term_created",
  /** A syllabus was parsed and saved. The moment the product has done its job. */
  "syllabus_uploaded",
  "first_course_created",
  /** Deadlines reached a real calendar -- the strongest retention signal here. */
  "calendar_synced",
  "notion_connected",

  // --- Revenue -----------------------------------------------------------
  "second_course_paywall_viewed",
  "term_checkout_started",
  "term_pass_purchased",
  "term_checkout_abandoned",
] as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

export function isAnalyticsEvent(value: unknown): value is AnalyticsEvent {
  return typeof value === "string" && (ANALYTICS_EVENTS as readonly string[]).includes(value);
}

/**
 * The PostHog project key.
 *
 * `NEXT_PUBLIC_` because the same key is used by the browser, and a PostHog
 * project key is designed to be public -- it can write events and read nothing.
 * Sharing it means the server and the client cannot drift onto two projects.
 */
function posthogKey(): string | null {
  return (process.env.NEXT_PUBLIC_POSTHOG_KEY ?? "").trim() || null;
}

function posthogHost(): string {
  return (
    (process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "").trim() || "https://us.i.posthog.com"
  ).replace(/\/+$/, "");
}

/**
 * Posts one event to PostHog's capture endpoint.
 *
 * A `fetch` rather than `posthog-node`, because this is the entire surface the
 * server needs and a dependency for one POST is a dependency to keep updated
 * for one POST.
 *
 * Deliberately never throws and never rejects. It runs inside the Stripe
 * webhook, where an unhandled rejection would fail the delivery and make Stripe
 * retry a payment that was already granted -- an analytics outage must not
 * become a billing incident. Two seconds is the whole budget; past that the
 * event is dropped and the log line, which already landed, is the record.
 */
function captureToPostHog(event: AnalyticsEvent, fields: LogFields): void {
  const apiKey = posthogKey();
  const distinctId = fields.userId;
  if (!apiKey || typeof distinctId !== "string" || !distinctId) return;

  const { userId: _userId, ...properties } = fields;

  void fetch(`${posthogHost()}/capture/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      event,
      distinct_id: distinctId,
      properties: { ...properties, $lib: "syllabus-center-server" },
      timestamp: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(2000),
  }).catch((err: unknown) => {
    // One line, at debug: a PostHog blip is not an incident, and a warn here
    // would page somebody for a dropped funnel event during a Stripe outage.
    log.debug("analytics.posthog_failed", {
      event,
      reason: err instanceof Error ? err.name : "unknown",
    });
  });
}

export function track(event: AnalyticsEvent, fields: LogFields = {}): void {
  log.info(`analytics.${event}`, fields);
  captureToPostHog(event, fields);
}
