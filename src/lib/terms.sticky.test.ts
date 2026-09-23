import { describe, expect, it } from "vitest";

import { suggestTerm } from "@/lib/terms";
import type { AcademicTerm } from "@/lib/types";

/**
 * The rule that stops a paying student being asked to pay twice.
 *
 * A syllabus that states no term dates and no term label used to become a
 * fresh "New term" -- free for one course, full for the next -- so a student
 * holding a valid Term Pass was shown the paywall for the term they were
 * standing in. These pin down when the paid term is preferred and, just as
 * importantly, when it must not be.
 */

const NOW = new Date("2026-10-15T12:00:00Z");

function term(over: Partial<AcademicTerm> & { id: string }): AcademicTerm {
  return {
    userId: "u1",
    name: over.name ?? "Fall 2026",
    termType: "semester",
    startDate: "2026-08-24",
    endDate: "2026-12-14",
    freeCourses: 1,
    confirmedAt: "2026-08-01T00:00:00Z",
    premium: false,
    premiumStartedAt: null,
    premiumExpiresAt: null,
    paidEndDate: null,
    stripeCheckoutSessionId: null,
    stripePaymentIntentId: null,
    stripeCustomerId: null,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...over,
  };
}

const paid = term({
  id: "paid",
  premium: true,
  premiumStartedAt: "2026-09-01T00:00:00Z",
  premiumExpiresAt: "2026-12-28",
  paidEndDate: "2026-12-14",
});

/** A syllabus that says nothing about when it is. */
const silent = {
  course: { term: null, startDate: null, endDate: null },
  assessments: [],
};

describe("suggestTerm prefers the active paid term", () => {
  it("files an undated, unlabelled syllabus into the term the student paid for", () => {
    const result = suggestTerm(silent, [paid], NOW);
    expect(result).toEqual({ kind: "existing", term: paid });
  });

  it("does NOT reach for a pass that has expired", () => {
    const expired = term({ ...paid, id: "expired", premiumExpiresAt: "2026-10-01" });
    const result = suggestTerm(silent, [expired], NOW);
    expect(result.kind).toBe("new");
  });

  it("does NOT reach for an unpaid term, even the current one", () => {
    // Without a pass there is nothing to protect: a new term is free for its
    // first course, and the label/overlap rules already handle the rest.
    const result = suggestTerm(silent, [term({ id: "free" })], NOW);
    expect(result.kind).toBe("new");
  });

  it("stays out of it when two paid terms are active at once", () => {
    // Overlapping quarters, both paid: guessing between them would be wrong
    // half the time, and a wrong paywall is cheaper than a wrong term here
    // because the student is about to be asked which term anyway.
    const second = term({ ...paid, id: "paid2", name: "Q2" });
    const result = suggestTerm(silent, [paid, second], NOW);
    expect(result.kind).toBe("new");
  });

  it("still lets DATES win: a course dated outside the paid term is another term", () => {
    // Spring dates against an autumn pass. The overlap rule sees 0% and the
    // sticky rule must not override that -- this is a different semester.
    const spring = {
      course: { term: null, startDate: "2027-01-20", endDate: "2027-05-10" },
      assessments: [],
    };
    const result = suggestTerm(spring, [paid], NOW);
    expect(result.kind).toBe("new");
  });

  it("still lets a LABEL win over the paid term", () => {
    const winter = term({ id: "winter", name: "Winter 2027", startDate: null, endDate: null });
    const labelled = {
      course: { term: "Winter 2027", startDate: null, endDate: null },
      assessments: [],
    };
    const result = suggestTerm(labelled, [paid, winter], NOW);
    expect(result).toEqual({ kind: "existing", term: winter });
  });
});
