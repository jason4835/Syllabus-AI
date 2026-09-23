/**
 * What a term is, and what a Term Pass buys -- the rules, with no I/O.
 *
 * Every question the Academic Term Pass asks ("is this term still premium?",
 * "may another course go in it?", "how long may a term be?", "which term does
 * this syllabus belong to?") is answered here, so the routes, the store and the
 * UI cannot each answer it slightly differently. In particular
 * `premiumExpiresAt` is the ONLY place the fourteen-day grace arithmetic lives:
 * the webhook that grants premium, the validator that bounds an edit to a paid
 * term and the read that decides whether access has lapsed all go through it.
 *
 * Pure, like `@/lib/validation`: no store, no `next/*`, no clock except the one
 * a caller passes in. That is what makes it testable and what lets a client
 * component import the parts it needs.
 */

import { addDays, parseIsoDate } from "@/lib/parse/dates";
import { Invalid } from "@/lib/validation";
import type { AcademicTerm, TermInput, TermType } from "@/lib/types";
import { TERM_TYPES } from "@/lib/types";

/**
 * Six months, to the day. A term is a term because it ends: without a cap, one
 * "term" holding a student's whole degree would turn a one-time pass into a
 * subscription nobody renews, and the paywall would never be honest about what
 * it sold.
 */
export const MAX_TERM_DAYS = 183;

/**
 * How long premium outlives the term it was bought for. Finals week runs past
 * the last day of classes on most calendars, and a syllabus's stated end date
 * is routinely a week early, so access that stopped on `endDate` would stop in
 * the middle of exactly the week the student needs it.
 */
export const PREMIUM_GRACE_DAYS = 14;

/** Every term includes one course, and that course is the whole product. */
export const FREE_COURSES_PER_TERM = 1;

/**
 * How far past what was paid for a premium term's end date may be moved.
 *
 * Corrections have to be possible -- a syllabus said December 10 and the
 * registrar says December 17 -- but a term whose end date can be pushed
 * indefinitely is an unlimited pass sold for $5.99. Thirty days covers every
 * correction and no renewal.
 */
export const PREMIUM_EDIT_SLACK_DAYS = 30;

/* -------------------------------------------------------------------------- */
/* Dates and arithmetic                                                        */
/* -------------------------------------------------------------------------- */

/** Days since the epoch for an ISO date, or null when it is not one. */
function dayNumber(iso: string): number | null {
  const d = parseIsoDate(iso);
  if (!d) return null;
  return Math.round(Date.UTC(d.year, d.month - 1, d.day) / 86_400_000);
}

/**
 * The length of a term, as the plain difference between its two dates:
 * `2026-09-03 .. 2026-12-17` is 105.
 *
 * `NaN` for anything that is not a pair of ISO dates, which is deliberate --
 * every comparison against `NaN` is false, so an unparseable term fails the
 * length check rather than sailing through it.
 */
export function termLengthDays(start: string, end: string): number {
  const a = dayNumber(start);
  const b = dayNumber(end);
  if (a === null || b === null) return Number.NaN;
  return b - a;
}

/**
 * When premium bought for a term ending on `endDate` runs out: fourteen days
 * later, and nowhere else in the tree.
 *
 * Throws on a date that is not ISO. That is a programmer error rather than a
 * user one -- every end date is validated before it reaches storage -- and a
 * plausible-looking string returned from here would end up inside somebody's
 * access window, where nobody would ever notice it was wrong.
 */
export function premiumExpiresAt(endDate: string): string {
  const expires = addDays(endDate, PREMIUM_GRACE_DAYS);
  if (expires === null) {
    throw new Error(`premiumExpiresAt: ${endDate} is not an ISO date`);
  }
  return expires;
}

/**
 * Today, in UTC, as `YYYY-MM-DD`.
 *
 * UTC rather than the server's zone so the answer does not depend on where the
 * process runs, and a date rather than a timestamp because every date in this
 * app is a date. The consequence is that access can end up to a day out from a
 * student's local midnight, and it ends LATE for everyone west of UTC -- which
 * is the right direction to be wrong in for something they paid for.
 */
