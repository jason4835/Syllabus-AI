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
    return { ok: false, error: "The server sent an unreadable response" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return {
      ok: false,
      error: response.ok
        ? "The server sent an unexpected response"
        : `Request failed (${response.status})`,
      detail: body.slice(0, 180).trim() || undefined,
    };
  }

  if (isApiResult(parsed)) return parsed as ApiResult<T>;
  return { ok: false, error: "The server sent an unexpected response shape" };
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

export interface UploadHandlers {
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
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
              ? "The server sent an unexpected response"
              : `Upload failed (${xhr.status || "no response"})`,
          detail: xhr.responseText.slice(0, 180).trim() || undefined,
        });
        return;
      }
      if (isApiResult(parsed)) settle(parsed as ApiResult<T>);
      else settle({ ok: false, error: "The server sent an unexpected response shape" });
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
