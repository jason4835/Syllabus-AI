import type { AppConfig } from "@/components/api-client";
import { InfoIcon } from "@/components/icons";
import { LinkButton } from "@/components/ui/button";

/**
 * A student on the demo is not the person who sets environment variables. This
 * banner used to hand them `OPENAI_API_KEY` and `GOOGLE_CLIENT_SECRET` and a
 * line about restarting the server — a full phone screen of instructions they
 * could not act on, sitting above their semester.
 *
 * Demo is per visitor now, so sign-in is a live option from inside it: the
 * banner says what a sample semester is and offers the one step out of it. The
 * operator copy still exists, because a half-configured deployment is worth
 * naming — it just only appears where an operator is, outside production.
 */
export function DemoBanner({ config }: { config: AppConfig }) {
  const missing: string[] = [];
  if (!config.openaiReady) missing.push("OPENAI_API_KEY");
  if (!config.googleReady) {
    missing.push("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET");
  }
  const showOperatorNote =
    process.env.NODE_ENV !== "production" && missing.length > 0;

  return (
    <aside
      aria-label="Sample semester"
      className="rounded-xl border border-accent-line bg-accent-soft px-4 py-3.5 sm:px-5"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 text-accent">
          <InfoIcon width={17} height={17} />
        </span>
        <div className="min-w-0">
          <p className="text-[0.9375rem] font-semibold text-ink">
            You&rsquo;re looking at a sample semester
          </p>
          <p className="mt-1 text-[0.875rem] leading-relaxed text-ink-soft">
            Upload your own syllabus and everything here updates. Sign in to keep
            it past this visit and sync it to your real calendar.
          </p>
          <div className="mt-3">
            <LinkButton href="/api/auth/google" size="sm">
              Sign in with Google
            </LinkButton>
          </div>
          {showOperatorNote ? (
            <p className="mt-2.5 text-[0.75rem] leading-relaxed text-muted">
              Developer note — not shown in production: this server is missing{" "}
              {missing.map((key, index) => (
                <span key={key}>
                  {index > 0 ? (index === missing.length - 1 ? " and " : ", ") : ""}
                  <code className="rounded-sm bg-surface px-1 py-0.5 font-mono text-[0.75rem] text-ink-soft">
                    {key}
                  </code>
                </span>
              ))}
              , so sign-in and AI parsing stay unavailable until it is set and the
              server restarts.
            </p>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
