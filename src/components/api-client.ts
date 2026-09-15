import type { AcademicTerm, ApiResult } from "@/lib/types";
import type { TermAccess } from "@/lib/terms";

/**
 * Every call funnels through here so a missing, half-deployed or erroring API
 * degrades into a normal `{ ok: false }` result instead of an unhandled
 * rejection. The dashboard then renders its empty/error states as designed.
 */

/**
 * What the paywall is allowed to print. The amount comes from the server
 * (`src/lib/pricing.ts`) rather than from any string in the client, so the
 * number a student reads is the number Stripe was configured with -- see
 * docs/TERM-PASS.md.
 */
export interface TermPassDisplay {
  name: string;
  amountCents: number;
  currency: string;
  display: string;
  oneTime: boolean;
}

export interface BillingConfig {
  /** False when this server has no Stripe keys; the card then offers no button. */
  ready: boolean;
  termPass: TermPassDisplay;
}

export interface AppConfig {
  demoMode: boolean;
  googleReady: boolean;
  openaiReady: boolean;
  /**
   * Optional rather than required, for the same reason `UploadResult.notion`
   * is: a server that has not shipped the billing half of `/api/config` simply
   * omits the key, and the honest reading of "no billing information" is "no
   * payments configured" -- which is exactly the variant the paywall card shows.
   * Never defaulted to a hard-coded price: nothing in the client says 5.99.
   */
  billing?: BillingConfig;
}

/**
 * A term as `GET /api/terms` hands it over: the row, plus the three things only
 * the server can count or decide. `access` and `canAddCourse` are `termAccess`
 * and `canAddCourse` from `@/lib/terms` already applied, so the UI never has to
 * re-derive entitlement from a clock the server did not use.
 *
 * Defined here rather than imported from the server's entitlement module on
 * purpose: that module reaches the store, and a value import of it would pull
 * the whole persistence layer into the browser bundle.
 */
export type TermSummary = AcademicTerm & {
  courseCount: number;
  access: TermAccess;
  canAddCourse: boolean;
};

/** The body of the 402 the upload and course routes answer a full free term with. */
export interface Paywall {
  term: TermSummary;
  courseCount: number;
}

/**
 * A failed call. `paywall` rides along on the 402 exactly as `duplicateOf` does
 * on the upload route's 409: the envelope hands back whatever the server sent,
 * so the extra key survives -- this only gives it a name.
 */
export interface ApiFailure {
  ok: false;
  error: string;
  detail?: string;
  paywall?: Paywall;
}

export type ClientResult<T> = { ok: true; data: T } | ApiFailure;

/**
 * The paywall body, read defensively. A server that has not shipped the 402
 * yet, or one answering a plain 402 from a proxy, must read as an ordinary
 * failure rather than render a card with an undefined term in it.
 */
export function paywallOf(result: unknown): Paywall | null {
  if (typeof result !== "object" || result === null) return null;
  const value = (result as { paywall?: unknown }).paywall;
  if (typeof value !== "object" || value === null) return null;
  const record = value as { term?: unknown; courseCount?: unknown };
  const term = record.term;
  if (typeof term !== "object" || term === null) return null;
  if (typeof (term as { id?: unknown }).id !== "string") return null;
  return {
    term: term as TermSummary,
    courseCount:
      typeof record.courseCount === "number" && Number.isFinite(record.courseCount)
        ? record.courseCount
        : 0,
  };
}

/** The `code` a route puts on a refusal it wants the UI to branch on ("sign_in_required"). */
export function errorCodeOf(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const code = (result as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

/**
 * One funnel event, fired and forgotten. `apiPost` never rejects, so there is
 * nothing to catch and nothing a student could do with the news that an
 * analytics line did not land.
 */
export function trackEvent(
  event: string,
  fields?: Record<string, unknown>,
): void {
  void apiPost("/api/analytics", { event, ...(fields ? { fields } : {}) });
}

export type ChatRole = "user" | "assistant";

export interface ChatTurn {
  role: ChatRole;
  content: string;
}

function isApiResult(value: unknown): value is ApiResult<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.ok === true) return "data" in record;
  return record.ok === false && typeof record.error === "string";
}

/**
 * There used to be three of these -- "unexpected response", "unexpected
 * response shape", "unreadable response" -- and no reader could act on the
 * difference between them. One sentence, because from the outside it is one
 * situation: the server said something this app cannot use.
 */
const WIRE_FAILURE = "The server sent a reply this app could not read";

/**
 * A response body is only shown to a person when it reads like a message. A
 * gateway answers a 502 with a full HTML page, and pasting `<html><head><title>`
 * into the error box tells a student nothing and looks broken -- so any body
 * carrying markup is dropped and the status line stands alone.
 */
function readableDetail(body: string): string | undefined {
  const trimmed = body.slice(0, 180).trim();
  if (!trimmed || trimmed.includes("<")) return undefined;
  return trimmed;
}

