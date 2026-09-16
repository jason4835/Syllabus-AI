/**
 * `POST /api/terms/[id]/checkout` at the route level: who may start a purchase,
 * what Stripe is told, and what the success redirect is worth on its own.
 *
 * The handler is called directly with a mocked session (`@/lib/demo`) and a
 * mocked Stripe (`@/lib/stripe`), so nothing here touches the network and the
 * checkout input can be inspected as the route built it. `DATA_DIR` is set
 * before the store is imported, exactly as in `src/lib/store/local.terms.test.ts`.
 */

import { rm } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ParsedSyllabus } from "@/lib/types";

const DATA_DIR = path.join(
  "/private/tmp/claude-501/-Users-jasonpaz-Documents-Syllabus-AI/1f6e25fc-6f28-4d22-903a-506ae0872d0f/scratchpad/w4b",
  "checkout-route",
);

/**
 * Hoisted so the `vi.mock` factories below (which run before this module's own
 * top-level statements) can close over it: `session` is the visitor the routes
 * see, and `checkoutInputs` records every call Stripe would have received.
 */
const stub = vi.hoisted(() => ({
  session: { userId: "owner-a", isDemo: false, created: false },
  checkoutInputs: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/demo", () => ({
  resolveVisitor: async () => stub.session,
  // The terms list seeds a demo sandbox; there is no sandbox in these tests.
  ensureDemoSeed: async () => {},
  ensureDemoUser: async () => {},
}));

vi.mock("@/lib/stripe", () => ({
  isStripeConfigured: () => true,
  createTermPassCheckout: async (input: Record<string, unknown>) => {
    stub.checkoutInputs.push(input);
    return { sessionId: "cs_test_1", url: "https://checkout.stripe.test/cs_test_1" };
  },
  verifyWebhook: () => {
    throw new Error("verifyWebhook is not part of the checkout route");
  },
}));

type Store = typeof import("@/lib/store")["store"];
let store: Store;
let checkout: typeof import("@/app/api/terms/[id]/checkout/route");
let terms: typeof import("@/app/api/terms/route");
let entitlement: typeof import("@/lib/entitlement");

