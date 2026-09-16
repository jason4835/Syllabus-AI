/**
 * Funnel events for the Term Pass, as structured log lines.
 *
 * There is no analytics vendor in this app and this feature does not add one.
 * Every event is one `analytics.<name>` line through the same logger the rest
 * of the server uses, which the log drain already collects; wiring a vendor
 * later means changing `track`, not the call sites.
 *
 * Names are an allow-list, because the client can post one (`POST
 * /api/analytics`) and a free-text event name is a free-text log line.
 */
import { log, type LogFields } from "@/lib/log";

export const ANALYTICS_EVENTS = [
  "term_created",
  "first_course_created",
  "second_course_paywall_viewed",
  "term_checkout_started",
  "term_pass_purchased",
  "term_checkout_abandoned",
] as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

export function isAnalyticsEvent(value: unknown): value is AnalyticsEvent {
  return typeof value === "string" && (ANALYTICS_EVENTS as readonly string[]).includes(value);
}

export function track(event: AnalyticsEvent, fields: LogFields = {}): void {
  log.info(`analytics.${event}`, fields);
}