export function todayIso(now?: Date): string {
  return (now ?? new Date()).toISOString().slice(0, 10);
}

/**
 * Is this term premium AND still inside its window?
 *
 * `premium` alone is not the question: it stays true forever once paid, because
 * the record of a purchase is not something to erase. The expiry is what says
 * whether it still grants anything today.
 */
export function termHasPremiumAccess(
  term: Pick<AcademicTerm, "premium" | "premiumExpiresAt">,
  now?: Date,
): boolean {
  if (!term.premium || term.premiumExpiresAt === null) return false;
  return todayIso(now) <= term.premiumExpiresAt;
}

/**
 * The three states a term can be in, as one word the UI can switch on.
 *
 * `expired` is deliberately distinct from `free`: a student who paid and whose
 * term has ended should be told their pass ran out, not shown a paywall that
 * implies they never bought one.
 */
export type TermAccess = "premium" | "expired" | "free";

export function termAccess(
  term: Pick<AcademicTerm, "premium" | "premiumExpiresAt">,
  now?: Date,
): TermAccess {
  if (termHasPremiumAccess(term, now)) return "premium";
  return term.premium ? "expired" : "free";
}

/**
 * May another course go into this term?
 *
 * `reason` is the answer's provenance, not a message: `premium` (the pass
 * covers it), `free_slot` (the term's own allowance covers it) or `paywall`
 * (the allowance is used up). The route turns the last one into the 402 the
 * paywall is drawn from; the client asks the same question early so a student
 * does not pay for a parse they cannot keep.
 *
 * `freeCourses` rather than the constant, because a term the backfill created
 * carries the number of courses it grandfathered -- see `ensureTermsBackfilled`.
 */
export function canAddCourse(
  term: Pick<AcademicTerm, "premium" | "premiumExpiresAt" | "freeCourses">,
  courseCount: number,
  now?: Date,
): { allowed: boolean; reason: "premium" | "free_slot" | "paywall" } {
  if (termHasPremiumAccess(term, now)) return { allowed: true, reason: "premium" };
  if (courseCount < term.freeCourses) return { allowed: true, reason: "free_slot" };
  return { allowed: false, reason: "paywall" };
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

/** The name cap is a form field's worth of text, not a paragraph. */
const MAX_TERM_NAME = 60;

/** A date field that may be absent (read as null), null, or a real ISO date. */
function termDate(body: Record<string, unknown>, field: "startDate" | "endDate"): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && parseIsoDate(value) !== null) return value;
  throw new Invalid(`${field} must be YYYY-MM-DD or null`);
}

/**
 * An untrusted body into a `TermInput`, or `Invalid` naming the field.
 *
 * `requireDates` defaults to TRUE: a term the student is typing in has dates,
 * and silently storing a dateless one would leave a term nothing can decide an
 * expiry for. The one caller that passes `false` is the path that creates a
 * term inferred from a syllabus which stated no dates at all -- there the setup
 * card asks for them next, and refusing the create would mean refusing the
 * upload.
 *
 * Both-or-neither is enforced either way: a start with no end is not a shorter
 * term, it is half a form, and everything downstream (length, expiry, overlap)
 * needs the pair.
 */
