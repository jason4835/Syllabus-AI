"use client";

import { useEffect } from "react";

import { reportError } from "@/lib/analytics-client";

/**
 * The last net: an error in the ROOT layout itself.
 *
 * `error.tsx` renders inside the root layout, so it cannot catch a failure of
 * that layout -- this replaces the whole document instead, which is why it has
 * to supply its own `<html>` and `<body>`. Next requires that, and it is also
 * the reason the styles here are inline: `globals.css` is imported by the root
 * layout, and this file exists precisely for the case where the root layout did
 * not render.
 *
 * It should essentially never be seen. Being unreachable is not the same as
 * being unnecessary -- without it, a root-layout crash is a blank white page
 * with no report and no way back.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportError(error, { boundary: "global", digest: error.digest });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          padding: "1.5rem",
          textAlign: "center",
          background: "#faf8f3",
          color: "#1b1a16",
          font: "16px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif",
        }}
      >
        <div>
          <h1 style={{ fontSize: "1.5rem", fontWeight: 600, margin: "0 0 0.75rem" }}>
            Syllabus Center could not load.
          </h1>
          <p style={{ margin: "0 0 1.5rem", color: "#6d6860", maxWidth: "28rem" }}>
            Your data is safe. Reload the page, or come back in a minute.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              font: "inherit",
              fontWeight: 500,
              cursor: "pointer",
              border: 0,
              borderRadius: "0.5rem",
              padding: "0.7rem 1.25rem",
              background: "#1e5f4e",
              color: "#fff",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
