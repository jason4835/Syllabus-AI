/**
 * What a term looks like to a client, and whether another course may go in it.
 *
 * The rules themselves are in `@/lib/terms` and stay pure. This is the layer
 * that puts a store behind them: counting a term's courses, deciding which term
 * an upload belongs to, and turning a refusal into the one 402 the paywall is
 * drawn from. Every route that can create a course goes through
 * `assertCanAddCourse`, so "the second course in a free term is refused" has a
 * single implementation rather than one per route -- the upload route and the
 * course-move PATCH would otherwise each get to be slightly wrong about it.
 *
 * Server-only: it writes and reads through the store.
 */

import { NextResponse } from "next/server";

import { track } from "@/lib/analytics";
import { log } from "@/lib/log";
import { store } from "@/lib/store";
import { ensureTermsBackfilled } from "@/lib/term-backfill";
import {
  canAddCourse,
  suggestTerm,
  termAccess,
  todayIso,
  validateTermInput,
  type TermAccess,
  type TermSuggestionSource,
} from "@/lib/terms";
import type { AcademicTerm, PendingUpload, PendingUploadSummary } from "@/lib/types";
import { Invalid } from "@/lib/validation";

/**
 * A term plus the three things a client would otherwise have to work out for
 * itself: how many courses are in it, which of the three access states it is in,
 * and whether the next course is free.
 *
 * `canAddCourse` is included even though the client could compute it from the
 * other two, because the server's answer is the one that will be enforced --
 * duplicating the arithmetic in a browser is how a paywall ends up appearing for
 * a course that would have been accepted, or not appearing for one that will not.
 */
export interface TermSummary extends AcademicTerm {
  courseCount: number;
  access: TermAccess;
  canAddCourse: boolean;
  /**
   * A syllabus parsed for this term and refused with the paywall, waiting to be
   * added the moment the term is unlocked. Null when there is none. The
   * paywall reads it to say WHICH course is waiting, and the upload panel
   * replays it after purchase without asking for the file again.
   */
  pendingUpload: PendingUploadSummary | null;
}

export function summarizeTerm(
  term: AcademicTerm,
  courseCount: number,
  now?: Date,
  pendingUpload: PendingUploadSummary | null = null,
): TermSummary {
  return {
    ...term,
    courseCount,
    access: termAccess(term, now),
    canAddCourse: canAddCourse(term, courseCount, now).allowed,
    pendingUpload,
  };
}

/** The client-safe view of a stash: what is waiting, never the parse itself. */
export function summarizePendingUpload(pending: PendingUpload): PendingUploadSummary {
  return {
    id: pending.id,
    fileName: pending.fileName,
    courseCode: pending.parsed.course.code,
    courseTitle: pending.parsed.course.title,
    assessmentCount: pending.parsed.assessments.length,
  };
}

/**
 * One term as a client reads it, counted fresh.
 *
 * The count is a separate read because it changes under writes the term row
 * knows nothing about -- a course created, moved or replaced -- so every route
 * that answers with a term after doing one of those recomputes it here rather
 * than adjusting a number by hand.
 */
export async function summarizeTermFor(
  userId: string,
  term: AcademicTerm,
): Promise<TermSummary> {
  const courses = await store.listCourses(userId);
  return summarizeTerm(term, countCourses(courses, term.id));
}

/** How many of these courses sit in this term, ignoring one by id. */
function countCourses(
  courses: { id: string; termId: string | null }[],
  termId: string,
  excludingCourseId?: string,
): number {
  return courses.filter(
    (c) => c.termId === termId && c.id !== excludingCourseId,
  ).length;
}

/**
 * Every term of this user's, summarized -- the body of `GET /api/terms` and the
 * thing the term routes answer with after a write.
 *
 * The backfill runs first, so a user whose account predates terms gets theirs on
 * the next read rather than seeing an empty list (docs/TERM-PASS.md, "Existing
 * users"). One clock for the whole list, so two terms cannot disagree about
 * whether today is past an expiry.
 */
export async function listTermSummaries(userId: string): Promise<TermSummary[]> {
  await ensureTermsBackfilled(userId);
  const [terms, courses, pending] = await Promise.all([
    store.listTerms(userId),
    store.listCourses(userId),
    store.listPendingUploads(userId),
  ]);
  const now = new Date();
  // Newest first from the store, so the first match per term is the one to
  // show -- a student who hit the paywall twice sees the syllabus they tried
  // most recently.
  return terms.map((term) => {
    const waiting = pending.find((p) => p.termId === term.id);
    return summarizeTerm(
      term,
      countCourses(courses, term.id),
      now,
      waiting ? summarizePendingUpload(waiting) : null,
    );
  });
}

/** The paywall's words, in one place: the route bodies and the log agree. */
export const PAYWALL_MESSAGE =
  "Your first course in this term is free. Unlock the term to add more.";

/**
 * Thrown when a term's free allowance is used up and it is not premium.
 *
 * An exception rather than a return value because the callers are route handlers
 * in the middle of a sequence -- parse, duplicate check, create -- and the only
 * correct thing to do is stop. It carries the summary so the response can show
 * the term the student is being asked to unlock, which is the whole content of
 * the paywall.
 */