async function envelope<T>(request: Promise<Response>): Promise<ClientResult<T>> {
  let response: Response;
  try {
    response = await request;
  } catch {
    return {
      ok: false,
      error: "Could not reach the server",
      detail: "Check your connection and try again.",
    };
  }

  let body: string;
  try {
    body = await response.text();
  } catch {
    return { ok: false, error: WIRE_FAILURE };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return {
      ok: false,
      error: response.ok
        ? WIRE_FAILURE
        : `Request failed (${response.status})`,
      detail: readableDetail(body),
    };
  }

  if (isApiResult(parsed)) return parsed as ClientResult<T>;
  return { ok: false, error: WIRE_FAILURE };
}

export function apiGet<T>(path: string): Promise<ClientResult<T>> {
  return envelope<T>(
    fetch(path, { headers: { Accept: "application/json" }, cache: "no-store" }),
  );
}

export function apiPost<T>(path: string, body?: unknown): Promise<ClientResult<T>> {
  return envelope<T>(
    fetch(path, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
    }),
  );
}

/** Partial updates — the row editor and its Confirm button both come through here. */
export function apiPatch<T>(path: string, body: unknown): Promise<ClientResult<T>> {
  return envelope<T>(
    fetch(path, {
      method: "PATCH",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
    }),
  );
}

/** Same envelope as the rest — a DELETE that 404s still degrades to `ok: false`. */
export function apiDelete<T>(path: string, body?: unknown): Promise<ClientResult<T>> {
  return envelope<T>(
    fetch(path, {
      method: "DELETE",
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

/**
 * Reads the wait out of a rate-limit message ("Try again in 40 seconds.",
 * "The limit resets in 3 minutes."). Returns null for anything else, so an
 * ordinary failure never locks a button.
 *
 * It lives here because the envelope is where a 429 lands: the shared client
 * hands panels the message, not the `Retry-After` header, so every panel that
 * wants a countdown has to read the same sentence. Calendar sync and the
 * Notion sync both do.
 */
export function parseRetryAfterSeconds(
  ...messages: (string | undefined | null)[]
): number | null {
  const text = messages.filter(Boolean).join(" ");
  const match = /in (?:about )?(\d+) (second|minute|hour)s?/i.exec(text);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2].toLowerCase();
  const seconds = unit === "hour" ? 3600 : unit === "minute" ? 60 : 1;
  return amount * seconds;
}

export interface UploadHandlers {
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
  /**
   * How long to wait before giving up, in milliseconds. A syllabus that has
   * stopped moving has to end in a message rather than a spinner that never
   * stops, so there is always a value — the caller only changes it.
   */
  timeoutMs?: number;
  /**
   * Extra multipart fields sent alongside the file — `replace=<courseId>` and
   * `allowDuplicate=1`, the two answers to the upload route's 409.
   */
  fields?: Record<string, string>;
}

/**
 * XHR rather than fetch: it is still the only way to read real upload progress,
 * and a syllabus PDF is big enough that a fake spinner would be a lie.
 */
export function apiUpload<T>(
  path: string,
  file: File,
  handlers: UploadHandlers = {},
): Promise<ClientResult<T>> {
  return new Promise((resolve) => {
    const form = new FormData();
    form.append("file", file);
    for (const [name, value] of Object.entries(handlers.fields ?? {})) {
      form.append(name, value);
    }

    const signal = handlers.signal;
    if (signal?.aborted) {
      resolve({ ok: false, error: "Upload cancelled" });
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.setRequestHeader("Accept", "application/json");
    /**
     * Without this the `timeout` event can never fire, so a request that dies
     * mid-flight left the panel spinning for as long as the tab stayed open.
     * Two minutes is past the slowest real parse and well short of "forever".
     */
    xhr.timeout = handlers.timeoutMs ?? 120_000;

    const onAbort = () => xhr.abort();
    signal?.addEventListener("abort", onAbort);

    const settle = (result: ClientResult<T>) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable || !handlers.onProgress) return;
      handlers.onProgress(Math.round((event.loaded / event.total) * 100));
    });

    xhr.addEventListener("load", () => {
      handlers.onProgress?.(100);
      let parsed: unknown;
      try {
        parsed = JSON.parse(xhr.responseText) as unknown;
      } catch {
        settle({
          ok: false,
          error:
            xhr.status >= 200 && xhr.status < 300
              ? WIRE_FAILURE
              : `Upload failed (${xhr.status || "no response"})`,
          detail: readableDetail(xhr.responseText),
        });
        return;
      }
      if (isApiResult(parsed)) settle(parsed as ClientResult<T>);
      else settle({ ok: false, error: WIRE_FAILURE });
    });

    xhr.addEventListener("error", () =>
      settle({ ok: false, error: "Could not reach the server" }),
    );
    xhr.addEventListener("abort", () =>
      settle({ ok: false, error: "Upload cancelled" }),
    );
    xhr.addEventListener("timeout", () =>
      settle({
        ok: false,
        error: "Upload timed out",
        detail: "The server stopped responding. Try again.",
      }),
    );

    xhr.send(form);
  });
}
