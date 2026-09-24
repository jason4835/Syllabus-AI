import { afterEach, describe, expect, it } from "vitest";

import { foldPaidTerms, foldProfiles, isAdminEmail, isoDaysAgo } from "@/lib/metrics";

describe("foldPaidTerms", () => {
  const TODAY = "2026-09-22";

  it("counts a repeat buyer once as a member and twice as a sale", () => {
    const counts = foldPaidTerms(
      [
        { userId: "u1", premiumExpiresAt: "2026-05-30" },
        { userId: "u1", premiumExpiresAt: "2026-12-28" },
        { userId: "u2", premiumExpiresAt: "2026-12-28" },
      ],
      TODAY,
    );

    expect(counts.payingMembers).toBe(2);
    expect(counts.passesSold).toBe(3);
    // u1's spring pass expired in May; the two autumn ones have not.
    expect(counts.activePasses).toBe(2);
  });

  it("treats the expiry date itself as still active", () => {
    expect(
      foldPaidTerms([{ userId: "u1", premiumExpiresAt: TODAY }], TODAY)
        .activePasses,
    ).toBe(1);
  });

  it("never downgrades a purchase whose expiry was never recorded", () => {
    // A row written before `premium_expires_at` existed. Counting it as
    // expired would report a paying customer as lapsed.
    expect(
      foldPaidTerms([{ userId: "u1", premiumExpiresAt: null }], TODAY)
        .activePasses,
    ).toBe(1);
  });

  it("is all zeroes with nothing sold", () => {
    expect(foldPaidTerms([], TODAY)).toEqual({
      payingMembers: 0,
      passesSold: 0,
      activePasses: 0,
    });
  });
});

describe("isoDaysAgo", () => {
  it("sorts before a timestamp inside the window and after one outside it", () => {
    const now = new Date("2026-09-22T12:00:00.000Z");
    const cutoff = isoDaysAgo(7, now);

    expect("2026-09-20T00:00:00.000Z" >= cutoff).toBe(true);
    expect("2026-09-10T00:00:00.000Z" >= cutoff).toBe(false);
  });
});

describe("isAdminEmail", () => {
  const original = process.env.ADMIN_EMAILS;
  afterEach(() => {
    if (original === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = original;
  });

  it("admits nobody when the allow-list is unset", () => {
    delete process.env.ADMIN_EMAILS;
    expect(isAdminEmail("owner@example.com")).toBe(false);
  });

  it("ignores case and the spaces around a hand-typed list", () => {
    process.env.ADMIN_EMAILS = " Owner@Example.com , second@example.com ";
    expect(isAdminEmail("owner@example.com")).toBe(true);
    expect(isAdminEmail("SECOND@example.com")).toBe(true);
    expect(isAdminEmail("student@example.com")).toBe(false);
  });

  it("refuses a missing email rather than matching an empty entry", () => {
    process.env.ADMIN_EMAILS = "owner@example.com,,";
    expect(isAdminEmail(null)).toBe(false);
    expect(isAdminEmail("")).toBe(false);
  });
});

describe("foldProfiles", () => {
  it("separates answered, skipped and not-yet-asked", () => {
    const out = foldProfiles([
      { completedAt: "t", school: "New York University", year: "junior", source: "ad" },
      { completedAt: "t" }, // completed with nothing filled: a skip
      {}, // never shown the card
    ]);
    expect(out.answered).toBe(1);
    expect(out.skipped).toBe(1);
    expect(out.notAsked).toBe(1);
  });

  it("ranks schools by count, ties alphabetical, capped at ten", () => {
    const profiles = [
      ...Array(3).fill({ completedAt: "t", school: "B University" }),
      ...Array(3).fill({ completedAt: "t", school: "A University" }),
      { completedAt: "t", school: "C University" },
      ...Array.from({ length: 12 }, (_, i) => ({ completedAt: "t", school: `School ${i}` })),
    ];
    const out = foldProfiles(profiles);
    expect(out.topSchools.slice(0, 3).map((r) => r.label)).toEqual(["A University", "B University", "C University"]);
    expect(out.topSchools).toHaveLength(10);
  });

  it("counts non-canonical schools separately and never lists their text", () => {
    const out = foldProfiles([
      { completedAt: "t", schoolOther: "Hogwarts" },
      { completedAt: "t", schoolOther: "Hogwarts" },
    ]);
    expect(out.otherSchools).toBe(2);
    expect(out.answered).toBe(2);
    expect(JSON.stringify(out)).not.toContain("Hogwarts");
  });

  it("is all zeroes and empty lists with nobody", () => {
    expect(foldProfiles([])).toEqual({
      answered: 0,
      skipped: 0,
      notAsked: 0,
      topSchools: [],
      otherSchools: 0,
      byYear: [],
      bySource: [],
    });
  });
});