export class PaywallError extends Error {
  constructor(public readonly term: TermSummary) {
    super(PAYWALL_MESSAGE);
    this.name = "PaywallError";
  }
}

/**
 * The enforcement point: may this user put another course in this term?
 *
 * `excludingCourseId` is for a move -- a course already in this term does not
 * count against its own relocation, and without it moving a course from a term
 * to itself, or back and forth, would be refused by the course it is.
 *
 * Returns the summary as it stood BEFORE the new course, which is what the
 * upload route needs to tell a first course from a later one.
 */
export async function assertCanAddCourse(
  userId: string,
  term: AcademicTerm,
  opts?: { excludingCourseId?: string },
): Promise<TermSummary> {
  const courses = await store.listCourses(userId);
  const summary = summarizeTerm(
    term,
    countCourses(courses, term.id, opts?.excludingCourseId),
  );
  if (!summary.canAddCourse) throw new PaywallError(summary);
  return summary;
}

/**
 * The 402 every paywalled path answers with.
 *
 * Built by hand rather than with `fail()` for the same reason the upload route's
 * 409 duplicate answer is: the client needs the term itself to draw the paywall,
 * and the envelope's `detail` is a string. `ok`/`error` keep their usual meaning,
 * so a client that ignores `paywall` still shows a sensible message.
 *
 * The funnel event is emitted here rather than at the call sites so that "a
 * student was shown the paywall" cannot be counted twice or missed depending on
 * which route refused them.
 */
export function paywallResponse(
  err: PaywallError,
  pendingUpload: PendingUploadSummary | null = null,
): NextResponse {
  // Not tracked here: the paywall card tracks its own view, and it is shown
  // before an upload as well as on this answer, so counting here too would
  // double the 402 path and miss the pre-upload one.
  return NextResponse.json(
    {
      ok: false as const,
      error: PAYWALL_MESSAGE,
      paywall: {
        // The term as the client already knows it, plus the syllabus that is
        // now waiting on it -- so the card can say which course, not just that.
        term: { ...err.term, pendingUpload },
        courseCount: err.term.courseCount,
      },
    },
    { status: 402 },
  );
}

/**
 * What an upload may say about its term: an existing one, a new one to create,
 * or nothing at all.
 *
 * `newTerm` is `unknown` on purpose -- it arrives as a JSON string in a
 * multipart field and is validated by `validateTermInput`, which is the only
 * thing that decides what a term input is.
 */
export interface UploadTermChoice {
  termId?: string | null;
  newTerm?: unknown;
}

/**
 * Which term an upload's course belongs to, creating one when it has to.
 *
 * The order is the plan's (docs/TERM-PASS.md, "Upload flow"): what the student
 * chose, then what they typed, then what the syllabus itself implies. A term
 * this function infers is created UNCONFIRMED, and `suggested: true` is what
 * tells the dashboard to ask "Create Fall 2026? September 3 - December 17"
 * instead of treating an inference as settled.
 *
 * A dateless suggestion is stored with null dates rather than being rejected:
 * `validateTermInput` is not applied to a model-derived input, because refusing
 * it would mean refusing the upload over dates the syllabus never stated, and
 * the setup card asks for them next.
 */
export async function resolveTermForUpload(
  userId: string,
  parsed: TermSuggestionSource,
  choice: UploadTermChoice,
): Promise<{ term: AcademicTerm; suggested: boolean }> {
  // So a returning student's existing courses already have their terms before
  // `suggestTerm` looks for one to match -- otherwise the first upload after
  // this feature shipped would create a duplicate of a term they already had.
  await ensureTermsBackfilled(userId);

  if (typeof choice.termId === "string" && choice.termId.trim().length > 0) {
    const term = await store.getTerm(userId, choice.termId.trim());
    // Not-yours and no-such-term are the same answer, as everywhere else.
    if (!term) throw new Invalid("That term is not yours.");
    return { term, suggested: false };
  }

  if (choice.newTerm !== undefined && choice.newTerm !== null) {
    const input = validateTermInput(choice.newTerm);
    const term = await store.createTerm(userId, {
      ...input,
      // Typed by the student in this very request: there is nothing left to
      // confirm.
      confirmedAt: new Date().toISOString(),
    });
    track("term_created", { userId, termId: term.id });
    return { term, suggested: false };
  }

  const suggestion = suggestTerm(parsed, await store.listTerms(userId));
  if (suggestion.kind === "existing") {
    return { term: suggestion.term, suggested: false };
  }

  const term = await store.createTerm(userId, {
    ...suggestion.input,
    // Inferred, so the student has the last word on it.
    confirmedAt: null,
  });
  track("term_created", {
    userId,
    termId: term.id,
    inferred: true,
    confident: suggestion.confident,
  });
  if (suggestion.input.startDate === null) {
    // Worth a line of its own: this term cannot be bought until it has dates
    // (the checkout route refuses an unconfirmed term), so a lot of these would
    // mean the setup card is not getting the answers it asks for.
    log.info("terms.inferred_without_dates", { userId, termId: term.id, today: todayIso() });
  }
  return { term, suggested: true };
}
