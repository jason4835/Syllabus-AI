import { describe, expect, it } from "vitest";

import { clientIp, demoSpendVerdict } from "@/lib/api";
import { RULES } from "@/lib/ratelimit";
import { DEMO_USER_PREFIX } from "@/lib/types";

/**
 * The control this exercises is the one that makes every other rate limit on
 * the money routes mean something: a demo sandbox is free to mint, so metering
 * one by user id meters nothing. If these fail, dropping a cookie between
 * requests buys an unlimited number of OpenAI calls.
 */

function req(headers: Record<string, string>): Request {
  return new Request("https://example.com/api/upload", { method: "POST", headers });
}

/** A distinct sandbox id per call -- exactly what an abuser would send. */
function freshDemoUser(): string {
  return DEMO_USER_PREFIX + Math.random().toString(36).slice(2, 12);
}

describe("clientIp", () => {
  it("prefers an edge-set header over the client-writable chain", () => {
    expect(
      clientIp(req({ "x-real-ip": "9.9.9.9", "x-forwarded-for": "1.1.1.1, 2.2.2.2" })),
    ).toBe("9.9.9.9");
  });

  it("takes the LAST hop of x-forwarded-for, not the client's own entry", () => {
    // The first entry is written by the caller. Trusting it would let anyone
    // claim a new address per request and mint an unlimited budget.
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.7, 70.70.70.70" }))).toBe(
      "70.70.70.70",
    );
  });

  it("is null when the host sets no address headers", () => {
    expect(clientIp(req({}))).toBeNull();
  });
});

describe("demoSpendVerdict", () => {
  it("does not meter a signed-in user", () => {
    // Real users are metered by user id, which is strictly better than by IP --
    // and campus NAT means an IP cap on them would punish a whole dorm.
    expect(demoSpendVerdict(req({ "x-real-ip": "10.0.0.1" }), "10881122334455")).toBeNull();
  });

  it("does not meter a request with no determinable IP", () => {
    // Fails open on purpose: a host that stops sending the header should not
    // turn into a site that refuses every visitor.
    expect(demoSpendVerdict(req({}), freshDemoUser())).toBeNull();
  });

  it("counts a fresh sandbox against the SAME budget when the IP repeats", () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    const cap = RULES["demo:ip:burst"].limit;

    // Every request is a brand-new user id, which is what dropping the cookie
    // produces. The budget must not reset with it.
    const verdicts = Array.from({ length: cap + 1 }, () =>
      demoSpendVerdict(req({ "x-real-ip": ip }), freshDemoUser()),
    );

    expect(verdicts.slice(0, cap).every((v) => v?.allowed)).toBe(true);
    expect(verdicts[cap]?.allowed).toBe(false);
  });

  it("keeps one network's spending off another's budget", () => {
    const busy = "198.51.100.240";
    const cap = RULES["demo:ip:burst"].limit;
    for (let i = 0; i <= cap; i += 1) {
      demoSpendVerdict(req({ "x-real-ip": busy }), freshDemoUser());
    }
    expect(demoSpendVerdict(req({ "x-real-ip": busy }), freshDemoUser())?.allowed).toBe(false);
    expect(
      demoSpendVerdict(req({ "x-real-ip": "198.51.100.241" }), freshDemoUser())?.allowed,
    ).toBe(true);
  });
});
