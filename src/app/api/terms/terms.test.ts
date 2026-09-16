/**
 * The term collection and item routes at route level: what a term may be when
 * it is created, what a PAID term's dates may become, and when a term may go.
 *
 * Same harness as the checkout tests -- mocked session, `DATA_DIR` set before
 * the store is imported. Stripe is mocked only because the route graph imports
 * it; nothing here starts a checkout.
 */

import { rm } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { premiumExpiresAt } from "@/lib/terms";
import type { ParsedSyllabus } from "@/lib/types";

const DATA_DIR = path.join(
  "/private/tmp/claude-501/-Users-jasonpaz-Documents-Syllabus-AI/1f6e25fc-6f28-4d22-903a-506ae0872d0f/scratchpad/w4b",
  "terms-route",
);

const stub = vi.hoisted(() => ({
  session: { userId: "terms-student", isDemo: false, created: false },
}));

vi.mock("@/lib/demo", () => ({
  resolveVisitor: async () => stub.session,
  ensureDemoSeed: async () => {},
  ensureDemoUser: async () => {},
}));

vi.mock("@/lib/stripe", () => ({
  isStripeConfigured: () => true,
  createTermPassCheckout: async () => ({
    sessionId: "cs_test_1",
    url: "https://checkout.stripe.test/cs_test_1",
  }),
  verifyWebhook: () => {
    throw new Error("verifyWebhook is not part of the term routes");
  },
}));

type Store = typeof import("@/lib/store")["store"];
let store: Store;
let collection: typeof import("@/app/api/terms/route");
let item: typeof import("@/app/api/terms/[id]/route");

