/**
 * The local JSON driver's half of the Term Pass: terms belong to one student,
 * only the webhook path grants premium, a Stripe event is processed once, and
 * deleting a term never deletes a course.
 *
 * Runs against a throwaway `DATA_DIR`. The store is imported dynamically in
 * `beforeAll`, AFTER that variable is set, because `getStore()` picks its driver
 * on first use and a static import would have run first.
 */

import { rm } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { premiumExpiresAt } from "@/lib/terms";
import type { ParsedSyllabus } from "@/lib/types";

const DATA_DIR = path.join(
  "/private/tmp/claude-501/-Users-jasonpaz-Documents-Syllabus-AI/1f6e25fc-6f28-4d22-903a-506ae0872d0f/scratchpad/w4",
  "local-terms",
);

type Store = typeof import("@/lib/store")["store"];
let store: Store;

beforeAll(async () => {
  process.env.DATA_DIR = DATA_DIR;
  // The local driver is only chosen when there are no Supabase keys around.
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  await rm(DATA_DIR, { recursive: true, force: true });
  ({ store } = await import("@/lib/store"));
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  await rm(DATA_DIR, { recursive: true, force: true });
});

/** The smallest syllabus the store will accept, so a test can make a course. */
function parsedSyllabus(
  course: Partial<ParsedSyllabus["course"]> = {},
): ParsedSyllabus {
  return {
    course: {
      code: "MATH 221",
      title: "Linear Algebra",
      instructor: null,
      term: "Fall 2026",
      startDate: "2026-09-01",
      endDate: "2026-12-20",
      meetingTimes: [],
      sections: [],
      noClass: [],
      gradeWeights: [],
      policies: [],
      ...course,
    },
    assessments: [],
    warnings: [],
  };
}

const fallInput = {
  name: "Fall 2026",
  termType: "semester" as const,
  startDate: "2026-09-01",
  endDate: "2026-12-20",
};

/* -------------------------------------------------------------------------- */

