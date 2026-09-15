/**
 * `POST /api/stripe/webhook` at the route level: the only path that grants
 * premium, and the three ways it must refuse to.
 *
 * `@/lib/stripe` is mocked so `verifyWebhook` accepts exactly one signature
 * ("valid") and otherwise throws, which is the whole security property this
 * route rests on -- an unverified body must reach nothing. `DATA_DIR` is set
 * before the store is imported, as in `src/lib/store/local.terms.test.ts`.
 */

import { rm } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { premiumExpiresAt } from "@/lib/terms";

const DATA_DIR = path.join(
  "/private/tmp/claude-501/-Users-jasonpaz-Documents-Syllabus-AI/1f6e25fc-6f28-4d22-903a-506ae0872d0f/scratchpad/w4b",
  "webhook-route",
);

const stub = vi.hoisted(() => ({
  session: { userId: "webhook-user", isDemo: false, created: false },
}));

// The webhook itself has no session -- Stripe is not a browser -- but the module
// graph pulls `@/lib/demo` in, and it must not try to read a cookie.
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
  /** One signature is real. Everything else is somebody with the URL. */
  verifyWebhook: (raw: string, signature: string | null) => {
    if (signature !== "valid") throw new Error("Webhook signature verification failed.");
    return JSON.parse(raw);
  },
}));

type Store = typeof import("@/lib/store")["store"];
let store: Store;
let webhook: typeof import("@/app/api/stripe/webhook/route");

