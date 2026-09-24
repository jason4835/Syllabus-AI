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
  /**
   * What people have actually done with the product. Every figure is a count
   * across all real accounts; nothing here can be traced to one student.
   */
  usage: UsageMetrics;
  /**
   * The onboarding card's answers, folded into breakdowns. This is the entire
   * reason the card exists -- to judge an ad campaign by who it brought in --
   * and it is shown as counts per label, never as a list of people.
   */
  onboarding: OnboardingMetrics;
  /** When these counts were taken. They are live, never cached. */
  generatedAt: string;
}

export interface UsageMetrics {
  /** Courses on real accounts. Demo sandboxes' seeded courses are excluded. */
  courses: number;
  assessments: number;
  /** Real accounts with at least one course: signed in AND did the thing. */
  activatedUsers: number;
  /** Real accounts that granted calendar access (hold a refresh token). */
  calendarConnected: number;
  /** Google events this app has created and still tracks. Proof of syncs. */
  calendarEventsLinked: number;
  /** Real accounts holding a subscription-feed URL (Apple/Outlook path). */
  feedSubscribers: number;
  notionConnected: number;
  /**
   * Syllabi parsed, refused with the paywall, and never unlocked. Each one is
   * a student who wanted a second course and did not pay -- the most direct
   * number the paywall's conversion has.
   */
  pendingUploadsWaiting: number;
}

export interface OnboardingMetrics {
  /** Answered at least one question. */
  answered: number;
  skipped: number;
  /** Signed-in accounts that have not seen the card yet (or predate it). */
  notAsked: number;
  /** Top schools by count, canonical names only. At most ten. */
  topSchools: { label: string; count: number }[];
  /** Typed a school that matched nothing canonical -- the list's gap, counted. */
  otherSchools: number;
  byYear: { label: string; count: number }[];
  bySource: { label: string; count: number }[];
}

/** The subset of a user's profile the breakdowns read. */
export interface ProfileFacts {
  school?: string;
  schoolOther?: string;
  year?: string;
  source?: string;
  completedAt?: string;
}

/**
 * Folds every real account's profile into the onboarding breakdowns.
 *
 * Pure, so the drivers only differ in how they fetch. "Answered" means at
 * least one real answer; a card completed with all three left blank counts as
 * skipped, because from the data's point of view that is what it is.
 */
export function foldProfiles(profiles: readonly ProfileFacts[]): OnboardingMetrics {
  const schools = new Map<string, number>();
  const years = new Map<string, number>();
  const sources = new Map<string, number>();
  let answered = 0;
  let skipped = 0;
  let notAsked = 0;
  let otherSchools = 0;

  for (const p of profiles) {
    if (!p.completedAt) {
      notAsked += 1;
      continue;
    }
    const gave = Boolean(p.school || p.schoolOther || p.year || p.source);
    if (gave) answered += 1;
    else skipped += 1;
    if (p.school) schools.set(p.school, (schools.get(p.school) ?? 0) + 1);
    else if (p.schoolOther) otherSchools += 1;
    if (p.year) years.set(p.year, (years.get(p.year) ?? 0) + 1);
    if (p.source) sources.set(p.source, (sources.get(p.source) ?? 0) + 1);
  }

  const ranked = (m: Map<string, number>, limit = Infinity) =>
    [...m.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
      .slice(0, limit);

  return {
    answered,
    skipped,
    notAsked,
    topSchools: ranked(schools, 10),
    otherSchools,
    byYear: ranked(years),
    bySource: ranked(sources),
  };
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
