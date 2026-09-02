/**
 * Throttled, retrying wrapper around the Notion SDK.
 *
 * Everything in the Notion layer goes through `getNotionClient` rather than
 * touching `@notionhq/client` directly, because three concerns have to be
 * enforced in exactly one place:
 *
 * 1. **Rate.** Notion allows an average of ~3 requests/second per integration
 *    and answers a burst with 429s. One syllabus is ~40 requests, so a single
 *    upload would trip the limit without pacing. A token bucket paces every
 *    call from this client, so callers can write straight-line code.
 *
 * 2. **Retries.** The SDK ships its own retry policy, and it is not the one we
 *    want: it retries 5xx only for idempotent methods, which excludes the
 *    `POST`s and `PATCH`es that make up the entire sync. So the SDK's retries
 *    are switched off (`retry: false`) and this file owns the policy outright
 *    -- one place to reason about, and the throttle sees every real HTTP
 *    attempt rather than the ones the SDK hides inside itself.
 *
 *    Retrying a non-idempotent write on 5xx risks a duplicate page if Notion
 *    failed *after* committing. We accept that: Notion returns 5xx before the
 *    write commits in all but pathological cases, and the alternative -- a
 *    transient blip leaving a deadline with no page at all -- is the worse
 *    failure for a student. Bounded attempts, so a sync inside a request
 *    cannot hang the response.
 *
 * 3. **Revocation.** A Notion token never expires; it only dies when the user
 *    removes the integration, which surfaces as a 401. That is not a per-item
 *    failure -- it means every remaining call will fail too -- so it is
 *    translated into a typed `NotionRevokedError` that callers can catch to
 *    abort and mark the connection `revoked`.
 *
 * **The access token must never reach a log line or an error message.** Notion
 * does not echo it back, but `scrubToken` makes that a guarantee rather than a
 * hope: every message this file produces is filtered before it escapes.
 *
 * Server-only.
 */

import { APIResponseError, Client, LogLevel, isHTTPResponseError } from "@notionhq/client";
import type {
  AppendBlockChildrenParameters,
  AppendBlockChildrenResponse,
  CreateDatabaseParameters,
  CreateDatabaseResponse,
  CreatePageParameters,
  CreatePageResponse,
  GetDataSourceParameters,
  GetDataSourceResponse,
  GetPageParameters,
  GetPageResponse,
  SearchParameters,
  SearchResponse,
  UpdatePageParameters,
  UpdatePageResponse,
} from "@notionhq/client";
import { log } from "@/lib/log";

/** Notion's documented sustained ceiling, per integration. */
const DEFAULT_REQUESTS_PER_SECOND = 3;

/**
 * How many requests may go out back-to-back before pacing kicks in. Notion
 * tolerates a brief burst as long as the *average* holds, and letting the
 * first few calls of a sync fly makes an interactive re-sync feel instant.
 */
const BUCKET_CAPACITY = 3;

/** Total tries per call, including the first. Bounded: a sync runs in a request. */
const MAX_ATTEMPTS = 4;

/** Ceiling on any single backoff, so a hostile `Retry-After` cannot stall a route. */
const MAX_BACKOFF_MS = 15_000;

/** Base for exponential backoff on 5xx. */
const BASE_BACKOFF_MS = 500;

export interface NotionClientOptions {
  /**
   * Sustained request rate. Exposed only so tests can run the same code path
   * without waiting on real-world pacing -- production always wants the
   * default, which is what Notion actually allows.
   */
  requestsPerSecond?: number;
}

/**
 * The user removed the integration (401). Distinct from every other failure
 * because it is terminal for the whole sync, not for one item: callers catch
 * it, mark the connection `revoked`, and stop.
 */
export class NotionRevokedError extends Error {
  readonly name = "NotionRevokedError";

  constructor(message = "Notion access was revoked. Reconnect the integration.") {
    super(message);
  }
}

/** True when `err` means "this connection is dead", not "this call failed". */
export function isRevoked(err: unknown): err is NotionRevokedError {
  return err instanceof NotionRevokedError;
}

/** True when a Notion error means the object is gone (deleted page, stale id). */
export function isNotFound(err: unknown): boolean {
  return statusOf(err) === 404;
}

function statusOf(err: unknown): number | null {
  if (isHTTPResponseError(err)) return err.status;
  return null;
}

/**
 * Human-readable failure text with no secrets in it.
 *
 * `APIResponseError.message` is Notion's own prose ("Could not find page with
 * ID ..."), which is exactly what a student-facing `errors[]` entry wants.
 */
export function describeNotionError(err: unknown, accessToken?: string): string {
  const raw =
    err instanceof APIResponseError
      ? `${err.message} (${err.code})`
      : err instanceof Error
        ? err.message
        : String(err);
  return scrubToken(raw, accessToken);
}

/**
 * Belt and braces: strip the bearer token out of any string on its way to a
 * log or an error. Nothing is *supposed* to put it there; this makes it
 * impossible for a future change to do so by accident.
 */
export function scrubToken(text: string, accessToken?: string): string {
  if (!accessToken || accessToken.length < 8) return text;
  return text.split(accessToken).join("[redacted]");
}

/* -------------------------------------------------------------------------- */
/* Throttle                                                                    */
/* -------------------------------------------------------------------------- */

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Token bucket: `capacity` tokens, refilled continuously at `ratePerSecond`.
 *
 * Continuous refill rather than a per-second window because a windowed counter
 * lets 3 requests land at 0.99s and 3 more at 1.01s -- six in 20ms, which is
 * precisely the burst Notion answers with a 429.
 *
 * Acquisition is serialized through a promise chain so concurrent callers
 * queue in order instead of all reading the same stale token count.
 */
