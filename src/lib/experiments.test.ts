import { describe, expect, it } from "vitest";

import {
  EXPERIMENTS,
  assignmentsFor,
  bucketOf,
  variantOf,
} from "@/lib/experiments";

/**
 * The property that matters most is stickiness. A student quoted $5.99 who
 * comes back tomorrow and is quoted $7.99 is a support email at best and a
 * consumer-protection problem at worst, so "same subject, same answer, forever"
 * is the thing under test -- not the distribution.
 */
describe("variantOf", () => {
  it("gives the same subject the same variant every time", () => {
    const first = variantOf("termPassPrice", "user-123");
    for (let i = 0; i < 50; i += 1) {
      expect(variantOf("termPassPrice", "user-123")).toBe(first);
    }
  });

  it("buckets one subject independently per experiment", () => {
    // Same id, different experiment keys -- a person in the "higher" price arm
    // must not be forced into a matching arm of every other test, or the two
    // results become impossible to read apart.
    const subject = "user-123";
    const seen = new Set(
      ["paywallCopy", "termPassPrice", "landingHero"].map((name) =>
        `${name}:${variantOf(name as "paywallCopy", subject)}`,
      ),
    );
    expect(seen.size).toBe(3);
  });

  it("falls back to the control when there is no subject yet", () => {
    for (const [name, experiment] of Object.entries(EXPERIMENTS)) {
      const control = experiment.variants[0];
      expect(variantOf(name as "paywallCopy", null)).toBe(control);
      expect(variantOf(name as "paywallCopy", "")).toBe(control);
    }
  });

  it("only ever returns a declared variant", () => {
    for (let i = 0; i < 500; i += 1) {
      const assigned = variantOf("paywallCopy", `subject-${i}`);
      expect(EXPERIMENTS.paywallCopy.variants).toContain(assigned);
    }
  });

  it("splits roughly evenly, so a test can actually reach significance", () => {
    let higher = 0;
    const n = 4000;
    for (let i = 0; i < n; i += 1) {
      if (variantOf("termPassPrice", `student-${i}`) === "higher") higher += 1;
    }
    // A hash with a hot spot would silently make one arm tiny and the
    // experiment unreadable. 45-55% is loose enough never to flake.
    expect(higher / n).toBeGreaterThan(0.45);
    expect(higher / n).toBeLessThan(0.55);
  });
});

/**
 * Regression: the split must not depend on the SHAPE of the subject id.
 *
 * Before `fmix32` was added to the hash, every one-character id landed in the
 * control arm of every experiment -- FNV-1a moves its high bits least, and
 * `bucketOf` decides a two-arm experiment on the single most significant one.
 * Real ids were near enough to even that the data would never have shown it;
 * an experiment silently running at 60/40 just takes longer to conclude.
 *
 * Each shape below is one the app actually buckets on, or one close enough to
 * catch the same class of failure.
 */
describe("bucketing is fair for every id shape", () => {
  const shapes: Record<string, (i: number) => string> = {
    // Google `sub`: 21 digits, and accounts made around the same time share a
    // long prefix -- so nearly all the entropy is in the last few characters.
    "google sub": (i) => `10881122334455${String(600000 + i).padStart(7, "0")}`,
    // The anonymous visitor cookie set by middleware.ts.
    uuid: (i) => `3f2b${String(i).padStart(8, "0")}-1111-4222-8333-44445555${String(i % 10000).padStart(4, "0")}`,
    // Demo sandbox ids: a fixed prefix plus base64url.
    "demo sandbox": (i) => `demo_AAAAAAAAAAAAAAAAAAAAAA${String(i).padStart(6, "0")}`,
    sequential: (i) => `user-${i}`,
    "very short": (i) => String.fromCharCode(97 + (i % 26)) + (i > 25 ? String(i) : ""),
  };

  for (const [shape, make] of Object.entries(shapes)) {
    it(`splits ${shape} ids evenly`, () => {
      const n = 3000;
      let higher = 0;
      for (let i = 0; i < n; i += 1) {
        if (variantOf("termPassPrice", make(i)) === "higher") higher += 1;
      }
      const share = higher / n;
      expect(share).toBeGreaterThan(0.44);
      expect(share).toBeLessThan(0.56);
    });
  }
});

describe("bucketOf", () => {
  it("stays inside [0, 1)", () => {
    for (let i = 0; i < 1000; i += 1) {
      const bucket = bucketOf("term_pass_price", `subject-${i}`);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(1);
    }
  });
});

describe("assignmentsFor", () => {
  it("returns one entry per declared experiment, keyed by wire key", () => {
    const assignments = assignmentsFor("user-123");
    expect(Object.keys(assignments).sort()).toEqual(
      Object.values(EXPERIMENTS).map((e) => e.key).sort(),
    );
  });

  it("agrees with variantOf", () => {
    expect(assignmentsFor("user-123")[EXPERIMENTS.termPassPrice.key]).toBe(
      variantOf("termPassPrice", "user-123"),
    );
  });
});