beforeAll(async () => {
  process.env.DATA_DIR = DATA_DIR;
  process.env.APP_URL = "https://app.test";
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  await rm(DATA_DIR, { recursive: true, force: true });
  ({ store } = await import("@/lib/store"));
  collection = await import("@/app/api/terms/route");
  item = await import("@/app/api/terms/[id]/route");
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.APP_URL;
  await rm(DATA_DIR, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */

function asUser(userId: string): void {
  stub.session = { userId, isDemo: false, created: false };
}

async function signedUp(userId: string) {
  asUser(userId);
  return store.upsertUser({
    id: userId,
    email: `${userId}@example.edu`,
    name: "Test Student",
    picture: null,
    googleRefreshToken: null,
  });
}

function createTerm(body: unknown) {
  return collection.POST(
    new Request("https://app.test/api/terms", {
      method: "POST",
      headers: { origin: "https://app.test", host: "app.test", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function patchTerm(id: string, body: unknown) {
  return item.PATCH(
    new Request(`https://app.test/api/terms/${id}`, {
      method: "PATCH",
      headers: { origin: "https://app.test", host: "app.test", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

function deleteTerm(id: string) {
  return item.DELETE(
    new Request(`https://app.test/api/terms/${id}`, {
      method: "DELETE",
      headers: { origin: "https://app.test", host: "app.test" },
    }),
    { params: Promise.resolve({ id }) },
  );
}

/** The smallest syllabus the store will accept, so a test can make a course. */
function parsedSyllabus(code = "MATH 221"): ParsedSyllabus {
  return {
    course: {
      code,
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
    },
    assessments: [],
    warnings: [],
  };
}

const fall = {
  name: "Fall 2026",
  termType: "semester" as const,
  startDate: "2026-09-01",
  endDate: "2026-12-20",
};

/** A term that has been paid for, as the webhook would have left it. */
async function premiumTerm(userId: string) {
  const term = await store.createTerm(userId, {
    ...fall,
    confirmedAt: "2026-08-20T00:00:00.000Z",
  });
  const granted = await store.grantTermPremium(userId, term.id, {
    premiumStartedAt: "2026-09-05T00:00:00.000Z",
    premiumExpiresAt: premiumExpiresAt("2026-12-20"),
    paidEndDate: "2026-12-20",
    stripeCheckoutSessionId: "cs_paid",
    stripePaymentIntentId: "pi_paid",
    stripeCustomerId: "cus_paid",
  });
  expect(granted?.premium).toBe(true);
  return granted!;
}

/* -------------------------------------------------------------------------- */

describe("POST /api/terms", () => {
  it("refuses a 200-day term with 422 and says why", async () => {
    await signedUp("too-long-student");

    // 2026-01-01 .. 2026-07-20 is exactly 200 days, past the 183-day cap.
    const res = await createTerm({
      name: "Endless Year",
      termType: "custom",
      startDate: "2026-01-01",
      endDate: "2026-07-20",
    });

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: "Invalid term.",
      detail: "A term can be at most 6 months long.",
    });
    expect(await store.listTerms("too-long-student")).toEqual([]);
  });

  it("creates a term the student typed in, confirmed and with one free course", async () => {
    await signedUp("new-term-student");

    const res = await createTerm(fall);

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { term: { id: string; confirmedAt: string | null; courseCount: number; access: string; canAddCourse: boolean } };
    };
    expect(body.data.term).toMatchObject({
      courseCount: 0,
      access: "free",
      canAddCourse: true,
    });
    expect(body.data.term.confirmedAt).not.toBeNull();
    expect(await store.listTerms("new-term-student")).toHaveLength(1);
  });
});

describe("PATCH /api/terms/[id] on a paid term", () => {
  it("refuses an end date past what was bought with 409, and changes nothing", async () => {
    await signedUp("extend-student");
    const term = await premiumTerm("extend-student");

    // Inside the 183-day rule, so this is the pass's bound talking, not the
    // term-length validator.
    const res = await patchTerm(term.id, { endDate: "2027-03-01" });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("30 days past the 2026-12-20 you bought");
    expect(await store.getTerm("extend-student", term.id)).toEqual(term);
  });

  it("accepts a correction inside the bound and moves the expiry with it", async () => {
    await signedUp("correct-student");
    const term = await premiumTerm("correct-student");

    const res = await patchTerm(term.id, { endDate: "2027-01-10" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { term: { endDate: string; premiumExpiresAt: string; paidEndDate: string; access: string } };
    };
    expect(body.data.term).toMatchObject({
      endDate: "2027-01-10",
      premiumExpiresAt: premiumExpiresAt("2027-01-10"),
      // What was bought is untouched: it is the bound, not a copy of the dates.
      paidEndDate: "2026-12-20",
    });
    expect(await store.getTerm("correct-student", term.id)).toMatchObject({
      endDate: "2027-01-10",
      premiumExpiresAt: "2027-01-24",
    });
  });

  it("moves the expiry earlier when a paid term is shortened", async () => {
    await signedUp("shorten-student");
    const term = await premiumTerm("shorten-student");

    const res = await patchTerm(term.id, { endDate: "2026-11-30" });

    expect(res.status).toBe(200);
    expect(await store.getTerm("shorten-student", term.id)).toMatchObject({
      endDate: "2026-11-30",
      premiumExpiresAt: premiumExpiresAt("2026-11-30"),
    });
  });
});

describe("DELETE /api/terms/[id]", () => {
  it("refuses a term that still holds a course with 409", async () => {
    await signedUp("holder-student");
    const term = await store.createTerm("holder-student", {
      ...fall,
      confirmedAt: "2026-08-20T00:00:00.000Z",
    });
    const { course } = await store.createCourse("holder-student", parsedSyllabus(), term.id);

    const res = await deleteTerm(term.id);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: "Move or delete its courses first.",
    });
    // Neither the term nor the coursework moved.
    expect(await store.getTerm("holder-student", term.id)).toEqual(term);
    expect((await store.getCourse(course.id))?.termId).toBe(term.id);
  });

  it("deletes an empty term", async () => {
    await signedUp("empty-term-student");
    const term = await store.createTerm("empty-term-student", fall);

    const res = await deleteTerm(term.id);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, data: { deleted: true } });
    expect(await store.getTerm("empty-term-student", term.id)).toBeNull();
  });
});
