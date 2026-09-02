import type { ReactNode } from "react";

export interface PanelProps {
  /** Ties the section to its heading for assistive tech. */
  id: string;
  title: string;
  icon?: ReactNode;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** The one container every dashboard panel uses, so they stack as a system. */
export function Panel({
  id,
  title,
  icon,
  description,
  action,
  children,
  className,
}: PanelProps) {
  const headingId = `${id}-heading`;
  return (
    <section
      aria-labelledby={headingId}
      className={`panel flex flex-col overflow-hidden ${className ?? ""}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3.5 sm:px-5">
        <div className="min-w-0">
          <h2
            id={headingId}
            className="flex items-center gap-2 text-base leading-tight text-ink"
          >
            {icon ? <span className="text-accent">{icon}</span> : null}
            {title}
          </h2>
          {description ? (
            <p className="mt-1 text-[0.8125rem] leading-snug text-muted">
              {description}
            </p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </header>
      <div className="flex-1 p-4 sm:p-5">{children}</div>
    </section>
  );
}
