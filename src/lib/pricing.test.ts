import { describe, expect, it } from "vitest";

import { TERM_PASS, formatCents } from "@/lib/pricing";

describe("pricing", () => {
  it("shows the Term Pass as one payment at the configured amount", () => {
    expect(TERM_PASS.oneTime).toBe(true);
    expect(formatCents(TERM_PASS.amountCents)).toBe(TERM_PASS.display);
  });
});
