"use client";

import { useEffect } from "react";

import {
  capturePageview,
  installGlobalErrorHandlers,
  registerExperiments,
  startAnalytics,
} from "@/lib/analytics-client";
import { trackEvent } from "@/components/api-client";

/**
 * Measures the landing page: one pageview, and every click on a way in.
 *
 * Renders nothing. It exists because the page around it is a server component
 * and analytics is a browser concern -- keeping it in one leaf means the page
 * itself stays declarative and there is a single place to look when a number
 * seems wrong.
 *
 * CTA clicks are caught by DELEGATION on the document rather than by a handler
 * on each button. Two reasons, and the second is the real one: the buttons are
 * plain `<a>`s rendered by a shared `LinkButton`, so per-button tracking would
 * mean threading a prop through a component every other page uses; and a
 * delegated listener cannot be forgotten when somebody adds a fourth call to
 * action, which is exactly how funnel data quietly starts under-counting.
 *
 * The destination is the label. `/dashboard` is "try it", `/api/auth/google` is
 * "sign in" -- the two intents the page is testing, wherever on it they were
 * clicked from.
 */
export function LandingAnalytics({ variant }: { variant: string }) {
  useEffect(() => {
    startAnalytics();
    installGlobalErrorHandlers();
    // Registered before the pageview, so the pageview itself carries the arm.
    // A pageview without it is a visit that cannot be attributed to a variant,
    // and those are the denominator of the whole test.
    registerExperiments({ landing_hero: variant });
    capturePageview("/");
  }, [variant]);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      const link = target?.closest?.("a");
      if (!link) return;

      const href = link.getAttribute("href") ?? "";
      const intent = href.startsWith("/api/auth/google")
        ? "sign_in"
        : href.startsWith("/dashboard")
          ? "try_demo"
          : null;
      if (!intent) return;

      // Fired without waiting: the browser is about to navigate, and both
      // transports (the API post and PostHog's own) are designed to survive
      // that -- PostHog falls back to a beacon on pagehide.
      trackEvent("landing_cta_clicked", { intent, variant });
    }

    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [variant]);

  return null;
}
