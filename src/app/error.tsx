"use client";

import { useEffect } from "react";

import { reportError } from "@/lib/analytics-client";
import { Logo } from "@/components/icons";
import { LinkButton } from "@/components/ui/button";

/**
 * The outer net: a render error anywhere below the root layout.
 *
 * `PanelBoundary` catches the common case -- one dashboard panel failing while
 * the rest of the page is fine -- and this catches what gets past it: an error
 * in the shell itself, in a page component, or in a layout below the root.
 *
 * Deliberately plain and deliberately dependency-free in what it renders. A
 * fallback that needs the data layer, the config fetch, or anything else that
 * might be the thing that just broke is a fallback that can fail too.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // `digest` is the only handle on the server-side stack: Next replaces a
    // server error's real message with a generic one in production and prints
    // the full trace to the server log under this id. Without it, matching a
    // user's report to a log line is guesswork.
    reportError(error, { boundary: "app", digest: error.digest });
  }, [error]);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-paper px-6 text-center">
      <Logo />
      <div>
        <h1 className="font-serif text-[1.75rem] leading-tight font-semibold text-ink">
          Something broke on our end.
        </h1>
        <p className="mx-auto mt-3 max-w-md text-[0.9375rem] leading-relaxed text-muted">
          Your courses and deadlines are safe &mdash; this is a display problem,
          not a data one. Try again, and if it keeps happening the error has
          already been reported.
        </p>
        {error.digest ? (
          <p className="mt-3 font-mono text-[0.75rem] text-muted">
            Reference: {error.digest}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-[0.9375rem] font-medium text-accent-on shadow-card transition-[background-color,transform] duration-150 not-disabled:active:scale-[0.97] hover:bg-accent-hover"
        >
          Try again
        </button>
        <LinkButton href="/dashboard" variant="secondary" size="lg">
          Back to dashboard
        </LinkButton>
      </div>
    </div>
  );
}