beforeAll(async () => {
  process.env.DATA_DIR = DATA_DIR;
  process.env.APP_URL = "https://app.test";
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  await rm(DATA_DIR, { recursive: true, force: true });
  ({ store } = await import("@/lib/store"));
  webhook = await import("@/app/api/stripe/webhook/route");
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.APP_URL;
  await rm(DATA_DIR, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */

const fall = {
  name: "Fall 2026",
  termType: "semester" as const,
  startDate: "2026-09-01",
  endDate: "2026-12-20",
};

async function paidableTerm(userId: string) {
  await store.upsertUser({
    id: userId,
    email: `${userId}@example.edu`,
    name: "Test Student",
    picture: null,
    googleRefreshToken: null,
  });
  return store.createTerm(userId, { ...fall, confirmedAt: "2026-08-20T00:00:00.000Z" });
}

/** A `checkout.session.completed` event as Stripe would send it. */
function completedEvent(opts: {
  eventId: string;
  userId: string;
  termId: string;
  sessionId?: string;
}) {
  return {
    id: opts.eventId,
    type: "checkout.session.completed",
    data: {
      object: {
        id: opts.sessionId ?? "cs_1",
        object: "checkout.session",
        payment_status: "paid",
        payment_intent: "pi_1",
        customer: "cus_1",
        amount_total: 599,
        currency: "usd",
        client_reference_id: opts.termId,
        metadata: { user_id: opts.userId, term_id: opts.termId },
      },
    },
  };
}

/** Delivers one event body under one signature header. */
function deliver(body: unknown, signature: string | null) {
  return webhook.POST(
    new Request("https://app.test/api/stripe/webhook", {
      method: "POST",
      headers: signature === null ? {} : { "stripe-signature": signature },
      body: JSON.stringify(body),
    }),
  );
}

/* -------------------------------------------------------------------------- */

describe("6. successful verified webhook grants premium access", () => {
  it("marks the term premium with the expiry, paid end date and Stripe ids", async () => {
    const term = await paidableTerm("paid-student");

    const res = await deliver(
      completedEvent({ eventId: "evt_1", userId: "paid-student", termId: term.id }),
      "valid",
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, data: { received: true } });

    const after = await store.getTerm("paid-student", term.id);
    expect(after).toMatchObject({
      premium: true,
      // The grace arithmetic lives in one place; this is that place's answer.
      premiumExpiresAt: premiumExpiresAt(term.endDate!),
      paidEndDate: term.endDate,
      stripeCheckoutSessionId: "cs_1",
      stripePaymentIntentId: "pi_1",
      stripeCustomerId: "cus_1",
    });
    expect(after?.premiumStartedAt).not.toBeNull();
  });
});

describe("7. fake/unverified webhook does not grant access", () => {
  it("answers 400 to a forged signature and leaves the term alone", async () => {
    const term = await paidableTerm("forged-student");

    const res = await deliver(
      completedEvent({ eventId: "evt_forged", userId: "forged-student", termId: term.id }),
      "forged",
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: "Webhook signature verification failed.",
    });
    expect(await store.getTerm("forged-student", term.id)).toEqual(term);
  });

  it("answers 400 when there is no signature header at all", async () => {
    const term = await paidableTerm("unsigned-student");

    const res = await deliver(
      completedEvent({ eventId: "evt_unsigned", userId: "unsigned-student", termId: term.id }),
      null,
    );

    expect(res.status).toBe(400);
    expect(await store.getTerm("unsigned-student", term.id)).toEqual(term);
  });

  it("does not record an unverified event, so a real delivery still lands", async () => {
    const term = await paidableTerm("retry-student");
    const event = completedEvent({
      eventId: "evt_retry",
      userId: "retry-student",
      termId: term.id,
    });

    expect((await deliver(event, "forged")).status).toBe(400);

    // The forged attempt claimed nothing: the same event id, properly signed,
    // is still fresh and still grants the pass.
    const real = await deliver(event, "valid");
    expect(real.status).toBe(200);
    await expect(real.json()).resolves.toEqual({ ok: true, data: { received: true } });
    expect((await store.getTerm("retry-student", term.id))?.premium).toBe(true);
  });
});

describe("8. repeated Stripe webhook event is idempotent", () => {
  it("answers the second delivery of one event with duplicate: true", async () => {
    const term = await paidableTerm("twice-student");
    const event = completedEvent({
      eventId: "evt_twice",
      userId: "twice-student",
      termId: term.id,
    });

    const first = await deliver(event, "valid");
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ ok: true, data: { received: true } });

    const second = await deliver(event, "valid");
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({
      ok: true,
      data: { received: true, duplicate: true },
    });
  });

  it("leaves premiumStartedAt untouched when a second, different event arrives", async () => {
    const term = await paidableTerm("second-event-student");
    await deliver(
      completedEvent({
        eventId: "evt_first",
        userId: "second-event-student",
        termId: term.id,
        sessionId: "cs_first",
      }),
      "valid",
    );
    const granted = await store.getTerm("second-event-student", term.id);
    expect(granted?.premium).toBe(true);

    // A new event id, so the event table lets it through -- the term's own paid
    // state is what stops it.
    const res = await deliver(
      completedEvent({
        eventId: "evt_2",
        userId: "second-event-student",
        termId: term.id,
        sessionId: "cs_second",
      }),
      "valid",
    );
    expect(res.status).toBe(200);

    const after = await store.getTerm("second-event-student", term.id);
    expect(after?.premiumStartedAt).toBe(granted?.premiumStartedAt);
    expect(after?.premiumExpiresAt).toBe(granted?.premiumExpiresAt);
    expect(after?.stripeCheckoutSessionId).toBe("cs_first");
  });

  it("acknowledges an event naming somebody else's term without granting it", async () => {
    const term = await paidableTerm("victim-student");
    await store.upsertUser({
      id: "attacker-student",
      email: "attacker-student@example.edu",
      name: "Test Student",
      picture: null,
      googleRefreshToken: null,
    });

    // `user_id` is the attacker, `term_id` is the victim's term: the grant is
    // scoped by owner, so this pair matches no term at all.
    const res = await deliver(
      completedEvent({
        eventId: "evt_stranger",
        userId: "attacker-student",
        termId: term.id,
        sessionId: "cs_stranger",
      }),
      "valid",
    );

    // 200 because no retry could improve it, and nothing was granted.
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, data: { received: true } });
    expect(await store.getTerm("victim-student", term.id)).toEqual(term);
    expect(await store.listTerms("attacker-student")).toEqual([]);
  });

  it("acknowledges a completed session that has not been paid, without granting", async () => {
    const term = await paidableTerm("unpaid-student");
    const event = completedEvent({
      eventId: "evt_unpaid",
      userId: "unpaid-student",
      termId: term.id,
    });
    event.data.object.payment_status = "unpaid";

    const res = await deliver(event, "valid");

    expect(res.status).toBe(200);
    expect((await store.getTerm("unpaid-student", term.id))?.premium).toBe(false);
  });
});
