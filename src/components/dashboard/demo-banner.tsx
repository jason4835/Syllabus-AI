import type { AppConfig } from "@/components/api-client";
import { InfoIcon } from "@/components/icons";

/**
 * Honest, non-alarming: says exactly what is and is not connected, and which
 * environment variables switch it on.
 */
export function DemoBanner({ config }: { config: AppConfig }) {
  const missing: string[] = [];
  if (!config.openaiReady) missing.push("OPENAI_API_KEY");
  if (!config.googleReady) {
    missing.push("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET");
  }

  return (
    <aside
      aria-label="Demo mode"
      className="rounded-xl border border-accent-line bg-accent-soft px-4 py-3.5 sm:px-5"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 text-accent">
          <InfoIcon width={17} height={17} />
        </span>
        <div className="min-w-0">
          <p className="text-[0.9375rem] font-semibold text-ink">
            You are in demo mode
          </p>
          <p className="mt-1 text-[0.875rem] leading-relaxed text-ink-soft">
            Everything below runs on sample data. No Google account is connected,
            uploads are parsed by the built-in fixture parser, and calendar sync
            is a dry run — nothing is written to a real calendar.
          </p>
          {missing.length > 0 ? (
            <p className="mt-2 text-[0.8125rem] leading-relaxed text-ink-soft">
              To go live, set{" "}
              {missing.map((key, index) => (
                <span key={key}>
                  {index > 0 ? (index === missing.length - 1 ? " and " : ", ") : ""}
                  <code className="rounded-sm bg-surface px-1 py-0.5 font-mono text-[0.75rem] text-ink">
                    {key}
                  </code>
                </span>
              ))}{" "}
              and restart the server.
            </p>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