export function validateTermInput(
  body: unknown,
  opts?: { requireDates?: boolean },
): TermInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Invalid("a term must be an object");
  }
  const fields = body as Record<string, unknown>;

  const name = typeof fields.name === "string" ? fields.name.trim() : "";
  if (name.length < 1 || name.length > MAX_TERM_NAME) {
    throw new Invalid(`name must be 1-${MAX_TERM_NAME} characters`);
  }

  // Absent means `custom`, because that is what a term with no stated type is.
  // A present-but-unrecognised value is a typo and is rejected, so the check
  // constraint in supabase/schema.sql can never be the thing that finds it.
  let termType: TermType = "custom";
  if (fields.termType !== undefined && fields.termType !== null) {
    if (!(TERM_TYPES as readonly unknown[]).includes(fields.termType)) {
      throw new Invalid(`termType must be one of: ${TERM_TYPES.join(", ")}`);
    }
    termType = fields.termType as TermType;
  }

  const startDate = termDate(fields, "startDate");
  const endDate = termDate(fields, "endDate");

  if ((startDate === null) !== (endDate === null)) {
    throw new Invalid("a term needs both a start date and an end date, or neither");
  }
  if ((opts?.requireDates ?? true) && startDate === null) {
    throw new Invalid("a term needs a start date and an end date");
  }

  if (startDate !== null && endDate !== null) {
    if (endDate < startDate) {
      throw new Invalid("endDate must not be before startDate");
    }
    if (!(termLengthDays(startDate, endDate) <= MAX_TERM_DAYS)) {
      throw new Invalid("A term can be at most 6 months long.");
    }
  }

  return { name, termType, startDate, endDate };
}

/**
 * May a PREMIUM term's end date move to `newEnd`?
 *
 * Shortening is always allowed, and moves the expiry earlier with it. Extending
 * is bounded against what was actually bought -- `paidEndDate`, the end date as
 * it stood when the payment landed -- so a paid term can be corrected but not
 * renewed. The six-month rule is `validateTermInput`'s job and is checked
 * separately; this is only about the pass.
 *
 * A term that is not premium is unbounded here: there is nothing to protect.
 */
