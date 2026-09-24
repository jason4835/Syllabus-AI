import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";

import { Logo } from "@/components/icons";
import { GOOGLE_CONSOLE_SCOPES } from "@/lib/google/oauth";
import { isAdminEmail, type Metrics } from "@/lib/metrics";
import { formatCents, TERM_PASS } from "@/lib/pricing";
import { messageOf } from "@/lib/api";
import { logApiError } from "@/lib/log";
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

  /**
   * The failure is shown, not thrown. This page is read by the one person who
   * can act on a database error, and the generic "something broke" boundary
   * hides from them the exact text they need -- which table, which column.
   * `messageOf` redacts anything secret-shaped on the way out, the same pass
   * every route uses, so a connection string in a driver message cannot land
   * on screen.
   */
  let metrics: Metrics | null = null;
  let failure: string | null = null;
  try {
    metrics = await store.metrics();
  } catch (err) {
    failure = messageOf(err);
    logApiError("admin.metrics_failed", err, { userId: user?.id });
  }
  if (!metrics) {
    return (
      <div className="flex min-h-dvh flex-col bg-paper">
        <main id="main" className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
          <h1 className="font-serif text-[2rem] leading-tight font-semibold text-ink">
            Metrics could not be counted
          </h1>
          <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-soft">
            The store answered with an error. This is the message, unedited
            except for anything that looked like a credential:
          </p>
          <pre className="mt-4 overflow-x-auto rounded-lg border border-danger-line bg-danger-soft p-4 font-mono text-[0.8125rem] leading-relaxed whitespace-pre-wrap text-ink">
            {failure}
          </pre>
          <p className="mt-4 text-[0.8125rem] leading-relaxed text-muted">
            A missing table or column means <code className="rounded-sm bg-raised px-1 py-0.5 text-[0.75rem]">supabase/schema.sql</code> has not been
            re-run since a deploy that added one. Anything else is worth pasting to whoever is on call.
          </p>
        </main>
      </div>
    );
  }

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

        <Section title="Usage">
          <Stat
            label="Activated"
            value={metrics.usage.activatedUsers}
            note="Signed-in accounts with at least one course. Sign-ups minus this is the number who signed in and did nothing."
          />
          <Stat label="Courses" value={metrics.usage.courses} note="On real accounts. Demo sandboxes' sample courses are not counted." />
          <Stat label="Deadlines extracted" value={metrics.usage.assessments} />
          <Stat
            label="Calendar connected"
            value={metrics.usage.calendarConnected}
            note="Granted Google Calendar access. The scope the whole verification saga was about."
          />
          <Stat
            label="Events on calendars"
            value={metrics.usage.calendarEventsLinked}
            note="Google events this app created and still tracks. Proof that syncs actually ran."
          />
          <Stat label="Feed subscribers" value={metrics.usage.feedSubscribers} note="Apple Calendar / Outlook subscription URLs in use." />
          <Stat label="Notion connected" value={metrics.usage.notionConnected} />
          <Stat
            label="Stalled at the paywall"
            value={metrics.usage.pendingUploadsWaiting}
            note="Syllabi parsed, refused, and never unlocked. Each is a student who wanted a second course and did not pay."
          />
        </Section>

        <Section title="Who signed up">
          <Stat label="Answered onboarding" value={metrics.onboarding.answered} />
          <Stat label="Skipped it" value={metrics.onboarding.skipped} />
          <Stat
            label="Not asked yet"
            value={metrics.onboarding.notAsked}
            note="Accounts that predate the card, or have not been back since."
          />
          <Stat
            label="School not on the list"
            value={metrics.onboarding.otherSchools}
            note="Typed something that matched no canonical name. If this grows, the list needs those schools."
          />
          <Breakdown title="Top schools" rows={metrics.onboarding.topSchools} empty="No schools answered yet." />
          <Breakdown title="By year" rows={metrics.onboarding.byYear} empty="No years answered yet." />
          <Breakdown
            title="How they found you"
            rows={metrics.onboarding.bySource}
            empty="No sources answered yet."
            note="The number an ad campaign is judged by."
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

/**
 * A ranked list with proportional bars. Labels are canonical enum/list values
 * (a school name, "junior", "ad") -- never anything a student typed free-form.
 */
function Breakdown({
  title,
  rows,
  empty,
  note,
}: {
  title: string;
  rows: { label: string; count: number }[];
  empty: string;
  note?: string;
}) {
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0);
  return (
    <div className="rounded-lg border border-line bg-surface p-4 sm:col-span-2">
      <p className="text-[0.8125rem] text-muted">{title}</p>
      {rows.length === 0 ? (
        <p className="mt-2 text-[0.8125rem] text-muted">{empty}</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {rows.map((row) => (
            <li key={row.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-[0.8125rem]">
              <div className="min-w-0">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-ink">{labelFor(row.label)}</span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-track">
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{ width: `${Math.max(3, Math.round((100 * row.count) / max))}%` }}
                  />
                </div>
              </div>
              <span className="font-serif text-[1rem] leading-none text-ink tabular-nums">
                {row.count.toLocaleString("en-US")}
              </span>
            </li>
          ))}
        </ul>
      )}
      {note ? <p className="mt-2 text-[0.75rem] leading-snug text-muted">{note}</p> : null}
    </div>
  );
}

/** Enum values as the card showed them; school names pass through unchanged. */
function labelFor(value: string): string {
  const map: Record<string, string> = {
    freshman: "Freshman",
    sophomore: "Sophomore",
    junior: "Junior",
    senior: "Senior",
    grad: "Grad student",
    other: "Other",
    ad: "An ad",
    social: "Social media",
    search: "Searching",
    friend: "A friend",
    professor: "A professor or class",
  };
  return map[value] ?? value;
}

/** Rendered on the server, so the operator's own zone is not available here. */
function formatTime(iso: Metrics["generatedAt"]): string {
  return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}
