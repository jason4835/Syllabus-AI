import { describe, expect, it } from "vitest";

import {
  DEFAULT_WEEKLY_BUDGET_HOURS,
  intensityForHours,
  medianNonZero,
  relativeIntensity,
} from "@/lib/plan/workload";

/**
 * The bug these guard: a one-course semester rendered every week the same
 * green, because the absolute tiers are sized for a five-course load. The
 * week the warning text called "your heaviest" was painted like the week with
 * a third of its work, and the legend's Busy and Crunch never appeared.
 */
describe("relativeIntensity", () => {
  // The exact series from the report: one course, weeks 5-15.
  const weeks = [4, 6, 10, 8, 11, 4, 4, 4, 4, 4, 2];
  const median = medianNonZero(weeks);

  it("takes the median of the non-empty weeks", () => {
    expect(median).toBe(4);
    // Empty weeks (before the term starts) must not drag it to zero.
    expect(medianNonZero([0, 0, 0, 4, 6, 10])).toBe(6);
    expect(medianNonZero([])).toBe(0);
  });

  it("calls the heaviest week a crunch for THIS student", () => {
    expect(relativeIntensity(11, median)).toBe(3);
    expect(relativeIntensity(10, median)).toBe(3);
  });

  it("calls a week well above the usual busy, not crunch", () => {
    expect(relativeIntensity(6, median)).toBe(2); // 1.5x
    expect(relativeIntensity(8, median)).toBe(2); // 2.0x is the boundary, inclusive
  });

  it("has no opinion about an ordinary week", () => {
    expect(relativeIntensity(4, median)).toBe(0);
    expect(relativeIntensity(2, median)).toBe(0);
    expect(relativeIntensity(0, median)).toBe(0);
  });

  it("invents nothing for a flat semester", () => {
    const flat = [5, 5, 5, 5, 5];
    const m = medianNonZero(flat);
    expect(flat.every((h) => relativeIntensity(h, m) === 0)).toBe(true);
  });

  it("only ever raises the absolute tier, never lowers it", () => {
    // A 20h week is a crunch in any semester -- and stays one even when the
    // student's median is 18h and the relative rule is silent.
    const absolute = intensityForHours(20, DEFAULT_WEEKLY_BUDGET_HOURS);
    expect(absolute).toBe(3);
    expect(Math.max(absolute, relativeIntensity(20, 18))).toBe(3);
  });
});
