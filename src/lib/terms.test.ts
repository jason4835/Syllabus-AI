/**
 * The rules of a term and of the Academic Term Pass, as a product person would
 * state them. Everything here is pure: no store, no clock except the one each
 * test passes in.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_TERM_DAYS,
  PREMIUM_GRACE_DAYS,
  canAddCourse,
  guessTermType,
  premiumEndDateAllowed,
  premiumExpiresAt,
  seasonName,
  suggestTerm,
  termAccess,
  termHasPremiumAccess,
  termLengthDays,
  validateTermInput,
} from "@/lib/terms";
import { Invalid } from "@/lib/validation";
import type { AcademicTerm, TermType } from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** A stored term. Overrides say the one thing each test is actually about. */
function term(overrides: Partial<AcademicTerm> = {}): AcademicTerm {
  return {
    id: "term-1",
    userId: "user-1",
    name: "Fall 2026",
    termType: "semester",
    startDate: "2026-09-01",
    endDate: "2026-12-20",
    freeCourses: 1,
    confirmedAt: "2026-08-20T00:00:00.000Z",
    premium: false,
    premiumStartedAt: null,
    premiumExpiresAt: null,
    paidEndDate: null,
    stripeCheckoutSessionId: null,
    stripePaymentIntentId: null,
    stripeCustomerId: null,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

/** A term somebody paid for, with the expiry the webhook would have computed. */
function paidTerm(endDate: string, overrides: Partial<AcademicTerm> = {}): AcademicTerm {
  return term({
    endDate,
    premium: true,
    premiumStartedAt: "2026-09-05T00:00:00.000Z",
    premiumExpiresAt: premiumExpiresAt(endDate),
    paidEndDate: endDate,
    ...overrides,
  });
}

/** A date, as the UTC `Date` the access checks read a day number out of. */
function on(iso: string): Date {
  return new Date(`${iso}T12:00:00.000Z`);
}

/** The slice of a parsed syllabus `suggestTerm` reads. */
function syllabus(
  course: { term?: string | null; startDate?: string | null; endDate?: string | null },
  dueDates: (string | null)[] = [],
) {
  return {
    course: {
      term: course.term ?? null,
      startDate: course.startDate ?? null,
      endDate: course.endDate ?? null,
    },
    assessments: dueDates.map((dueDate) => ({ dueDate })),
  };
}

/* -------------------------------------------------------------------------- */
/* Expiry                                                                      */
/* -------------------------------------------------------------------------- */

describe("when a Term Pass runs out", () => {
  it("gives the student fourteen days past the end of the term", () => {
    expect(PREMIUM_GRACE_DAYS).toBe(14);
    expect(premiumExpiresAt("2026-12-20")).toBe("2027-01-03");
  });

  it("counts real calendar days across the end of a month and a year", () => {
    expect(premiumExpiresAt("2027-02-28")).toBe("2027-03-14");
  });

  it("counts February 29 in a leap year, so a leap-year term expires a day earlier by date", () => {
    // 2028 is a leap year: the fourteen days from February 28 include the 29th,
    // which lands the expiry on March 13 rather than the 14th.
    expect(premiumExpiresAt("2028-02-28")).toBe("2028-03-13");
  });

  it("refuses to invent an expiry for something that is not a date", () => {
    expect(() => premiumExpiresAt("December 20")).toThrow(/not an ISO date/);
  });
});

/* -------------------------------------------------------------------------- */
/* Six-month cap and the rest of the create form                               */
/* -------------------------------------------------------------------------- */

describe("how long a term is allowed to be", () => {
  it("is at most six months, to the day", () => {
    expect(MAX_TERM_DAYS).toBe(183);
  });

  it("accepts a term of exactly 183 days", () => {
    expect(termLengthDays("2026-09-01", "2027-03-03")).toBe(183);
    const input = validateTermInput({
      name: "A very long term",
      startDate: "2026-09-01",
      endDate: "2027-03-03",
    });
    expect(input.endDate).toBe("2027-03-03");
  });

  it("rejects a term of 184 days, and says so in words a student can read", () => {
    expect(termLengthDays("2026-09-01", "2027-03-04")).toBe(184);
    expect(() =>
      validateTermInput({
        name: "My whole degree",
        startDate: "2026-09-01",
        endDate: "2027-03-04",
      }),
    ).toThrow("A term can be at most 6 months long.");
  });
});

describe("what a student may type into the term form", () => {
  it("wants both dates or neither, never half a form", () => {
    expect(() =>
      validateTermInput({ name: "Fall 2026", startDate: "2026-09-01" }),
    ).toThrow(Invalid);
    expect(() =>
      validateTermInput({ name: "Fall 2026", startDate: "2026-09-01" }),
    ).toThrow(/both a start date and an end date, or neither/);

    expect(() => validateTermInput({ name: "Fall 2026", endDate: "2026-12-20" })).toThrow(
      /both a start date and an end date, or neither/,
    );
  });

  it("insists on dates by default, and allows a dateless term only where the caller asks", () => {
    expect(() => validateTermInput({ name: "Fall 2026" })).toThrow(
      /needs a start date and an end date/,
    );

    const inferred = validateTermInput({ name: "Fall 2026" }, { requireDates: false });
    expect(inferred).toEqual({
      name: "Fall 2026",
      termType: "custom",
      startDate: null,
      endDate: null,
    });
  });

  it("rejects an end date that falls before the start date", () => {
    expect(() =>
      validateTermInput({
        name: "Backwards",
        startDate: "2026-12-20",
        endDate: "2026-09-01",
      }),
    ).toThrow(/endDate must not be before startDate/);
  });

  it("accepts a one-day term, which is a start and an end that match", () => {
    const input = validateTermInput({
      name: "Reading day",
      startDate: "2026-12-20",
      endDate: "2026-12-20",
    });
    expect(input.startDate).toBe("2026-12-20");
    expect(input.endDate).toBe("2026-12-20");
  });

  it("needs a name, and keeps it to the length of a form field", () => {
    const dates = { startDate: "2026-09-01", endDate: "2026-12-20" };
    expect(() => validateTermInput({ name: "", ...dates })).toThrow(/name must be 1-60/);
    expect(() => validateTermInput({ name: "   ", ...dates })).toThrow(/name must be 1-60/);
    expect(() => validateTermInput({ name: "x".repeat(61), ...dates })).toThrow(
      /name must be 1-60/,
    );
    expect(validateTermInput({ name: "x".repeat(60), ...dates }).name).toBe("x".repeat(60));
  });

  it("trims the name, so 'Fall 2026 ' and 'Fall 2026' are the same term", () => {
    expect(
      validateTermInput({
        name: "  Fall 2026  ",
        startDate: "2026-09-01",
        endDate: "2026-12-20",
      }).name,
    ).toBe("Fall 2026");
  });

  it("treats a term with no stated type as a custom one", () => {
    expect(
      validateTermInput({ name: "Block 3", startDate: "2026-09-01", endDate: "2026-10-20" })
        .termType,
    ).toBe("custom");
    expect(
      validateTermInput({
        name: "Block 3",
        termType: null,
        startDate: "2026-09-01",
        endDate: "2026-10-20",
      }).termType,
    ).toBe("custom");
  });

  it("rejects a term type it does not recognise rather than storing it", () => {
    expect(() =>
      validateTermInput({
        name: "Fall 2026",
        termType: "SEMESTER",
        startDate: "2026-09-01",
        endDate: "2026-12-20",
      }),
    ).toThrow(/termType must be one of/);
    expect(() =>
      validateTermInput({
        name: "Fall 2026",
        termType: 7,
        startDate: "2026-09-01",
        endDate: "2026-12-20",
      }),
    ).toThrow(/termType must be one of/);
  });

  it("rejects a date that is not YYYY-MM-DD", () => {
    expect(() =>
      validateTermInput({ name: "Fall 2026", startDate: "09/01/2026", endDate: "2026-12-20" }),
    ).toThrow(/startDate must be YYYY-MM-DD or null/);
  });

  it("rejects a body that is not an object at all", () => {
    expect(() => validateTermInput("Fall 2026")).toThrow(/a term must be an object/);
    expect(() => validateTermInput([{ name: "Fall 2026" }])).toThrow(
      /a term must be an object/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Access                                                                      */
/* -------------------------------------------------------------------------- */

describe("what a Term Pass grants while it lasts", () => {
  const fall = paidTerm("2026-12-20"); // expires 2027-01-03

  it("is premium on the last day of the grace period", () => {
    expect(termHasPremiumAccess(fall, on("2027-01-03"))).toBe(true);
    expect(termAccess(fall, on("2027-01-03"))).toBe("premium");
  });

  it("lets a paid term hold any number of courses", () => {
    expect(canAddCourse(fall, 0, on("2026-10-01"))).toEqual({
      allowed: true,
      reason: "premium",
    });
    expect(canAddCourse(fall, 1, on("2026-10-01"))).toEqual({
      allowed: true,
      reason: "premium",
    });
    expect(canAddCourse(fall, 12, on("2026-10-01"))).toEqual({
      allowed: true,
      reason: "premium",
    });
  });
});

describe("what happens once the term the student paid for is over", () => {
  const fall = paidTerm("2026-12-20"); // expires 2027-01-03
  const theDayAfter = on("2027-01-04");

  it("stops granting premium the day after the grace period ends", () => {
    expect(termHasPremiumAccess(fall, theDayAfter)).toBe(false);
  });

  it("says 'expired' rather than 'free', so nobody is told they never paid", () => {
    expect(termAccess(fall, theDayAfter)).toBe("expired");
    expect(termAccess(term(), theDayAfter)).toBe("free");
  });

  it("keeps the record of the purchase even though it grants nothing", () => {
    expect(fall.premium).toBe(true);
    expect(fall.premiumExpiresAt).toBe("2027-01-03");
  });

  it("puts the paywall back at the second course", () => {
    expect(canAddCourse(fall, 0, theDayAfter)).toEqual({
      allowed: true,
      reason: "free_slot",
    });
    expect(canAddCourse(fall, 1, theDayAfter)).toEqual({
      allowed: false,
      reason: "paywall",
    });
  });

  it("does not grant premium on a paid term that somehow has no expiry", () => {
    const noExpiry = paidTerm("2026-12-20", { premiumExpiresAt: null });
    expect(termHasPremiumAccess(noExpiry, on("2026-10-01"))).toBe(false);
    expect(termAccess(noExpiry, on("2026-10-01"))).toBe("expired");
  });
});

/* -------------------------------------------------------------------------- */
/* The free course and the paywall                                             */
/* -------------------------------------------------------------------------- */

describe("the one free course every term includes", () => {
  const now = on("2026-10-01");

  it("lets the first course into an unpaid term", () => {
    expect(canAddCourse(term({ freeCourses: 1 }), 0, now)).toEqual({
      allowed: true,
      reason: "free_slot",
    });
  });

  it("shows the paywall when a second course is added to an unpaid term", () => {
    expect(canAddCourse(term({ freeCourses: 1 }), 1, now)).toEqual({
      allowed: false,
      reason: "paywall",
    });
  });

  it("starts the count again for a brand new term", () => {
    const fall = term({ id: "fall", name: "Fall 2026", freeCourses: 1 });
    const spring = term({
      id: "spring",
      name: "Spring 2027",
      freeCourses: 1,
      startDate: "2027-01-15",
      endDate: "2027-05-05",
    });

    // The autumn term is full and unpaid...
    expect(canAddCourse(fall, 1, now).allowed).toBe(false);
    // ...and the spring term the student just created still has its free course.
    expect(canAddCourse(spring, 0, now)).toEqual({ allowed: true, reason: "free_slot" });
  });

  it("gives a grandfathered term the courses it was migrated with, and charges for the next one", () => {
    const migrated = term({ freeCourses: 3, name: "My courses" });
    expect(canAddCourse(migrated, 0, now).reason).toBe("free_slot");
    expect(canAddCourse(migrated, 1, now).reason).toBe("free_slot");
    expect(canAddCourse(migrated, 2, now).reason).toBe("free_slot");
    expect(canAddCourse(migrated, 3, now)).toEqual({ allowed: false, reason: "paywall" });
  });
});

/* -------------------------------------------------------------------------- */
/* Editing a paid term                                                         */
/* -------------------------------------------------------------------------- */

describe("moving the end date of a term somebody paid for", () => {
  const fall = paidTerm("2026-12-20"); // paidEndDate 2026-12-20

  it("always allows shortening it", () => {
    expect(premiumEndDateAllowed(fall, "2026-12-10")).toEqual({ ok: true });
    expect(premiumEndDateAllowed(fall, "2026-12-20")).toEqual({ ok: true });
  });

  it("allows a correction of up to thirty days past what was bought", () => {
    expect(premiumEndDateAllowed(fall, "2027-01-19")).toEqual({ ok: true });
  });

  it("refuses thirty-one days, because that is a renewal rather than a correction", () => {
    const answer = premiumEndDateAllowed(fall, "2027-01-20");
    expect(answer.ok).toBe(false);
    expect(answer).toMatchObject({
      reason: expect.stringContaining("at most 30 days past the 2026-12-20 you bought"),
    });
  });

  it("measures against what was PAID for, not against the current end date", () => {
    // The end date has already been corrected forward once; the ceiling has not
    // moved with it, because the ceiling is what the student bought.
    const corrected = paidTerm("2026-12-20", { endDate: "2027-01-19" });
    expect(premiumEndDateAllowed(corrected, "2027-01-19")).toEqual({ ok: true });
    expect(premiumEndDateAllowed(corrected, "2027-01-20").ok).toBe(false);
  });

  it("leaves an unpaid term entirely alone -- this rule only protects a purchase", () => {
    // Deliberately absurd: two years past the end. The six-month cap is
    // `validateTermInput`'s job, and this function says nothing about it.
    expect(premiumEndDateAllowed(term(), "2028-12-20")).toEqual({ ok: true });
  });

  it("reports a malformed new end date instead of throwing at the caller", () => {
    expect(premiumEndDateAllowed(fall, "20 December")).toEqual({
      ok: false,
      reason: "endDate must be YYYY-MM-DD",
    });
  });

  it("allows the edit when there is no bought date to measure against", () => {
    const noRecord = paidTerm("2026-12-20", { paidEndDate: null, endDate: null });
    expect(premiumEndDateAllowed(noRecord, "2028-12-20")).toEqual({ ok: true });
  });
});

/* -------------------------------------------------------------------------- */
/* The shapes of an academic calendar                                          */
/* -------------------------------------------------------------------------- */

describe("the many shapes an academic calendar comes in", () => {
  const shapes: { what: string; name: string; start: string; end: string; type: TermType }[] = [
    { what: "a January term", name: "J-Term 2027", start: "2027-01-04", end: "2027-01-22", type: "j_term" },
    { what: "a summer session", name: "Summer 2027", start: "2027-06-01", end: "2027-07-30", type: "summer" },
    { what: "a quarter", name: "Autumn Quarter 2026", start: "2026-09-21", end: "2026-12-11", type: "quarter" },
    { what: "a trimester", name: "Trimester 1", start: "2026-09-08", end: "2026-11-20", type: "trimester" },
    { what: "a winter session", name: "Winter Session 2027", start: "2026-12-28", end: "2027-01-15", type: "winter" },
    { what: "a custom six-month block", name: "Block 3", start: "2026-09-01", end: "2027-03-03", type: "custom" },
  ];

  for (const shape of shapes) {
    it(`accepts ${shape.what} (${shape.name})`, () => {
      const input = validateTermInput({
        name: shape.name,
        termType: shape.type,
        startDate: shape.start,
        endDate: shape.end,
      });
      expect(input).toEqual({
        name: shape.name,
        termType: shape.type,
        startDate: shape.start,
        endDate: shape.end,
      });
    });
  }

  it("reads three weeks in January as a J-term", () => {
    expect(guessTermType("2027-01-04", "2027-01-22")).toBe("j_term");
  });

  it("reads eleven weeks in the autumn as a quarter", () => {
    expect(termLengthDays("2026-09-21", "2026-12-11")).toBe(81);
    expect(guessTermType("2026-09-21", "2026-12-11")).toBe("quarter");
  });

  it("reads a whole autumn as a semester", () => {
    expect(guessTermType("2026-09-01", "2026-12-20")).toBe("semester");
  });

  it("reads a June-to-July window as a summer term once it is named one", () => {
    expect(guessTermType("2027-06-01", "2027-07-30", "Summer 2027")).toBe("summer");
  });

  it("reads a nine-week June-to-July window with NO name as a quarter, by its length alone", () => {
    // Documenting what the function actually does: nine weeks is quarter-shaped,
    // and with no label there is nothing to say "summer". `suggestTerm` never
    // asks the question this way -- it always passes the resolved name, which
    // `seasonName` makes "Summer 2027" -- see the suggestion tests below.
    expect(termLengthDays("2027-06-01", "2027-07-30")).toBe(59);
    expect(guessTermType("2027-06-01", "2027-07-30")).toBe("quarter");
  });

  it("lets the school's own name beat the length: 'Winter Quarter 2027' is a quarter", () => {
    // Semester-length dates, and the word "quarter" in the name wins -- as does
    // "quarter" over "winter", because a school that says both means the former.
    expect(termLengthDays("2027-01-05", "2027-06-01")).toBe(147);
    expect(guessTermType("2027-01-05", "2027-06-01")).toBe("semester");
    expect(guessTermType("2027-01-05", "2027-06-01", "Winter Quarter 2027")).toBe("quarter");
  });

  it("refuses to guess a type from dates it cannot read", () => {
    expect(guessTermType("not a date", "2027-01-22")).toBe("custom");
  });

  it("names a term after the season it starts in", () => {
    expect(seasonName("2026-09-04")).toBe("Fall 2026");
    expect(seasonName("2027-01-20")).toBe("Spring 2027");
    expect(seasonName("2027-06-01")).toBe("Summer 2027");
    expect(seasonName("2026-12-28")).toBe("Winter 2026");
  });
});

/* -------------------------------------------------------------------------- */
/* Which term a syllabus belongs to                                            */
/* -------------------------------------------------------------------------- */

describe("which term a newly uploaded syllabus belongs to", () => {
  const fall2026 = term({
    id: "fall-2026",
    name: "Fall 2026",
    startDate: "2026-09-01",
    endDate: "2026-12-20",
  });

  it("files a September-to-December syllabus in the Fall 2026 term the student already has", () => {
    const answer = suggestTerm(syllabus({ startDate: "2026-09-04", endDate: "2026-12-15" }), [
      fall2026,
    ]);
    expect(answer).toEqual({ kind: "existing", term: fall2026 });
  });

  it("offers to create Spring 2027 when the only term on file is the autumn one", () => {
    const answer = suggestTerm(
      syllabus({ startDate: "2027-01-20", endDate: "2027-05-05" }),
      [fall2026],
    );
    expect(answer).toEqual({
      kind: "new",
      confident: true,
      input: {
        name: "Spring 2027",
        termType: "semester",
        startDate: "2027-01-20",
        endDate: "2027-05-05",
      },
    });
  });

  it("uses the syllabus's own term label for the new term when it states one", () => {
    const answer = suggestTerm(
      syllabus({ term: "Spring Quarter 2027", startDate: "2027-03-29", endDate: "2027-06-11" }),
      [],
    );
    expect(answer).toMatchObject({
      kind: "new",
      confident: true,
      input: { name: "Spring Quarter 2027", termType: "quarter" },
    });
  });

  it("calls a June-to-July syllabus a summer term, because that is what it named it", () => {
    const answer = suggestTerm(syllabus({ startDate: "2027-06-01", endDate: "2027-07-30" }), []);
    expect(answer).toMatchObject({
      kind: "new",
      input: { name: "Summer 2027", termType: "summer" },
    });
  });

  it("recognises a term by name alone when the syllabus gave no dates at all", () => {
    const answer = suggestTerm(syllabus({ term: "fall  2026" }), [fall2026]);
    expect(answer).toEqual({ kind: "existing", term: fall2026 });
  });

  it("does not attach a January module to the autumn semester it ends next to", () => {
    const answer = suggestTerm(syllabus({ startDate: "2027-01-04", endDate: "2027-01-22" }), [
      fall2026,
    ]);
    expect(answer).toMatchObject({ kind: "new", input: { termType: "j_term" } });
  });

  it("picks the better fit when two terms the student entered overlap", () => {
    const earlyFall = term({
      id: "early",
      name: "Fall A 2026",
      startDate: "2026-09-01",
      endDate: "2026-10-24",
    });
    const wholeFall = term({
      id: "whole",
      name: "Fall 2026",
      startDate: "2026-09-01",
      endDate: "2026-12-20",
    });
    const answer = suggestTerm(
      syllabus({ startDate: "2026-09-08", endDate: "2026-12-15" }),
      [earlyFall, wholeFall],
    );
    expect(answer).toEqual({ kind: "existing", term: wholeFall });
  });

  it("is NOT confident about a term it worked out from where the deadlines fall", () => {
    const answer = suggestTerm(
      syllabus({ startDate: null, endDate: null }, [
        "2026-09-18",
        "2026-10-30",
        "2026-12-11",
      ]),
      [],
    );
    expect(answer).toEqual({
      kind: "new",
      confident: false,
      input: {
        name: "Fall 2026",
        // The first and last deadline are a narrower window than the term they
        // sit in -- 84 days here, which reads as a quarter -- which is exactly
        // why this suggestion is not presented as settled.
        termType: "quarter",
        startDate: "2026-09-18",
        endDate: "2026-12-11",
      },
    });
  });

  it("will not turn a single deadline into a term, and asks for the dates instead", () => {
    const answer = suggestTerm(syllabus({}, ["2026-10-30"]), [fall2026]);
    expect(answer).toEqual({
      kind: "new",
      confident: false,
      input: { name: "New term", termType: "custom", startDate: null, endDate: null },
    });
  });

  it("ignores a stray far-future date rather than inventing a term that swallows every real one", () => {
    const answer = suggestTerm(
      syllabus({ term: "Fall 2026" }, ["2026-09-18", "2028-12-11"]),
      [fall2026],
    );
    // The assessment span is longer than a term, so it is discarded -- and the
    // label is then enough to recognise the term the student already has.
    expect(answer).toEqual({ kind: "existing", term: fall2026 });
  });

  it("skips a term with no dates when matching a dated syllabus against it", () => {
    const dateless = term({ id: "dateless", name: "Fall 2026", startDate: null, endDate: null });
    const answer = suggestTerm(syllabus({ startDate: "2026-09-04", endDate: "2026-12-15" }), [
      dateless,
    ]);
    expect(answer).toMatchObject({ kind: "new" });
  });
});
