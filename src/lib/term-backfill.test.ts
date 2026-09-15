/**
 * What happens to a student who already had courses when terms did not exist.
 *
 * The promise is grandfathering: nothing they had is taken away, nothing is
 * asked of them, and the paywall applies only to the NEXT course they add. This
 * exercises the real local store against a throwaway `DATA_DIR`, so the module
 * under test is imported dynamically after that variable is set.
 */

import { rm } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { canAddCourse } from "@/lib/terms";
import type { AcademicTerm, Course, ParsedSyllabus } from "@/lib/types";

const DATA_DIR = path.join(
  "/private/tmp/claude-501/-Users-jasonpaz-Documents-Syllabus-AI/1f6e25fc-6f28-4d22-903a-506ae0872d0f/scratchpad/w4",
  "term-backfill",
);

type Store = typeof import("@/lib/store")["store"];
let store: Store;
let ensureTermsBackfilled: (userId: string) => Promise<void>;

beforeAll(async () => {
  process.env.DATA_DIR = DATA_DIR;
  // The local driver is only chosen when there are no Supabase keys around.
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  await rm(DATA_DIR, { recursive: true, force: true });
  ({ store } = await import("@/lib/store"));
  ({ ensureTermsBackfilled } = await import("@/lib/term-backfill"));
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  await rm(DATA_DIR, { recursive: true, force: true });
});

/** A course as it would have been stored before terms existed. */
function oldCourse(course: {
  code: string;
  term: string | null;
  startDate: string | null;
  endDate: string | null;
}): ParsedSyllabus {
  return {
    course: {
      code: course.code,
      title: `${course.code} course`,
      instructor: null,
      term: course.term,
      startDate: course.startDate,
      endDate: course.endDate,
      meetingTimes: [],
      sections: [],
      noClass: [],
      gradeWeights: [],
      policies: [],
    },
    assessments: [],
    warnings: [],
  };
}

function byName(terms: AcademicTerm[], name: string): AcademicTerm {
  const found = terms.find((t) => t.name === name);
  if (!found) throw new Error(`no term named ${name} in [${terms.map((t) => t.name)}]`);
  return found;
}

/* -------------------------------------------------------------------------- */

describe("a student who already had three courses when terms arrived", () => {
  const userId = "returning-student";
  let terms: AcademicTerm[];
  let courses: Course[];

  beforeAll(async () => {
    // Two autumn courses with overlapping dates and the same term label, and one
    // in the spring. None of them has a term row: that is what the old schema
    // looked like.
    await store.createCourse(
      userId,
      oldCourse({
        code: "MATH 221",
        term: "Fall 2026",
        startDate: "2026-09-01",
        endDate: "2026-12-15",
      }),
    );
    await store.createCourse(
      userId,
      oldCourse({
        code: "HIST 101",
        term: "Fall 2026",
        startDate: "2026-09-08",
        endDate: "2026-12-20",
      }),
    );
    await store.createCourse(
      userId,
      oldCourse({
        code: "CHEM 110",
        term: "Spring 2027",
        startDate: "2027-01-15",
        endDate: "2027-05-05",
      }),
    );

    await ensureTermsBackfilled(userId);
    terms = await store.listTerms(userId);
    courses = await store.listCourses(userId);
  });

  it("ends up with one term per label the syllabuses used", () => {
    expect(terms).toHaveLength(2);
    expect(terms.map((t) => t.name).sort()).toEqual(["Fall 2026", "Spring 2027"]);
  });

  it("gives every course a term to belong to", () => {
    expect(courses).toHaveLength(3);
    for (const course of courses) {
      expect(course.termId).not.toBeNull();
    }
  });

  it("puts the two autumn courses in the autumn term and the spring one on its own", () => {
    const fall = byName(terms, "Fall 2026");
    const spring = byName(terms, "Spring 2027");

    const inFall = courses.filter((c) => c.termId === fall.id).map((c) => c.code);
    const inSpring = courses.filter((c) => c.termId === spring.id).map((c) => c.code);

    expect(inFall.sort()).toEqual(["HIST 101", "MATH 221"]);
    expect(inSpring).toEqual(["CHEM 110"]);
  });

  it("spans each term across the whole window its courses cover", () => {
    expect(byName(terms, "Fall 2026")).toMatchObject({
      startDate: "2026-09-01",
      endDate: "2026-12-20",
      termType: "semester",
    });
    expect(byName(terms, "Spring 2027")).toMatchObject({
      startDate: "2027-01-15",
      endDate: "2027-05-05",
    });
  });

  it("lets each migrated course keep its place for free", () => {
    expect(byName(terms, "Fall 2026").freeCourses).toBe(2);
    expect(byName(terms, "Spring 2027").freeCourses).toBe(1);
  });

  it("asks the student nothing: the terms arrive already confirmed", () => {
    for (const term of terms) {
      expect(term.confirmedAt).not.toBeNull();
    }
  });

  it("never grants premium as part of a migration", () => {
    for (const term of terms) {
      expect(term.premium).toBe(false);
      expect(term.premiumExpiresAt).toBeNull();
      expect(term.paidEndDate).toBeNull();
    }
  });

  it("still shows no paywall to the two courses already in the autumn term", () => {
    const fall = byName(terms, "Fall 2026");
    // The allowance is 2, so the second of the migrated courses sat in a free
    // slot: at a count of 1 there is still room, and nothing was taken away.
    expect(canAddCourse(fall, 0)).toEqual({ allowed: true, reason: "free_slot" });
    expect(canAddCourse(fall, 1)).toEqual({ allowed: true, reason: "free_slot" });
  });

  it("charges for the THIRD course added to that autumn term", () => {
    expect(canAddCourse(byName(terms, "Fall 2026"), 2)).toEqual({
      allowed: false,
      reason: "paywall",
    });
  });

  it("charges for the second course in the spring term, which only ever had one", () => {
    expect(canAddCourse(byName(terms, "Spring 2027"), 1)).toEqual({
      allowed: false,
      reason: "paywall",
    });
  });

  it("changes nothing when it runs again", async () => {
    await ensureTermsBackfilled(userId);

    expect(await store.listTerms(userId)).toEqual(terms);
    expect(await store.listCourses(userId)).toEqual(courses);
  });
});