export function premiumEndDateAllowed(
  term: AcademicTerm,
  newEnd: string,
): { ok: true } | { ok: false; reason: string } {
  if (!term.premium) return { ok: true };

  // `paidEndDate` is what was bought; `endDate` stands in for a term whose
  // purchase predates that column. Neither being a date leaves nothing to
  // measure against, and refusing every edit would be worse than allowing one.
  const bought = term.paidEndDate ?? term.endDate;
  if (bought === null || parseIsoDate(bought) === null) return { ok: true };
  // Reported rather than thrown: this returns a decision, and every caller is
  // already prepared to show one. `validateTermInput` is what normally catches
  // a malformed date, well before here.
  if (parseIsoDate(newEnd) === null) {
    return { ok: false, reason: "endDate must be YYYY-MM-DD" };
  }

  if (newEnd <= bought) return { ok: true };

  const ceiling = addDays(premiumExpiresAt(bought), PREMIUM_EDIT_SLACK_DAYS);
  if (ceiling !== null && premiumExpiresAt(newEnd) <= ceiling) return { ok: true };

  return {
    ok: false,
    reason:
      `A paid term's end date can move at most ${PREMIUM_EDIT_SLACK_DAYS} days past ` +
      `the ${bought} you bought. Shortening it is always allowed.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Inference                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How much of A falls inside B, as a fraction of A.
 *
 * Asymmetric on purpose: A is the course and B is the term, and the question is
 * whether this course belongs to that term -- a two-week module sitting inside
 * a fifteen-week semester overlaps it completely, while the semester overlaps
 * the module by a tenth.
 *
 * Both counts are inclusive, so a one-day course is a span of 1 rather than a
 * division by zero. 0 when the two do not meet, or when either range is not a
 * pair of ISO dates.
 */
export function overlapFraction(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): number {
  const a0 = dayNumber(aStart);
  const a1 = dayNumber(aEnd);
  const b0 = dayNumber(bStart);
  const b1 = dayNumber(bEnd);
  if (a0 === null || a1 === null || b0 === null || b1 === null) return 0;

  const span = a1 - a0 + 1;
  if (span <= 0) return 0;
  const overlap = Math.min(a1, b1) - Math.max(a0, b0) + 1;
  if (overlap <= 0) return 0;
  return Math.min(overlap, span) / span;
}

/**
 * A NAME for a term starting on this date -- "Fall 2026", "Spring 2027".
 *
 * A suggestion and nothing else: it is put in an editable field, it never sets
 * a type and it never sets a date. December is read as the winter term that
 * starts in it rather than as a late autumn, which is the only month where the
 * two readings differ enough to matter.
 */
export function seasonName(startDate: string): string {
  const d = parseIsoDate(startDate);
  // Nothing better to offer than the generic label the form starts with.
  if (!d) return "New term";
  if (d.month === 12) return `Winter ${d.year}`;
  if (d.month >= 8) return `Fall ${d.year}`;
  if (d.month <= 5) return `Spring ${d.year}`;
  return `Summer ${d.year}`;
}

/**
 * The term type a set of dates and a label most likely describe.
 *
 * The label wins when it says so, because a school naming its own calendar is
 * better evidence than a length: a nine-week "Summer Session" is a summer term
 * even though nine weeks is quarter-shaped. Length decides the rest, and
 * `custom` is the answer whenever the dates support no confident reading --
 * never a guess dressed up as a fact.
 */
export function guessTermType(startDate: string, endDate: string, name?: string): TermType {
  const label = (name ?? "").toLowerCase();
  if (label.includes("quarter")) return "quarter";
  if (/j-term|jterm|january term/.test(label)) return "j_term";
  if (label.includes("summer")) return "summer";
  if (label.includes("winter")) return "winter";
  if (label.includes("trimester")) return "trimester";

  const days = termLengthDays(startDate, endDate);
  if (!Number.isFinite(days)) return "custom";
  if (days <= 42) {
    const month = parseIsoDate(startDate)?.month ?? 0;
    // A few weeks in January is a J-term or a winter session; a few weeks in
    // late spring or summer is a summer session; a few weeks anywhere else is
    // something this function has no name for.
    if (month === 1) return "j_term";
    if (month >= 5 && month <= 8) return "summer";
    return "custom";
  }
  if (days <= 84) return "quarter";
  return "semester";
}

/**
 * Which term an uploaded syllabus belongs to: one the student already has, or
 * one to offer to create.
 *
 * `confident` on a new suggestion is the difference between a term the syllabus
 * stated and one this function worked out from where the deadlines fall. Only
 * the first is worth presenting as settled; the second is what the setup card
 * asks about before anything is final (docs/TERM-PASS.md, "Upload flow").
 */
export type TermSuggestion =
  | { kind: "existing"; term: AcademicTerm }
  | { kind: "new"; input: TermInput; confident: boolean };

/** The half of a `ParsedSyllabus` this needs -- so a caller can pass a stub. */
export interface TermSuggestionSource {
  course: { term: string | null; startDate: string | null; endDate: string | null };
  assessments: { dueDate: string | null }[];
}

/** An ISO date or null, so a stored value that is neither cannot be reasoned about. */
function isoOrNull(value: string | null): string | null {
  return value !== null && parseIsoDate(value) !== null ? value : null;
}

/**
 * The window a syllabus covers: what it stated, or -- failing that -- the span
 * of the work it lists.
 *
 * Two dated items is the minimum for the fallback, because one deadline is a
 * point, not a span, and a term inferred from it would be a single day. A span
 * longer than a term is not a term either: a syllabus with a stray 2028 date in
 * it would otherwise swallow every real term the student has.
 */
function courseBounds(
  parsed: TermSuggestionSource,
): { start: string; end: string; stated: boolean } | null {
  const start = isoOrNull(parsed.course.startDate);
  const end = isoOrNull(parsed.course.endDate);
  let bounds: { start: string; end: string; stated: boolean } | null = null;

  if (start !== null && end !== null && start <= end) {
    bounds = { start, end, stated: true };
  } else {
    const dated = parsed.assessments
      .map((a) => isoOrNull(a.dueDate))
      .filter((d): d is string => d !== null)
      .sort();
    if (dated.length >= 2) {
      bounds = { start: dated[0], end: dated[dated.length - 1], stated: false };
    }
  }

  if (bounds && termLengthDays(bounds.start, bounds.end) > MAX_TERM_DAYS) return null;
  return bounds;
}

/** Same-name matching, ignoring case and stray spacing. */
export function normalizeTermLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The share of a course that must fall inside a term for it to be that course's
 * term. Half is high enough that a January module does not attach to the autumn
 * semester it ends next to, and low enough that a course whose syllabus states
 * the lecture period while the term row states the exam period still matches.
 */
export const TERM_MATCH_OVERLAP = 0.5;

export function suggestTerm(
  parsed: TermSuggestionSource,
  terms: AcademicTerm[],
  // Accepted so callers can pass the clock they are already threading through,
  // and so a future rule ("prefer the term that has not ended") does not change
  // this signature. Nothing here reads it: which term a syllabus describes is a
  // fact about the syllabus, not about today.
  now?: Date,
): TermSuggestion {
  const bounds = courseBounds(parsed);
  const label = parsed.course.term?.trim() || null;

  if (bounds !== null) {
    // Highest overlap first, so a course that sits inside two terms the student
    // has entered with overlapping dates lands in the better fit rather than
    // the older row.
    let best: { term: AcademicTerm; fraction: number } | null = null;
    for (const term of terms) {
      if (term.startDate === null || term.endDate === null) continue;
      const fraction = overlapFraction(
        bounds.start,
        bounds.end,
        term.startDate,
        term.endDate,
      );
      if (fraction < TERM_MATCH_OVERLAP) continue;
      if (best === null || fraction > best.fraction) best = { term, fraction };
    }
    if (best !== null) return { kind: "existing", term: best.term };

    const name = label ?? seasonName(bounds.start);
    return {
      kind: "new",
      input: {
        name,
        // The resolved name, not just the syllabus's label: a window that
        // `seasonName` called "Summer 2027" is better evidence of a summer term
        // than its length alone is.
        termType: guessTermType(bounds.start, bounds.end, name),
        startDate: bounds.start,
        endDate: bounds.end,
      },
      confident: bounds.stated,
    };
  }

  // No usable dates. The label is the only evidence left, and it is enough to
  // recognise a term the student already has -- a second syllabus saying
  // "Fall 2026" belongs with the first one, whatever else it failed to state.
  if (label !== null) {
    const needle = normalizeTermLabel(label);
    const match = terms.find((t) => normalizeTermLabel(t.name) === needle);
    if (match) return { kind: "existing", term: match };
  }

  /**
   * Still nothing -- no dates, and no label that matches. Before inventing a
   * term, prefer the one the student has PAID for and is inside right now.
   *
   * This is the rule that stops a paying customer being asked to pay twice.
   * Plenty of syllabi state neither a term window nor a term name (or state
   * them in a way the extractor cannot read), and every such upload used to
   * land in a fresh "New term" -- free for its first course, and full for the
   * next one, at which point a student holding a valid Term Pass was shown a
   * paywall for the term they were standing in.
   *
   * Confined to the no-evidence case on purpose. A syllabus WITH dates that
   * overlap the paid term is already matched above, and one whose dates fall
   * outside it is genuinely another term -- pulling it in would file a spring
   * course under an autumn pass. When the evidence is silent, the term the
   * student paid for is the best guess by a wide margin, and a wrong guess is
   * one click to fix in the setup card; a wrong paywall is a refund request.
   *
   * Exactly one such term, so two overlapping paid terms (a quarter system,
   * say) still fall through rather than picking one arbitrarily.
   */
  const active = terms.filter((t) => termHasPremiumAccess(t, now));
  if (active.length === 1) return { kind: "existing", term: active[0] };

  return {
    kind: "new",
    input: {
      name: label ?? "New term",
      // No dates means no length, and a type read off a label alone would be a
      // guess the student then has to notice and undo.
      termType: "custom",
      startDate: null,
      endDate: null,
    },
    confident: false,
  };
}
