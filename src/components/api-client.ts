import type { ApiResult } from "@/lib/types";

/**
 * Every call funnels through here so a missing, half-deployed or erroring API
 * degrades into a normal `{ ok: false }` result instead of an unhandled
 * rejection. The dashboard then renders its empty/error states as designed.
 */

export interface AppConfig {
  demoMode: boolean;
  googleReady: boolean;
  openaiReady: boolean;
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

async function envelope<T>(request: Promise<Response>): Promise<ApiResult<T>> {
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

  if (isApiResult(parsed)) return parsed as ApiResult<T>;
  return { ok: false, error: WIRE_FAILURE };
}

export function apiGet<T>(path: string): Promise<ApiResult<T>> {
  return envelope<T>(
    fetch(path, { headers: { Accept: "application/json" }, cache: "no-store" }),
  );
}

export function apiPost<T>(path: string, body?: unknown): Promise<ApiResult<T>> {
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
export function apiPatch<T>(path: string, body: unknown): Promise<ApiResult<T>> {
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
export function apiDelete<T>(path: string, body?: unknown): Promise<ApiResult<T>> {
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

export interface UploadHandlers {
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
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
): Promise<ApiResult<T>> {
  return new Promise((resolve) => {
    const form = new FormData();
    form.append("file", file);
    for (const [name, value] of Object.entries(handlers.fields ?? {})) {
      form.append(name, value);
    }

    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.setRequestHeader("Accept", "application/json");

    const settle = (result: ApiResult<T>) => resolve(result);

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
      if (isApiResult(parsed)) settle(parsed as ApiResult<T>);
      else settle({ ok: false, error: WIRE_FAILURE });
    });

    xhr.addEventListener("error", () =>
      settle({ ok: false, error: "Could not reach the server" }),
    );
    xhr.addEventListener("abort", () =>
      settle({ ok: false, error: "Upload cancelled" }),
    );
    xhr.addEventListener("timeout", () =>
      settle({ ok: false, error: "Upload timed out" }),
    );

    handlers.signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(form);
  });
}