describe("a term belongs to the student who created it", () => {
  it("is readable and listable by its owner", async () => {
    const created = await store.createTerm("student-a", fallInput);

    expect(created).toMatchObject({
      userId: "student-a",
      name: "Fall 2026",
      termType: "semester",
      startDate: "2026-09-01",
      endDate: "2026-12-20",
    });
    expect(await store.getTerm("student-a", created.id)).toEqual(created);
    expect(await store.listTerms("student-a")).toEqual([created]);
  });

  it("starts with one free course, unconfirmed, and never premium", async () => {
    const created = await store.createTerm("student-allowance", fallInput);
    expect(created.freeCourses).toBe(1);
    expect(created.confirmedAt).toBeNull();
    expect(created.premium).toBe(false);
    expect(created.premiumExpiresAt).toBeNull();
    expect(created.paidEndDate).toBeNull();
  });

  it("carries a larger free allowance when the caller is migrating courses in", async () => {
    const created = await store.createTerm("student-grandfathered", {
      ...fallInput,
      freeCourses: 3,
      confirmedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(created.freeCourses).toBe(3);
    expect(created.confirmedAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("is invisible to another student, who cannot read, edit or delete it", async () => {
    const mine = await store.createTerm("student-owner", fallInput);

    expect(await store.getTerm("student-intruder", mine.id)).toBeNull();
    expect(await store.updateTerm("student-intruder", mine.id, { name: "Mine now" })).toBeNull();
    expect(await store.deleteTerm("student-intruder", mine.id)).toBe(false);
    expect(
      await store.grantTermPremium("student-intruder", mine.id, {
        premiumStartedAt: "2026-09-05T00:00:00.000Z",
        premiumExpiresAt: "2027-01-03",
        paidEndDate: "2026-12-20",
        stripeCheckoutSessionId: "cs_intruder",
        stripePaymentIntentId: null,
        stripeCustomerId: null,
      }),
    ).toBeNull();

    // Nothing the intruder tried left a mark.
    expect(await store.getTerm("student-owner", mine.id)).toEqual(mine);
    expect(await store.listTerms("student-intruder")).toEqual([]);
  });

  it("can be renamed, redated and confirmed by its owner", async () => {
    const created = await store.createTerm("student-edit", fallInput);
    const updated = await store.updateTerm("student-edit", created.id, {
      name: "Autumn 2026",
      termType: "quarter",
      endDate: "2026-12-17",
      confirmedAt: "2026-08-25T00:00:00.000Z",
    });

    expect(updated).toMatchObject({
      id: created.id,
      name: "Autumn 2026",
      termType: "quarter",
      endDate: "2026-12-17",
      confirmedAt: "2026-08-25T00:00:00.000Z",
    });
    // Identity is not data.
    expect(updated?.createdAt).toBe(created.createdAt);
    expect(updated?.userId).toBe("student-edit");
  });

  it("can be deleted by its owner, and then reads as gone", async () => {
    const created = await store.createTerm("student-delete", fallInput);
    expect(await store.deleteTerm("student-delete", created.id)).toBe(true);
    expect(await store.getTerm("student-delete", created.id)).toBeNull();
    expect(await store.deleteTerm("student-delete", created.id)).toBe(false);
  });

  it("lists each student only their own terms", async () => {
    const a = await store.createTerm("student-list-a", fallInput);
    const b = await store.createTerm("student-list-b", { ...fallInput, name: "Spring 2027" });

    expect((await store.listTerms("student-list-a")).map((t) => t.id)).toEqual([a.id]);
    expect((await store.listTerms("student-list-b")).map((t) => t.id)).toEqual([b.id]);
  });
});

describe("granting premium on a paid term", () => {
  it("marks the term premium and records the expiry the caller computed", async () => {
    const created = await store.createTerm("student-paid", fallInput);
    const granted = await store.grantTermPremium("student-paid", created.id, {
      premiumStartedAt: "2026-09-05T00:00:00.000Z",
      premiumExpiresAt: premiumExpiresAt("2026-12-20"),
      paidEndDate: "2026-12-20",
      stripeCheckoutSessionId: "cs_test_123",
      stripePaymentIntentId: "pi_test_123",
      stripeCustomerId: "cus_test_123",
    });

    expect(granted).toMatchObject({
      premium: true,
      premiumStartedAt: "2026-09-05T00:00:00.000Z",
      premiumExpiresAt: "2027-01-03",
      paidEndDate: "2026-12-20",
      stripeCheckoutSessionId: "cs_test_123",
      stripePaymentIntentId: "pi_test_123",
      stripeCustomerId: "cus_test_123",
    });
    // And it is on disk, not just in the returned object.
    expect(await store.getTerm("student-paid", created.id)).toEqual(granted);
  });

  it("will not let an ordinary edit grant a pass nobody paid for", async () => {
    const created = await store.createTerm("student-forge", fallInput);
    const updated = await store.updateTerm("student-forge", created.id, {
      // Deliberately a stray key an API body might carry.
      premium: true,
      paidEndDate: "2027-12-20",
    } as unknown as { name: string });

    expect(updated?.premium).toBe(false);
    expect(updated?.paidEndDate).toBeNull();
  });
});

describe("processing a Stripe webhook delivery only once", () => {
  it("records a new event id, and refuses the same id the second time", async () => {
    expect(await store.recordStripeEvent("evt_1", "checkout.session.completed")).toBe(true);
    expect(await store.recordStripeEvent("evt_1", "checkout.session.completed")).toBe(false);
  });

  it("keeps a different event id separate", async () => {
    expect(await store.recordStripeEvent("evt_2", "checkout.session.expired")).toBe(true);
    expect(await store.recordStripeEvent("evt_1", "checkout.session.completed")).toBe(false);
  });
});

describe("the link between a course and its term", () => {
  it("files a new course in the term the upload flow resolved", async () => {
    const fall = await store.createTerm("student-course", fallInput);
    const { course } = await store.createCourse("student-course", parsedSyllabus(), fall.id);
    expect(course.termId).toBe(fall.id);
  });

  it("leaves a course with no term when the upload flow resolved none", async () => {
    const { course } = await store.createCourse("student-termless", parsedSyllabus());
    expect(course.termId).toBeNull();
  });

  it("lets a student move a course from one term to another", async () => {
    const fall = await store.createTerm("student-move", fallInput);
    const spring = await store.createTerm("student-move", {
      name: "Spring 2027",
      termType: "semester",
      startDate: "2027-01-15",
      endDate: "2027-05-05",
    });
    const { course } = await store.createCourse("student-move", parsedSyllabus(), fall.id);

    const moved = await store.updateCourse("student-move", course.id, { termId: spring.id });
    expect(moved?.termId).toBe(spring.id);

    const unfiled = await store.updateCourse("student-move", course.id, { termId: null });
    expect(unfiled?.termId).toBeNull();
  });

  it("will not let another student move a course into their own term", async () => {
    const fall = await store.createTerm("student-mine", fallInput);
    const { course } = await store.createCourse("student-mine", parsedSyllabus(), fall.id);
    const theirTerm = await store.createTerm("student-theirs", fallInput);

    expect(
      await store.updateCourse("student-theirs", course.id, { termId: theirTerm.id }),
    ).toBeNull();
    expect((await store.getCourse(course.id))?.termId).toBe(fall.id);
  });
});

describe("deleting a term", () => {
  it("keeps the coursework and only drops the reference to the term", async () => {
    const fall = await store.createTerm("student-cascade", fallInput);
    const { course: one } = await store.createCourse(
      "student-cascade",
      parsedSyllabus({ code: "MATH 221" }),
      fall.id,
    );
    const { course: two } = await store.createCourse(
      "student-cascade",
      parsedSyllabus({ code: "HIST 101" }),
      fall.id,
    );

    expect(await store.deleteTerm("student-cascade", fall.id)).toBe(true);

    for (const id of [one.id, two.id]) {
      const after = await store.getCourse(id);
      expect(after).not.toBeNull();
      expect(after?.termId).toBeNull();
      // The syllabus's own words for the term survive as the display fallback.
      expect(after?.term).toBe("Fall 2026");
    }
  });

  it("leaves another student's courses untouched", async () => {
    const mine = await store.createTerm("student-cascade-a", fallInput);
    const theirs = await store.createTerm("student-cascade-b", fallInput);
    const { course: myCourse } = await store.createCourse(
      "student-cascade-a",
      parsedSyllabus(),
      mine.id,
    );
    const { course: theirCourse } = await store.createCourse(
      "student-cascade-b",
      parsedSyllabus(),
      theirs.id,
    );

    await store.deleteTerm("student-cascade-a", mine.id);

    expect((await store.getCourse(myCourse.id))?.termId).toBeNull();
    expect((await store.getCourse(theirCourse.id))?.termId).toBe(theirs.id);
  });
});