describe("a student whose old courses never said what term they were in", () => {
  const userId = "unlabelled-student";
  let terms: AcademicTerm[];
  let courses: Course[];

  beforeAll(async () => {
    // No labels at all: grouping falls back to overlapping dates, and a January
    // module next to the autumn semester starts its own group.
    await store.createCourse(
      userId,
      oldCourse({ code: "A", term: null, startDate: "2026-09-01", endDate: "2026-12-15" }),
    );
    await store.createCourse(
      userId,
      oldCourse({ code: "B", term: null, startDate: "2026-09-08", endDate: "2026-12-20" }),
    );
    await store.createCourse(
      userId,
      oldCourse({ code: "C", term: null, startDate: "2027-01-04", endDate: "2027-01-22" }),
    );
    await store.createCourse(
      userId,
      oldCourse({ code: "D", term: null, startDate: null, endDate: null }),
    );

    await ensureTermsBackfilled(userId);
    terms = await store.listTerms(userId);
    courses = await store.listCourses(userId);
  });

  it("names the dated groups after their season and the undated one 'My courses'", () => {
    expect(terms.map((t) => t.name).sort()).toEqual(["Fall 2026", "My courses", "Spring 2027"]);
  });

  it("does not sweep a three-week January module into the autumn semester", () => {
    const fall = byName(terms, "Fall 2026");
    const january = byName(terms, "Spring 2027");

    expect(courses.filter((c) => c.termId === fall.id).map((c) => c.code).sort()).toEqual([
      "A",
      "B",
    ]);
    expect(courses.filter((c) => c.termId === january.id).map((c) => c.code)).toEqual(["C"]);
    expect(fall.freeCourses).toBe(2);
    expect(january.freeCourses).toBe(1);
  });

  it("gives the course with no dates at all a dateless term and a setup card to fill in", () => {
    const undated = byName(terms, "My courses");
    expect(undated.startDate).toBeNull();
    expect(undated.endDate).toBeNull();
    expect(undated.termType).toBe("custom");
    expect(courses.filter((c) => c.termId === undated.id).map((c) => c.code)).toEqual(["D"]);
  });
});

describe("a student with nothing to migrate", () => {
  it("creates no terms for a student with no courses", async () => {
    await ensureTermsBackfilled("brand-new-student");
    expect(await store.listTerms("brand-new-student")).toEqual([]);
  });

  it("leaves a course that already has a term alone", async () => {
    const term = await store.createTerm("modern-student", {
      name: "Fall 2026",
      termType: "semester",
      startDate: "2026-09-01",
      endDate: "2026-12-20",
    });
    await store.createCourse(
      "modern-student",
      oldCourse({
        code: "MATH 221",
        term: "Fall 2026",
        startDate: "2026-09-01",
        endDate: "2026-12-20",
      }),
      term.id,
    );

    await ensureTermsBackfilled("modern-student");

    const terms = await store.listTerms("modern-student");
    expect(terms).toHaveLength(1);
    expect(terms[0].id).toBe(term.id);
    expect(terms[0].freeCourses).toBe(1);
  });

  it("clamps a group whose courses span more than six months to a term that could be created", async () => {
    const userId = "long-haul-student";
    // One label, two courses nearly a year apart: the union is longer than a
    // term, and a term that long could not be created at all.
    await store.createCourse(
      userId,
      oldCourse({
        code: "LONG 1",
        term: "Year 2026",
        startDate: "2026-09-01",
        endDate: "2026-12-20",
      }),
    );
    await store.createCourse(
      userId,
      oldCourse({
        code: "LONG 2",
        term: "Year 2026",
        startDate: "2027-06-01",
        endDate: "2027-07-30",
      }),
    );

    await ensureTermsBackfilled(userId);

    const [term] = await store.listTerms(userId);
    expect(term.startDate).toBe("2026-09-01");
    expect(term.endDate).toBe("2027-03-03"); // 183 days, to the day
    expect(term.freeCourses).toBe(2);
  });
});
