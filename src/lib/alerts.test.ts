import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { maybeAlert, shouldAlert } from "@/lib/alerts";
import { logApiError } from "@/lib/log";
import { sweepExpired } from "@/lib/ratelimit";

function setNodeEnv(value: string): void {
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

/**
 * Two things are worth pinning down here, and neither is the HTTP call.
 *
 * WHICH lines alert: a severity threshold alone would silently miss every
 * money event, because they are all logged at `warn`.
 *
 * And HOW OFTEN: an alerter with no cooldown turns one broken route into a
 * thousand identical emails, which teaches the operator to filter the alert
 * address to trash. That failure is worse than having no alerting, and it is
 * invisible until the day it matters.
 */

describe("shouldAlert", () => {
  it("alerts on every error", () => {
    expect(shouldAlert("error", "anything.at.all")).toBe(true);
  });

  it("ignores ordinary info and warn lines", () => {
    expect(shouldAlert("info", "upload.received")).toBe(false);
    expect(shouldAlert("warn", "notion.rate_limited")).toBe(false);
    expect(shouldAlert("debug", "analytics.posthog_failed")).toBe(false);
  });

  it("alerts on the money warnings a severity threshold would miss", () => {
    // Every one of these is logged at `warn`, and every one means a student
    // was charged and something did not happen. This is the whole reason the
    // allow-list exists.
    for (const event of [
      "stripe.webhook_grant_missed",
      "stripe.webhook_term_not_found",
      "stripe.webhook_term_without_end_date",
      "stripe.webhook_missing_metadata",
      "stripe.webhook_unverified",
    ]) {
      expect(shouldAlert("warn", event)).toBe(true);
    }
  });
});

describe("maybeAlert", () => {
  const env = { ...process.env };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sweepExpired(Date.now() + 48 * 60 * 60 * 1000); // clear every cooldown window
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    process.env.RESEND_API_KEY = "re_test";
    process.env.ALERT_EMAIL_TO = "owner@example.com";
    // The module skips sending under NODE_ENV=test, which vitest sets -- that
    // guard is what stops a normal `npm test` emailing anybody. The cast is
    // because @types/node declares NODE_ENV readonly; assigning it is exactly
    // what these tests need to do.
    setNodeEnv("production");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...env };
  });

  function sent() {
    return fetchMock.mock.calls.map((call) => JSON.parse(String(call[1].body)));
  }

  it("sends one email for a critical event", () => {
    maybeAlert("warn", "stripe.webhook_grant_missed", { userId: "u1", termId: "t1" });
    expect(sent()).toHaveLength(1);
    expect(sent()[0].subject).toBe("[Syllabus Center] stripe.webhook_grant_missed");
    expect(sent()[0].to).toEqual(["owner@example.com"]);
    // The body has to carry the ids, or the operator cannot act on it.
    expect(sent()[0].text).toContain("u1");
    expect(sent()[0].text).toContain("t1");
    // ...and what to actually do about it.
    expect(sent()[0].text).toContain("premium was NOT granted");
  });

  it("sends once per hour for a repeating event, not once per occurrence", () => {
    for (let i = 0; i < 50; i += 1) {
      maybeAlert("error", "courses.list_failed", { attempt: i });
    }
    expect(sent()).toHaveLength(1);
  });

  it("still lets a DIFFERENT event through while one is cooling down", () => {
    maybeAlert("error", "courses.list_failed", {});
    maybeAlert("warn", "stripe.webhook_grant_missed", {});
    expect(sent().map((m) => m.subject)).toEqual([
      "[Syllabus Center] courses.list_failed",
      "[Syllabus Center] stripe.webhook_grant_missed",
    ]);
  });

  it("caps a broad outage so a bad deploy cannot flood the inbox", () => {
    // Distinct event names, so every one passes its own cooldown -- exactly
    // what a deploy that breaks everything at once looks like.
    for (let i = 0; i < 60; i += 1) {
      maybeAlert("error", `route_${i}.failed`, {});
    }
    expect(sent().length).toBeLessThanOrEqual(20);
    expect(sent().length).toBeGreaterThan(0);
  });

  it("does nothing at all when unconfigured", () => {
    delete process.env.RESEND_API_KEY;
    maybeAlert("error", "courses.list_failed", {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws when the provider is down", async () => {
    fetchMock.mockRejectedValue(new Error("network is gone"));
    expect(() => maybeAlert("error", "courses.list_failed", {})).not.toThrow();
    // The rejection is handled inside the module, not left unhandled.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("is reached by the logger itself, not just by direct calls", () => {
    // The seam that matters: alerting hangs off `log.emit`, so a route that
    // calls `logApiError` is covered without knowing alerting exists. If this
    // breaks, every unit test above still passes and nothing alerts.
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      logApiError("sync.failed", new Error("calendar exploded"), { userId: "u9" });
    } finally {
      spy.mockRestore();
    }

    expect(sent()).toHaveLength(1);
    expect(sent()[0].subject).toBe("[Syllabus Center] sync.failed");
    expect(sent()[0].text).toContain("calendar exploded");
    expect(sent()[0].text).toContain("u9");
  });

  it("sends the REDACTED fields, never the raw ones", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      logApiError("auth.callback_failed", new Error("bad grant"), {
        userId: "u1",
        googleRefreshToken: "1//0gSUPERSECRETTOKENVALUE",
      });
    } finally {
      spy.mockRestore();
    }

    // `emit` redacts before alerting, so the inbox is protected by the same
    // pass that protects the log drain -- an alert email is a copy of a log
    // line sent somewhere less controlled, and is the last place a token
    // should surface.
    const text = sent()[0].text;
    expect(text).not.toContain("SUPERSECRET");
    expect(text).toContain("u1");
  });

  it("does not email during a test run", () => {
    setNodeEnv("test");
    maybeAlert("error", "courses.list_failed", {});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
