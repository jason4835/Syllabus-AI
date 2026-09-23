import { afterEach, describe, expect, it } from "vitest";

import { foldPaidTerms, isAdminEmail, isoDaysAgo } from "@/lib/metrics";

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
