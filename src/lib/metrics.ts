/**
 * Operator metrics: how many people signed up, and how many paid.
 *
 * This is the whole analytics stack. There is no vendor, no event pipeline and
 * no dashboard service -- the two numbers that matter are already sitting in
 * `users` and `academic_terms`, so the answer is a handful of counts rather
 * than an integration. `src/lib/analytics.ts` is the other half and answers a
 * different question: it logs *funnel* events (a paywall seen, a checkout
 * started), which are moments in time and cannot be counted from a table.
 *
 * Nothing here is per-user. The counts describe the deployment, they are read
 * only by the operator (see `isAdminEmail`), and no row is ever returned --
 * a metrics page that leaked a student's email would be worse than no metrics
 * page.
 *
 * Server-only: `isAdminEmail` reads env.
 */

/** What `/admin` shows. Counts only -- never a row, never an email. */
export interface Metrics {
  /** Real accounts. Demo sandboxes are excluded; they are visitors, not signups. */
  signups: number;
  signupsLast7Days: number;
  signupsLast30Days: number;
  /**
   * Ephemeral per-visitor sandboxes (`demo_…`). Reported separately because
   * they have a `users` row too, so anyone reading the table raw will see a
   * bigger number than `signups` and wonder which one is real.
   */
  demoSandboxes: number;
  /** Distinct people who have ever bought a Term Pass. */
  payingMembers: number;
  /**
   * Passes bought. Higher than `payingMembers` once someone buys a second
   * term -- which is the repeat-purchase signal, so the two are not merged.
   */
  passesSold: number;
  /** Passes still granting access today, grace period included. */
  activePasses: number;
  /** When these counts were taken. They are live, never cached. */
  generatedAt: string;
}

/**
 * One paid term, reduced to the only two fields the counts need.
 *
 * Both store drivers project their rows down to this before folding, so the
 * arithmetic below is written once and cannot drift between Postgres and the
 * JSON file.
 */
export interface PaidTerm {
  userId: string;
  /** `end_date` + 14 days, set at purchase. Null on a pre-expiry legacy row. */
  premiumExpiresAt: string | null;
}

export type PremiumCounts = Pick<
  Metrics,
  "payingMembers" | "passesSold" | "activePasses"
>;

/**
 * Folds the paid terms into three numbers.
 *
 * Pure, so it is the thing the test exercises -- the drivers around it are just
 * two ways of fetching the same rows.
 *
 * `today` is an ISO date (`YYYY-MM-DD`) and the comparison is a string compare,
 * which is exact for that format and matches how `termHasPremiumAccess` in
 * `@/lib/terms` decides the same question for a single term. A null expiry
 * counts as active: it means the row predates the expiry column, and a paying
 * customer must never be silently downgraded by a missing field.
 */
export function foldPaidTerms(
  terms: readonly PaidTerm[],
  today: string,
): PremiumCounts {
  const members = new Set<string>();
  let activePasses = 0;

  for (const term of terms) {
    members.add(term.userId);
    if (term.premiumExpiresAt === null || term.premiumExpiresAt >= today) {
      activePasses += 1;
    }
  }

  return {
    payingMembers: members.size,
    passesSold: terms.length,
    activePasses,
  };
}

/**
 * The ISO instant N days ago, for comparing against a stored `createdAt`.
 *
 * `createdAt` is a full `toISOString()` timestamp, so a lexicographic `>=`
 * against another one is a correct time comparison -- both are UTC, both are
 * fixed-width. The Supabase driver passes this straight to PostgREST `gte`,
 * where the same reasoning holds for a `text` column.
 */
export function isoDaysAgo(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Who may read `/admin`.
 *
 * An env allow-list of email addresses rather than a role column, because the
 * deployment has exactly one operator and a role column would need a UI to set
 * it -- which is a small admin system to guard a page of six numbers.
 *
 * Unset means nobody: `/admin` 404s for everyone, including a signed-in user,
 * which is the right default for a deployment whose owner never opted in.
 * Comparison is case-insensitive and trimmed, because `ADMIN_EMAILS` is typed
 * by hand into a hosting dashboard.
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const allowed = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return allowed.includes(email.trim().toLowerCase());
}