beforeAll(async () => {
  process.env.DATA_DIR = DATA_DIR;
  process.env.APP_URL = "https://app.test";
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  await rm(DATA_DIR, { recursive: true, force: true });
  ({ store } = await import("@/lib/store"));
  checkout = await import("@/app/api/terms/[id]/checkout/route");
  terms = await import("@/app/api/terms/route");
  entitlement = await import("@/lib/entitlement");
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.APP_URL;
  await rm(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  stub.checkoutInputs.length = 0;
});

/* -------------------------------------------------------------------------- */

function asUser(userId: string, isDemo = false): void {
  stub.session = { userId, isDemo, created: false };
}

async function signedUp(userId: string) {
  return store.upsertUser({
    id: userId,
    email: `${userId}@example.edu`,
    name: "Test Student",
    picture: null,
    googleRefreshToken: null,
  });
}

/** `POST /api/terms/<id>/checkout`, same-origin, as the current session. */
function startCheckout(id: string) {
  return checkout.POST(
    new Request(`https://app.test/api/terms/${id}/checkout`, {
      method: "POST",
      headers: { origin: "https://app.test", host: "app.test" },
    }),
    { params: Promise.resolve({ id }) },
  );
}

const fall = {
  name: "Fall 2026",
  termType: "semester" as const,
  startDate: "2026-09-01",
  endDate: "2026-12-20",
};

/** A confirmed, dated term: the only shape checkout accepts. */
async function confirmedTerm(userId: string) {
  return store.createTerm(userId, { ...fall, confirmedAt: "2026-08-20T00:00:00.000Z" });
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

/* -------------------------------------------------------------------------- */

describe("5. user cannot create checkout for another user's term", () => {
  it("answers 404 to a stranger and never reaches Stripe", async () => {
    await signedUp("owner-a");
    await signedUp("stranger-b");
    const term = await confirmedTerm("owner-a");

    asUser("stranger-b");
    const res = await startCheckout(term.id);

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: "That term was not found.",
    });
    // The point of the case: no session was created for someone else's term.
    expect(stub.checkoutInputs).toEqual([]);
    // And nothing was written to the term on the way out.
    expect((await store.getTerm("owner-a", term.id))?.stripeCheckoutSessionId).toBeNull();
  });

  it("refuses a demo sandbox with sign_in_required before anything else", async () => {
    const term = await confirmedTerm("owner-a");

    asUser("demo_sandbox", true);
    const res = await startCheckout(term.id);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      code: "sign_in_required",
    });
    expect(stub.checkoutInputs).toEqual([]);
  });

  it("refuses an unconfirmed term with 409 until its dates are settled", async () => {
    await signedUp("owner-unconfirmed");
    const term = await store.createTerm("owner-unconfirmed", fall);
    expect(term.confirmedAt).toBeNull();

    asUser("owner-unconfirmed");
    const res = await startCheckout(term.id);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: "Confirm the term's dates first.",
    });
    expect(stub.checkoutInputs).toEqual([]);
  });

  it("gives the owner a session whose metadata, URLs and stored id are their own", async () => {
    await signedUp("owner-happy");
    const term = await confirmedTerm("owner-happy");

    asUser("owner-happy");
    const res = await startCheckout(term.id);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      data: { url: "https://checkout.stripe.test/cs_test_1" },
    });

    // What becomes Stripe's `metadata` -- the webhook reads the grant from these
    // two fields, so they must name the owner and their term, never the caller.
    expect(stub.checkoutInputs).toHaveLength(1);
    expect(stub.checkoutInputs[0]).toEqual({
      userId: "owner-happy",
      termId: term.id,
      customerEmail: "owner-happy@example.edu",
      successUrl: `https://app.test/dashboard?checkout=success&term=${term.id}`,
      cancelUrl: `https://app.test/dashboard?checkout=cancelled&term=${term.id}`,
    });

    // The session id is on the term, so a delivery can be tied back to it.
    expect((await store.getTerm("owner-happy", term.id))?.stripeCheckoutSessionId).toBe(
      "cs_test_1",
    );
    // And starting a checkout grants nothing.
    expect(await store.getTerm("owner-happy", term.id)).toMatchObject({
      premium: false,
      premiumExpiresAt: null,
      paidEndDate: null,
    });
  });

  it("refuses a second pass for a term that already has one", async () => {
    await signedUp("owner-paid");
    const term = await confirmedTerm("owner-paid");
    await store.grantTermPremium("owner-paid", term.id, {
      premiumStartedAt: "2026-09-05T00:00:00.000Z",
      premiumExpiresAt: "2099-01-03",
      paidEndDate: "2026-12-20",
      stripeCheckoutSessionId: "cs_already",
      stripePaymentIntentId: null,
      stripeCustomerId: null,
    });

    asUser("owner-paid");
    const res = await startCheckout(term.id);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: "This term already has a Term Pass.",
    });
    expect(stub.checkoutInputs).toEqual([]);
  });
});

describe("13. checkout success redirect alone does not grant premium", () => {
  it("leaves the term free in GET /api/terms and still refuses a second course", async () => {
    await signedUp("owner-redirect");
    const term = await confirmedTerm("owner-redirect");
    asUser("owner-redirect");

    // The student went to Checkout...
    const started = await startCheckout(term.id);
    expect(started.status).toBe(200);
    expect(stub.checkoutInputs).toHaveLength(1);

    // ...and came back on the success URL. No webhook has been delivered, so
    // the only thing that ever grants premium has not run.
    const listed = await terms.GET();
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      data: { terms: { id: string; access: string; premium: boolean; canAddCourse: boolean }[] };
    };
    const summary = body.data.terms.find((t) => t.id === term.id);
    expect(summary).toBeDefined();
    expect(summary).toMatchObject({ access: "free", premium: false, canAddCourse: true });

    // The free course is still free.
    await store.createCourse("owner-redirect", parsedSyllabus(), term.id);

    // The second one is not: the paywall the upload route answers 402 from is
    // still in force, redirect or no redirect.
    const stored = await store.getTerm("owner-redirect", term.id);
    expect(stored).not.toBeNull();
    await expect(
      entitlement.assertCanAddCourse("owner-redirect", stored!),
    ).rejects.toBeInstanceOf(entitlement.PaywallError);

    // And the list agrees, now that the free slot is used.
    const after = await terms.GET();
    const afterBody = (await after.json()) as {
      data: { terms: { id: string; access: string; courseCount: number; canAddCourse: boolean }[] };
    };
    expect(afterBody.data.terms.find((t) => t.id === term.id)).toMatchObject({
      access: "free",
      courseCount: 1,
      canAddCourse: false,
    });
  });
});
