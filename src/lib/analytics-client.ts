/**
 * Product analytics in the browser: PostHog, deliberately kept on a short lead.
 *
 * The privacy policy makes specific promises about this, and the configuration
 * below is what keeps them rather than a note asking someone to remember:
 *
 *  - **Autocapture is off.** Autocapture records the text of whatever a user
 *    clicked. On this app that text is course codes, assignment titles and
 *    professors' names -- the syllabus content the policy says never leaves the
 *    server. Every event here is named and hand-written instead.
 *  - **Session replay is off.** Same reason, more so: a replay of this
 *    dashboard is a recording of somebody's semester.
 *  - **No email, no name.** `identify` is called with the account id and
 *    nothing else, so a funnel can tell one person from two without PostHog
 *    ever holding something that names them.
 *  - **Do Not Track and Global Privacy Control are honoured.** The policy says
 *    analytics switches off for those visitors; `shouldTrack` is where it does.
 *
 * Unconfigured is a supported state. With no `NEXT_PUBLIC_POSTHOG_KEY` every
 * function here is a no-op, which is what local dev, the demo, and any fork
 * gets -- analytics must never be the reason a page fails to work.
 */

"use client";

import posthog from "posthog-js";

let started = false;

/**
 * Whether this visitor is measured at all.
 *
 * Two signals, both browser-native. `globalPrivacyControl` is the one with legal
 * weight -- California treats it as a valid opt-out request -- and
 * `doNotTrack` is the older, broader one. Honouring both costs a small slice of
 * data and is the difference between a policy that is true and one that is not.
 */
function shouldTrack(): boolean {
  if (typeof window === "undefined") return false;
  const nav = window.navigator as Navigator & { globalPrivacyControl?: boolean };
  if (nav.globalPrivacyControl === true) return false;
  // `window.doNotTrack` is the older, non-standard spelling some browsers still
  // use; it is not in the DOM types, hence the cast rather than a lint escape.
  const legacy = (window as unknown as { doNotTrack?: string }).doNotTrack;
  if (nav.doNotTrack === "1" || legacy === "1") return false;
  return true;
}

function key(): string | null {
  return (process.env.NEXT_PUBLIC_POSTHOG_KEY ?? "").trim() || null;
}

/**
 * Starts PostHog once, if it is configured and this visitor has not opted out.
 *
 * Safe to call on every mount: React StrictMode runs effects twice in
 * development, and a second `init` would double-count every pageview.
 */
export function startAnalytics(): void {
  if (started || typeof window === "undefined") return;
  const apiKey = key();
  if (!apiKey || !shouldTrack()) return;
  started = true;

  posthog.init(apiKey, {
    api_host: (process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "").trim() || "https://us.i.posthog.com",
    // See the header: the three settings that keep syllabus content out.
    autocapture: false,
    disable_session_recording: true,
    capture_pageleave: true,
    // Anonymous visitors are counted, not profiled. A demo sandbox is a
    // throwaway account, and one person-profile per bot visit is somebody
    // else's storage bill and nobody's insight.
    person_profiles: "identified_only",
    // Pageviews are sent by hand from the provider, because the App Router
    // changes the URL without a page load and the automatic hook misses it.
    capture_pageview: false,
    // Keeps the strict Content-Security-Policy in next.config.ts strict: with
    // recording and surveys off there is nothing left to lazy-load, and asking
    // for it would mean opening the CSP for a feature deliberately disabled.
    disable_external_dependency_loading: true,
  });
}

/**
 * Ties events to an account, pseudonymously.
 *
 * The id and nothing else -- see the header. Demo sandboxes are deliberately
 * NOT identified: they are ephemeral by design, one per visitor, and promoting
 * each to a person profile would make "users" in PostHog mean something
 * different from "users" anywhere else in the product.
 */
export function identifyUser(userId: string, isDemo: boolean): void {
  if (!started || isDemo) return;
  posthog.identify(userId);
}

/**
 * Attaches this visitor's A/B assignments to every subsequent event.
 *
 * Super properties rather than per-call arguments, so splitting any funnel by
 * variant works without every call site having to remember to pass them -- and
 * so a missing property can never quietly turn an experiment's results into
 * one undifferentiated blob.
 */
export function registerExperiments(assignments: Record<string, string>): void {
  if (!started) return;
  posthog.register(assignments);
}

/** One named event. Properties must never carry syllabus or Google data. */
export function capture(event: string, properties?: Record<string, unknown>): void {
  if (!started) return;
  posthog.capture(event, properties);
}

export function capturePageview(path: string): void {
  if (!started) return;
  posthog.capture("$pageview", { $current_url: window.location.origin + path });
}

/**
 * Reports a client-side crash.
 *
 * This is the app's entire error-tracking story in the browser, and it goes to
 * PostHog rather than to the server's own log drain on purpose. `/api/analytics`
 * deliberately allow-lists event NAMES, because a free-text line from a client
 * is a free-text line in a drain that people read and alert on -- and an error
 * message is the most free-text thing there is. PostHog is built to take
 * untrusted client input, and it groups and de-duplicates, which is the
 * difference between "this crashed 400 times for one person" and "this crashed
 * for 400 people".
 *
 * A visitor who opted out of analytics reports nothing. That is the honest
 * consequence of honouring the opt-out, and a crash report carrying a stack
 * trace through somebody's dashboard is not the place to make an exception.
 *
 * Never throws. It runs inside error boundaries and global handlers, where
 * throwing would replace a handled crash with an unhandled one.
 */
export function reportError(error: unknown, context?: Record<string, unknown>): void {
  try {
    // Always to the console: a developer with the tab open should see the real
    // error, whatever analytics is or is not doing.
    console.error("[syllabus-center]", error, context);
    if (!started) return;
    posthog.captureException(
      error instanceof Error ? error : new Error(String(error)),
      context,
    );
  } catch {
    // An error reporter that fails is not an incident worth escalating into.
  }
}

/**
 * Catches what no boundary can: errors thrown outside React's render tree.
 *
 * A React error boundary sees render, lifecycle and effect errors. It does not
 * see a rejected promise in an event handler, a `setTimeout` callback, or a
 * failure inside a third-party script -- and on a dashboard whose every panel
 * fetches, those are most of what actually goes wrong in the wild.
 *
 * Idempotent, because React StrictMode runs effects twice and two listeners
 * would double every report.
 */
let globalHandlersInstalled = false;

export function installGlobalErrorHandlers(): void {
  if (globalHandlersInstalled || typeof window === "undefined") return;
  globalHandlersInstalled = true;

  window.addEventListener("error", (event) => {
    reportError(event.error ?? event.message, { kind: "uncaught", source: event.filename });
  });

  window.addEventListener("unhandledrejection", (event) => {
    reportError(event.reason, { kind: "unhandled_rejection" });
  });
}

/**
 * Forgets this browser's analytics identity. Called on sign-out and on account
 * deletion, so a shared computer does not attribute the next person's session
 * to the last person's account.
 */
export function resetAnalytics(): void {
  if (!started) return;
  posthog.reset();
}
