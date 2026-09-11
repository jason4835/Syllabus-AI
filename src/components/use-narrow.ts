"use client";

import { useEffect, useState } from "react";

/**
 * Tailwind's `lg` breakpoint, as a number the JS side can ask about.
 *
 * Kept beside the hook rather than imported from anywhere: it has to match the
 * `lg:` prefixes in the markup, and a second source for it would drift.
 */
const LG = 1024;

/**
 * True while the viewport is narrower than `lg`.
 *
 * For the handful of decisions CSS cannot express. A `hidden lg:block` can show
 * or hide a list, but it cannot tell a button what `aria-expanded` to claim, and
 * a control that says "Hide" over content CSS has already hidden is worse than
 * the layout problem it was solving.
 *
 * Starts `false` so the server and the first client render agree. That is not a
 * guess that everyone is on a desktop: the panels using it render their content
 * only after an async fetch, so the real value has always arrived by the time
 * anything depends on it.
 */
export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${LG - 1}px)`);
    setNarrow(query.matches);
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return narrow;
}
