import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "accent" | "warn" | "danger" | "course";

const TONES: Record<BadgeTone, string> = {
  neutral: "border-line bg-raised text-ink-soft",
  accent: "border-accent-line bg-accent-soft text-accent",
  warn: "border-warn-line bg-warn-soft text-warn",
  danger: "border-danger-line bg-danger-soft text-danger",
  course: "border-[color:var(--accent)] bg-transparent text-[color:var(--accent)]",
};

export function Badge({
  tone = "neutral",
  children,
  title,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium tracking-wide whitespace-nowrap ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/** Course code chip — inherits `--accent` from an ancestor's inline style. */
export function CourseChip({ code, color }: { code: string; color: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[0.75rem] font-semibold tracking-wide text-ink-soft">
      <span
        aria-hidden="true"
        className="h-2 w-2 rounded-full"
        style={{ backgroundColor: color }}
      />
      {code}
    </span>
  );
}
