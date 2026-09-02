import type { ReactNode } from "react";
import { AlertIcon } from "@/components/icons";

export function EmptyState({
  title,
  body,
  action,
  icon,
}: {
  title: string;
  body: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-line-strong bg-sunken/50 px-5 py-9 text-center">
      {icon ? <div className="mb-3 text-muted">{icon}</div> : null}
      <p className="font-serif text-[1.0625rem] text-ink">{title}</p>
      <p className="mt-1.5 max-w-xs text-[0.8125rem] leading-relaxed text-muted">
        {body}
      </p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  error,
  detail,
  onRetry,
}: {
  error: string;
  detail?: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-danger-line bg-danger-soft px-4 py-3.5"
    >
      <p className="flex items-start gap-2 text-[0.875rem] font-medium text-danger">
        <AlertIcon className="mt-0.5 shrink-0" width={16} height={16} />
        <span>{error}</span>
      </p>
      {detail ? (
        <p className="mt-1.5 pl-6 text-[0.8125rem] leading-relaxed text-ink-soft">
          {detail}
        </p>
      ) : null}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 ml-6 rounded-md border border-danger-line bg-surface px-2.5 py-1 text-[0.8125rem] font-medium text-ink transition-colors hover:bg-raised"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function Note({
  tone = "info",
  children,
}: {
  tone?: "info" | "warn";
  children: ReactNode;
}) {
  const styles =
    tone === "warn"
      ? "border-warn-line bg-warn-soft text-ink"
      : "border-line bg-raised text-ink-soft";
  return (
    <p className={`rounded-md border px-3 py-2 text-[0.8125rem] leading-relaxed ${styles}`}>
      {children}
    </p>
  );
}
