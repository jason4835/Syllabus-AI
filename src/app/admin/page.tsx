import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";

import { Logo } from "@/components/icons";
import { GOOGLE_CONSOLE_SCOPES } from "@/lib/google/oauth";
import { isAdminEmail, type Metrics } from "@/lib/metrics";
import { formatCents, TERM_PASS } from "@/lib/pricing";
import { readSession } from "@/lib/session";
import { store } from "@/lib/store";

/** Counts are taken live on every load; a cached number is a misleading one. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Metrics",
  // Nothing here should ever appear in a search result or a link preview.
  robots: { index: false, follow: false },
};

/**
 * The operator's dashboard: signups and paying members, and nothing else.
 *
 * A page rather than an API route because the only consumer is a person
 * checking the numbers from a browser, and a page needs no client, no token and
 * no second auth path -- it reuses the session cookie everything else uses.
 *
 * `notFound()` rather than a 403 for a non-admin, so the page does not confirm
 * its own existence to a signed-in student who guesses the URL. With
 * `ADMIN_EMAILS` unset it 404s for everybody, including the owner: a metrics
 * page nobody opted into should not be open.
 */
export default async function AdminPage() {
  const userId = await readSession();
  const user = userId ? await store.getUser(userId) : null;
  if (!isAdminEmail(user?.email)) notFound();

  const metrics = await store.metrics();

  return (
    <div className="flex min-h-dvh flex-col bg-paper">
      <header className="border-b border-line">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <a href="/dashboard" className="flex items-center gap-2.5 rounded-sm">
            <Logo />
            <span className="font-serif text-[1.0625rem] font-semibold text-ink">
              Syllabus Center
            </span>
          </a>
          <span className="text-[0.8125rem] text-muted">Metrics</span>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
        <h1 className="font-serif text-[2rem] leading-tight font-semibold text-ink sm:text-[2.5rem]">
          How it&rsquo;s going
        </h1>
        <p className="mt-2 text-[0.8125rem] text-muted">
          Counted live at {formatTime(metrics.generatedAt)}. Reload for fresh
          numbers.
        </p>

        <Section title="People">
          <Stat
            label="Sign-ups"
            value={metrics.signups}
            note="Google accounts. Demo sandboxes are not counted."
          />
          <Stat label="New in the last 7 days" value={metrics.signupsLast7Days} />
          <Stat label="New in the last 30 days" value={metrics.signupsLast30Days} />
          <Stat
            label="Demo sandboxes"
            value={metrics.demoSandboxes}
            note="Visitors who tried it without signing in. One row each, so the users table looks bigger than sign-ups."
          />
        </Section>

        <Section title="Money">
          <Stat
            label="Paying members"
            value={metrics.payingMembers}
            note="People who have bought at least one Term Pass, ever."
          />
          <Stat
            label="Passes sold"
            value={metrics.passesSold}
            note="Higher than paying members once somebody buys a second term."
          />
          <Stat
            label="Passes active today"
            value={metrics.activePasses}
            note="Still granting premium access, 14-day grace included."
          />
          <Stat
            label="Gross revenue"
            value={formatCents(metrics.passesSold * TERM_PASS.amountCents)}
            note={`Passes sold \u00d7 ${TERM_PASS.display}, today\u2019s price. Stripe is the real ledger \u2014 this ignores refunds and any price change.`}
          />
        </Section>

        <section className="mt-10" aria-label="Google OAuth scopes">
          <h2 className="text-[0.75rem] font-semibold tracking-[0.08em] text-muted uppercase">
            Google OAuth scopes
          </h2>
          <p className="mt-2 text-[0.8125rem] leading-relaxed text-muted">
            Every scope this deployment&rsquo;s sign-in asks for, read from the
            code rather than retyped. Google&rsquo;s stated cause of a
            &ldquo;Google hasn&rsquo;t verified this app&rdquo; warning on an
            already-verified app is a request carrying a scope the project was
            not approved for, so this list must match{" "}
            <strong className="font-medium text-ink-soft">
              Google Auth Platform &rsaquo; Data Access
            </strong>{" "}
            exactly &mdash; no extras on either side. Note the Console spells{" "}
            <code className="rounded-sm bg-raised px-1 py-0.5 text-[0.75rem]">email</code>{" "}
            and{" "}
            <code className="rounded-sm bg-raised px-1 py-0.5 text-[0.75rem]">profile</code>{" "}
            as full <code className="rounded-sm bg-raised px-1 py-0.5 text-[0.75rem]">userinfo.*</code> URLs.
          </p>
          <div className="mt-3 overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="w-full min-w-[34rem] text-left text-[0.8125rem]">
              <thead>
                <tr className="border-b border-line text-[0.75rem] text-muted">
                  <th scope="col" className="px-4 py-2 font-medium">Requested in code</th>
                  <th scope="col" className="px-4 py-2 font-medium">Must be approved as</th>
                </tr>
              </thead>
              <tbody>
                {GOOGLE_CONSOLE_SCOPES.map((scope) => (
                  <tr key={scope.requested} className="border-b border-line last:border-0">
                    <td className="px-4 py-2 font-mono text-[0.75rem] break-all text-ink">
                      {scope.requested}
                    </td>
                    <td className="px-4 py-2 font-mono text-[0.75rem] break-all text-muted">
                      {scope.console}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[0.75rem] text-muted">
            Full checklist for the unverified warning: docs/DEPLOY.md section 3d.
          </p>
        </section>

        <p className="mt-10 text-[0.8125rem] leading-relaxed text-muted">
          These come straight from the app&rsquo;s own tables, so they are exact
          and cost nothing. Funnel questions &mdash; how many people saw the
          paywall, how many started a checkout and left &mdash; are moments in
          time rather than rows, and are in the logs as{" "}
          <code className="rounded-sm bg-raised px-1 py-0.5 text-[0.75rem]">
            analytics.*
          </code>{" "}
          lines (see <code className="rounded-sm bg-raised px-1 py-0.5 text-[0.75rem]">src/lib/analytics.ts</code>).
        </p>
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-10" aria-label={title}>
      <h2 className="text-[0.75rem] font-semibold tracking-[0.08em] text-muted uppercase">
        {title}
      </h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">{children}</div>
    </section>
  );
}

function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: number | string;
  note?: string;
}) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <p className="text-[0.8125rem] text-muted">{label}</p>
      <p className="mt-1 font-serif text-[2rem] leading-none font-semibold text-ink tabular-nums">
        {typeof value === "number" ? value.toLocaleString("en-US") : value}
      </p>
      {note ? (
        <p className="mt-2 text-[0.75rem] leading-snug text-muted">{note}</p>
      ) : null}
    </div>
  );
}

/** Rendered on the server, so the operator's own zone is not available here. */
function formatTime(iso: Metrics["generatedAt"]): string {
  return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}
