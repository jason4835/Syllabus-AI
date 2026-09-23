import { describe, expect, it } from "vitest";

import { SCHOOLS, canonicalSchool, findSchools, normalizeSchool } from "@/lib/schools";
import { US_SCHOOL_NAMES } from "@/lib/schools.data";

/**
 * The complaint this guards: "we don't want 100 variations of NYU". Every
 * spelling a student is likely to type has to land on ONE stored value, and
 * anything that matches nothing must not be silently stored as if it did.
 */
describe("canonicalSchool", () => {
  it("collapses every common spelling of one school onto its canonical name", () => {
    for (const typed of [
      "nyu",
      "NYU",
      "N.Y.U.",
      "New York University",
      "new york university",
      "NYU Gallatin",
      "nyu stern",
    ]) {
      expect(canonicalSchool(typed)).toBe("New York University");
    }
  });

  it("forgives articles, punctuation and 'univ.'", () => {
    expect(canonicalSchool("The Univ. of Texas at Austin")).toBe(
      "The University of Texas at Austin",
    );
    expect(canonicalSchool("ut austin")).toBe("The University of Texas at Austin");
    expect(canonicalSchool("texas a and m")).toBe("Texas A&M University - College Station");
    // "&" normalises to "and", so the way students actually type it matches too.
    expect(canonicalSchool("Texas A&M")).toBe("Texas A&M University - College Station");
    expect(canonicalSchool("U.C.L.A.")).toBe("University of California, Los Angeles");
  });

  it("returns null for anything not on the list, rather than guessing", () => {
    expect(canonicalSchool("Hogwarts")).toBeNull();
    expect(canonicalSchool("")).toBeNull();
    expect(canonicalSchool("   ")).toBeNull();
  });

  it("stores the list's spelling, never the student's", () => {
    // Alias lookup must never leak the alias back out as the stored value.
    expect(canonicalSchool("ucla")).toBe("University of California, Los Angeles");
  });
});

describe("the list is the whole country, not the famous few", () => {
  it("is thousands of schools", () => {
    expect(SCHOOLS.length).toBeGreaterThan(2000);
  });

  it("finds Adelphi from 'Adel' -- the exact case that was missing", () => {
    expect(findSchools("Adel")[0]).toBe("Adelphi University");
    expect(canonicalSchool("adelphi university")).toBe("Adelphi University");
  });

  it("finds a small school nobody would think to alias", () => {
    expect(findSchools("Abilene")[0]).toBe("Abilene Christian University");
  });

  it("every alias points at the DATASET's spelling, not a second one", () => {
    // Otherwise "ohio state" stores "Ohio State University" while a student who
    // picked from the dropdown stores "Ohio State University - Columbus" --
    // two rows for one school, which is the exact thing this list exists to
    // prevent.
    const dataset = new Set(US_SCHOOL_NAMES);
    for (const school of SCHOOLS) {
      if (school.aliases) expect(dataset.has(school.name), school.name).toBe(true);
    }
  });
});

describe("normalizeSchool", () => {
  it("is idempotent", () => {
    const once = normalizeSchool("The University of Michigan");
    expect(normalizeSchool(once)).toBe(once);
  });
});

describe("findSchools", () => {
  it("puts prefix matches before substring matches", () => {
    // "uni" prefixes "University of ..." and merely appears inside
    // "Boston University"; the former must come first or the dropdown is
    // useless for the most common thing anyone types.
    const results = findSchools("univ");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].startsWith("University") || results[0].startsWith("The University")).toBe(true);
  });

  it("finds by alias", () => {
    expect(findSchools("nyu")).toContain("New York University");
    expect(findSchools("mit")[0]).toBe("Massachusetts Institute of Technology");
  });

  it("needs two characters and caps the list", () => {
    expect(findSchools("n")).toEqual([]);
    expect(findSchools("un").length).toBeLessThanOrEqual(8);
  });
});
