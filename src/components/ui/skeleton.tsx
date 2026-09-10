import type { ReactNode } from "react";

export function SkeletonLine({ width = "100%" }: { width?: string }) {
  return <span className="skeleton block h-3" style={{ width }} />;
}

export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  const widths = ["92%", "76%", "84%", "68%", "88%"];
  return (
    <div aria-hidden="true" className="space-y-3.5">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3">
          <span className="skeleton h-9 w-9 shrink-0 rounded-md" />
          <div className="min-w-0 flex-1 space-y-2">
            <SkeletonLine width={widths[index % widths.length]} />
            <SkeletonLine width="42%" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Stands in for the whole heatmap, not just its bars.
 *
 * The panel that replaces this is the strip *plus* a legend *plus* the
 * week-detail card, so a bars-only skeleton let everything below it jump
 * several hundred pixels when the plan arrived. Each block below mirrors the
 * real one's box model, so the reserved height lands within a row's height of
 * what loads.
 */
export function SkeletonStrip() {
  return (
    <div aria-hidden="true" className="space-y-4">
      <div className="flex gap-1.5">
        {Array.from({ length: 12 }, (_, index) => (
          <div key={index} className="flex flex-1 flex-col items-center gap-1 p-1">
            <span
              className="skeleton h-24 w-full rounded-md sm:h-28"
              style={{ animationDelay: `${index * 60}ms` }}
            />
            <span className="skeleton h-[0.6875rem] w-3 rounded-sm" />
            <span className="skeleton h-[0.625rem] w-4 rounded-sm" />
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-3">
        {["3.5rem", "2.5rem", "3rem", "3.25rem", "3.5rem", "4.5rem"].map(
          (width, index) => (
            <span
              key={index}
              className="skeleton h-4 rounded-sm"
              style={{ width }}
            />
          ),
        )}
      </div>

      {/* Week detail */}
      <div className="rounded-lg border border-line bg-sunken/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <span className="skeleton h-5 w-40 rounded-sm" />
          <span className="skeleton h-4 w-44 rounded-sm" />
        </div>
        {/* Three assessment rows, built like the real ones (accent bar, three
            text lines) rather than reusing SkeletonRows, whose two-line row is
            a third shorter than what actually lands here. */}
        <div className="mt-1 divide-y divide-line">
          {["78%", "64%", "71%"].map((width, index) => (
            <div key={index} className="flex items-start gap-3 py-3">
              <span className="skeleton mt-0.5 h-9 w-1 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <SkeletonLine width="45%" />
                <SkeletonLine width={width} />
                <SkeletonLine width="52%" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Announces to screen readers that a region is still loading. */
export function LoadingRegion({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}
