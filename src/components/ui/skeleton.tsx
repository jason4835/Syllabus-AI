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

export function SkeletonStrip() {
  return (
    <div aria-hidden="true" className="flex gap-1.5">
      {Array.from({ length: 12 }, (_, index) => (
        <span
          key={index}
          className="skeleton h-24 flex-1 rounded-md"
          style={{ animationDelay: `${index * 60}ms` }}
        />
      ))}
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