class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly capacity: number,
    private readonly ratePerSecond: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  acquire(): Promise<void> {
    const next = this.tail.then(() => this.take());
    // Swallow rejections on the chain itself: one caller's failure must not
    // poison the queue for everyone behind it.
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(
        this.capacity,
        this.tokens + ((now - this.lastRefill) / 1000) * this.ratePerSecond,
      );
      this.lastRefill = now;

      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }

      await delay(Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1000));
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Retry                                                                       */
/* -------------------------------------------------------------------------- */

/** Notion sends `Retry-After` in seconds on a 429. Returns ms, or null. */
function retryAfterMs(err: unknown): number | null {
  if (!isHTTPResponseError(err)) return null;
  const headers = err.headers;
  let value: string | undefined;

  if (headers instanceof Headers) {
    value = headers.get("retry-after") ?? undefined;
  } else if (typeof headers === "object" && headers !== null) {
    const record = headers as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key.toLowerCase() !== "retry-after") continue;
      const raw = record[key];
      value = Array.isArray(raw) ? String(raw[0]) : String(raw);
      break;
    }
  }

  if (!value) return null;
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  return null;
}

/**
 * 529 ("service overloaded") is Notion-specific and, like 5xx, means "come
 * back shortly".
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 529 || (status >= 500 && status < 600);
}

/* -------------------------------------------------------------------------- */
/* Client                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The slice of the SDK the Notion layer uses. Narrow on purpose: a wrapper
 * that re-exported the whole `Client` would invite a caller to reach past the
 * throttle.
 */
export interface NotionClient {
  readonly pages: {
    create(args: CreatePageParameters): Promise<CreatePageResponse>;
    update(args: UpdatePageParameters): Promise<UpdatePageResponse>;
    retrieve(args: GetPageParameters): Promise<GetPageResponse>;
  };
  readonly blocks: {
    readonly children: {
      append(args: AppendBlockChildrenParameters): Promise<AppendBlockChildrenResponse>;
    };
  };
  readonly databases: {
    create(args: CreateDatabaseParameters): Promise<CreateDatabaseResponse>;
  };
  readonly dataSources: {
    retrieve(args: GetDataSourceParameters): Promise<GetDataSourceResponse>;
  };
  search(args: SearchParameters): Promise<SearchResponse>;
  /** Formats an error for `errors[]` with this client's token scrubbed out. */
  describeError(err: unknown): string;
}

export function getNotionClient(
  accessToken: string,
  options: NotionClientOptions = {},
): NotionClient {
  if (!accessToken) {
    throw new Error("A Notion access token is required to build a client.");
  }

  const rate = options.requestsPerSecond ?? DEFAULT_REQUESTS_PER_SECOND;
  const bucket = new TokenBucket(Math.max(1, Math.min(BUCKET_CAPACITY, rate)), rate);

  const sdk = new Client({
    auth: accessToken,
    // See the file header: we own the retry policy, not the SDK.
    retry: false,
    // The SDK otherwise writes straight to `console`, which bypasses log.ts's
    // redaction and its JSON-per-line format. Routing it through `log` means
    // every line the Notion layer emits went through the same scrubber.
    logLevel: LogLevel.WARN,
    logger: (level, message, extra) => {
      const fields = { source: "notion-sdk", detail: scrubToken(message, accessToken), ...extra };
      if (level === LogLevel.ERROR) log.error("notion.sdk", fields);
      else if (level === LogLevel.WARN) log.warn("notion.sdk", fields);
      else log.debug("notion.sdk", fields);
    },
  });

  /**
   * Every call funnels through here: throttle, attempt, classify, retry.
   * `label` is for logs only -- it never carries user data or the token.
   */
  async function call<T>(label: string, operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await bucket.acquire();
      try {
        return await operation();
      } catch (err) {
        lastError = err;
        const status = statusOf(err);

        // 401 is terminal for the connection, so it short-circuits the retry
        // loop entirely -- retrying a revoked token just burns the budget.
        if (status === 401) {
          log.warn("notion.revoked", { op: label });
          throw new NotionRevokedError();
        }

        if (status === null || !isRetryableStatus(status) || attempt === MAX_ATTEMPTS - 1) {
          throw err;
        }

        // Notion's own advice beats our guess; jitter keeps a batch of failed
        // calls from retrying in lockstep and re-creating the burst.
        const wait =
          retryAfterMs(err) ??
          Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS) +
            Math.floor(Math.random() * 250);

        log.warn("notion.retry", { op: label, status, attempt: attempt + 1, waitMs: wait });
        await delay(wait);
      }
    }

    throw lastError;
  }

  return {
    pages: {
      create: (args) => call("pages.create", () => sdk.pages.create(args)),
      update: (args) => call("pages.update", () => sdk.pages.update(args)),
      retrieve: (args) => call("pages.retrieve", () => sdk.pages.retrieve(args)),
    },
    blocks: {
      children: {
        append: (args) =>
          call("blocks.children.append", () => sdk.blocks.children.append(args)),
      },
    },
    databases: {
      create: (args) => call("databases.create", () => sdk.databases.create(args)),
    },
    dataSources: {
      retrieve: (args) => call("dataSources.retrieve", () => sdk.dataSources.retrieve(args)),
    },
    search: (args) => call("search", () => sdk.search(args)),
    describeError: (err) => describeNotionError(err, accessToken),
  };
}
