"use client";

import { useState } from "react";

import { apiPost } from "@/components/api-client";
import { Button } from "@/components/ui/button";
import type { DeliveryResult } from "@/lib/alerts";

/**
 * The one interactive thing on the metrics page. Shows the provider's answer
 * verbatim, because a rejection's message ("domain is not verified") is the
 * fix, and hiding it behind "something went wrong" is how this stayed silent.
 */
export function TestAlertButton() {
  const [result, setResult] = useState<DeliveryResult | null>(null);
  const [pending, setPending] = useState(false);

  async function send() {
    setPending(true);
    const response = await apiPost<DeliveryResult>("/api/admin/test-alert");
    setPending(false);
    setResult(
      response.ok ? response.data : { ok: false, status: 0, detail: response.detail ?? response.error },
    );
  }

  return (
    <div className="mt-3">
      <Button size="sm" variant="secondary" disabled={pending} onClick={() => void send()}>
        {pending ? "Sending…" : "Send a test alert"}
      </Button>
      {result ? (
        <p
          className={`mt-2 rounded-md border px-3 py-2 font-mono text-[0.75rem] leading-relaxed ${
            result.ok ? "border-accent-line bg-accent-soft text-ink" : "border-danger-line bg-danger-soft text-ink"
          }`}
        >
          {result.ok
            ? `Sent (HTTP ${result.status}). Check the inbox — and spam, the first time.`
            : `Not sent (HTTP ${result.status || "—"}). ${result.detail ?? "No detail from the provider."}`}
        </p>
      ) : null}
    </div>
  );
}
