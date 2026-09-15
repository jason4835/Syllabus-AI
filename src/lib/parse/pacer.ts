/**
 * Paces model calls to the organization's tokens-per-minute limit.
 *
 * Four syllabi uploaded in the same minute tripped OpenAI's 30,000 TPM limit
 * for gpt-4o (the limit a new organization starts with), and the three that
 * lost the race were read by the pattern-matching fallback, which produced
 * items titled "Tue" and "weeks". A class told to upload their syllabi will
 * do exactly that. So each call first waits for budget: a token bucket per
 * model, sized by `OPENAI_TPM` (default 30,000), refilling continuously.
 *
 * In-process, like the rate limiter, and honest about it the same way: one
 * Railway instance is one bucket, which is the deployment. The bucket is a
 * pacing device, not a guarantee -- OpenAI counts its own way -- which is why
 * the caller still retries a 429 that gets through.
 */

const DEFAULT_TPM = 30_000;
/** Roughly what English prose and JSON cost in tokens. */
const CHARS_PER_TOKEN = 3.6;

interface Bucket {
  tokens: number;
  updatedAt: number;
  /** Waiters hand off in arrival order, so a small request cannot starve a big one. */
  queue: Promise<void>;
}

const buckets = new Map<string, Bucket>();

export function tokensPerMinute(): number {
  const raw = Number(process.env.OPENAI_TPM);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TPM;
}

export function estimateTokens(chars: number, expectedOutputTokens = 2_500): number {
  return Math.ceil(chars / CHARS_PER_TOKEN) + expectedOutputTokens;
}

function bucketFor(model: string): Bucket {
  let b = buckets.get(model);
  if (!b) {
    b = { tokens: tokensPerMinute(), updatedAt: Date.now(), queue: Promise.resolve() };
    buckets.set(model, b);
  }
  return b;
}

function refill(b: Bucket, now: number): void {
  const perMinute = tokensPerMinute();
  b.tokens = Math.min(perMinute, b.tokens + ((now - b.updatedAt) / 60_000) * perMinute);
  b.updatedAt = now;
}

export class PacerTimeout extends Error {
  constructor(public readonly waitedMs: number) {
    super(`Waited ${Math.round(waitedMs / 1000)}s for model capacity and gave up.`);
    this.name = "PacerTimeout";
  }
}

/**
 * Resolves when `tokens` of budget have been taken for `model`, waiting up to
 * `maxWaitMs` for the bucket to refill. A request larger than a full minute's
 * budget is let through once the bucket is full -- there is no size it could
 * wait for -- and OpenAI decides.
 */
export async function acquire(model: string, tokens: number, maxWaitMs: number): Promise<void> {
  const b = bucketFor(model);
  const started = Date.now();
  const turn = b.queue.then(async () => {
    const need = Math.min(tokens, tokensPerMinute());
    for (;;) {
      const now = Date.now();
      refill(b, now);
      if (b.tokens >= need) {
        b.tokens -= need;
        return;
      }
      const deficit = need - b.tokens;
      const waitMs = Math.ceil((deficit / tokensPerMinute()) * 60_000) + 50;
      if (now - started + waitMs > maxWaitMs) throw new PacerTimeout(now - started);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  });
  // The queue must keep moving after a timeout, so the chain swallows it.
  b.queue = turn.catch(() => undefined);
  return turn;
}

/** Test seam: a fresh bucket for a model. */
export function resetPacer(model?: string): void {
  if (model) buckets.delete(model);
  else buckets.clear();
}
