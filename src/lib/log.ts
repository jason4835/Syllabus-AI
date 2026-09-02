/**
 * Structured logging for Syllabus AI.
 *
 * Routes answer failures with a polite `ApiResult` and then forget them. That
 * is fine for the student and useless for whoever has to fix it, so every
 * interesting event also goes to stdout in a shape a host's log drain can
 * parse: one JSON object per line in production, something readable by a human
 * in dev.
 *
 * Two rules drive the design:
 *
 * 1. **Nothing secret may reach a log line.** This app holds Google refresh
 *    tokens, an OpenAI key, a Supabase service-role key and signed session
 *    cookies. Request context gets logged wholesale during an incident, so
 *    redaction happens here -- by key name *and* by value shape -- rather than
 *    relying on every caller to remember what is sensitive.
 * 2. **The logger may never throw.** It runs inside catch blocks; a logger that
 *    throws takes down the request it was trying to explain. Every emit is
 *    wrapped, cycles and BigInts are neutralised before `JSON.stringify` sees
 *    them, and output is size-capped so one enormous object cannot flood the
 *    drain (or the bill).
 *
 * No dependencies on purpose: this must be importable from any route, edge or
 * node, without pulling an SDK into the bundle.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Free-form structured context. Values are sanitized before they are written. */
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** Derives a logger that stamps `bound` onto every line it writes. */
  child(bound: LogFields): Logger;
}

/** What a redacted value is replaced with. Exported so tests can assert on it. */
export const REDACTED = "[redacted]";

// Caps. Generous enough to debug with, small enough that a runaway object or a
// 10 MB syllabus string cannot become the log line.
const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 60;
const MAX_STRING_CHARS = 2000;
const MAX_LINE_CHARS = 16_000;

/**
 * Matched against the key with punctuation and case stripped, so one entry
 * covers `refresh_token`, `refreshToken`, `REFRESH-TOKEN` and friends.
 */
const SENSITIVE_KEY_PARTS = [
  "token", // token, refresh_token, access_token, id_token, csrftoken
  "secret", // secret, client_secret, session_secret
  "password",
  "passwd",
  "passphrase",
  "apikey",
  "authorization",
  "cookie",
  "credential",
  "privatekey",
  "servicerole", // SUPABASE_SERVICE_ROLE_KEY
  "signature",
  "sessionid",
  "bearer",
];

/**
 * Values that are credentials whatever key they arrive under -- pasted into a
 * `note`, embedded in an error message, echoed inside a stack frame. Anchored
 * on the issuer prefixes the app actually handles.
 */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI (incl. sk-proj-…)
  /\b1\/\/[A-Za-z0-9_-]{20,}/g, // Google OAuth refresh token
  /\bya29\.[A-Za-z0-9._-]{20,}/g, // Google OAuth access token
  /\bGOCSPX-[A-Za-z0-9_-]{10,}/g, // Google OAuth client secret
  /\bAIza[A-Za-z0-9_-]{20,}/g, // Google API key
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, // JWT (Supabase keys, id tokens)
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\bsylb_session=[A-Za-z0-9._~+/=-]+/g, // our own session cookie
];

function flattenKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key: string): boolean {
  const flat = flattenKey(key);
  return SENSITIVE_KEY_PARTS.some((part) => flat.includes(part));
}

/**
 * Last-resort shape check for an unrecognised credential: one long unbroken
 * run of token characters with mixed case and digits. Deliberately narrow --
 * URLs (`:`) and lowercase hex commit SHAs are excluded so real debugging
 * context survives.
 */
function looksLikeOpaqueSecret(value: string): boolean {
  if (value.length < 40 || value.length > 4096) return false;
  if (!/^[A-Za-z0-9_\-+/=.]+$/.test(value)) return false;
  return /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value);
}

function sanitizeString(value: string): string {
  if (looksLikeOpaqueSecret(value)) return REDACTED;
  let out = value;
  for (const pattern of CREDENTIAL_PATTERNS) out = out.replace(pattern, REDACTED);
  if (out.length > MAX_STRING_CHARS) {
    return `${out.slice(0, MAX_STRING_CHARS)}…[+${out.length - MAX_STRING_CHARS} chars]`;
  }
  return out;
}

function isErrorLike(value: object): value is { name?: unknown; message: unknown; stack?: unknown } {
  return "message" in value && "stack" in value;
}

function sanitizeError(err: Error, depth: number, seen: Set<object>): LogFields {
  // `JSON.stringify(new Error("boom"))` is `{}` -- name/message/stack are all
  // non-enumerable. Pulling them out by hand is the whole point of this branch.
  const out: LogFields = {
    name: typeof err.name === "string" ? err.name : "Error",
    message: sanitizeString(typeof err.message === "string" ? err.message : String(err.message)),
  };
  if (typeof err.stack === "string") out.stack = sanitizeString(err.stack);
  if (err.cause !== undefined) out.cause = sanitizeValue(err.cause, depth + 1, seen);
  // Libraries hang the useful bits (`code`, `status`, `response`) off the error
  // as own properties.
  for (const key of Object.keys(err)) {
    if (key in out) continue;
    out[key] = isSensitiveKey(key)
      ? REDACTED
      : sanitizeValue((err as unknown as LogFields)[key], depth + 1, seen);
  }
  return out;
}

function sanitizeEntries(
  entries: Iterable<[unknown, unknown]>,
  depth: number,
  seen: Set<object>,
): LogFields {
  const out: LogFields = {};
  let count = 0;
  for (const [rawKey, rawValue] of entries) {
    const key = typeof rawKey === "string" ? rawKey : String(rawKey);
    if (count >= MAX_OBJECT_KEYS) {
      out["…"] = "[more entries omitted]";
      break;
    }
    count += 1;
    out[key] = isSensitiveKey(key) ? REDACTED : sanitizeValue(rawValue, depth + 1, seen);
  }
  return out;
}

/**
 * Recursively neutralises a value: redacts secrets, breaks cycles, caps depth
 * and size, and replaces anything `JSON.stringify` would choke on.
 */
function sanitizeValue(value: unknown, depth: number, seen: Set<object>): unknown {
  if (value === null || value === undefined) return value;

  switch (typeof value) {
    case "string":
      return sanitizeString(value);
    case "number":
      // NaN/Infinity serialize as `null`, which reads as "we had no value".
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      return value;
    case "bigint":
      return `${value.toString()}n`; // JSON.stringify throws on BigInt
    case "function":
      return `[function ${value.name || "anonymous"}]`;
    case "symbol":
      return value.toString();
  }

  const obj = value as object;
  if (seen.has(obj)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[depth limit]";

  seen.add(obj);
  try {
    if (value instanceof Error) return sanitizeError(value, depth, seen);
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
    }
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY_ITEMS).map((v) => sanitizeValue(v, depth + 1, seen));
      if (value.length > MAX_ARRAY_ITEMS) {
        items.push(`[+${value.length - MAX_ARRAY_ITEMS} more items]`);
      }
      return items;
    }
    if (value instanceof Set) {
      return sanitizeValue([...value], depth, seen);
    }
    if (value instanceof Map) {
      return sanitizeEntries(value.entries(), depth, seen);
    }
    // Headers and other entry-iterables: `Object.keys(headers)` is empty, so
    // without this a logged request header bag would silently become `{}` --
    // and `authorization` would dodge the key check.
    const entries = (value as { entries?: unknown }).entries;
    if (typeof entries === "function") {
      try {
        const pairs = Array.from(
          (entries as () => Iterable<[unknown, unknown]>).call(value),
        );
        return sanitizeEntries(pairs, depth, seen);
      } catch {
        // Not actually an entry-iterable; fall through to plain enumeration.
      }
    }
    if (isErrorLike(obj)) {
      // Cross-realm errors fail `instanceof` but still carry the useful fields.
      return sanitizeError(obj as unknown as Error, depth, seen);
    }
    return sanitizeEntries(Object.entries(obj as LogFields), depth, seen);
  } catch (err) {
    return `[unserializable: ${err instanceof Error ? err.name : "error"}]`;
  } finally {
    // Deleted rather than left in a WeakSet so the *same* object appearing
    // twice side by side is not mislabelled as a cycle.
    seen.delete(obj);
  }
}

/** Sanitizes a field bag. Exported for tests and for callers building context by hand. */
export function redact(fields: LogFields | undefined): LogFields {
  if (!fields) return {};
  const seen = new Set<object>();
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    out[key] = isSensitiveKey(key) ? REDACTED : sanitizeValue(value, 0, seen);
  }
  return out;
}

/** Turns anything a `throw` can produce into a loggable shape. */
export function normalizeError(err: unknown): LogFields {
  if (err instanceof Error) return sanitizeError(err, 0, new Set<object>());
  // `throw "nope"` and `throw { code: 500 }` are legal and depressingly common.
  return {
    name: "NonError",
    message: sanitizeString(typeof err === "string" ? err : safeToString(err)),
    value: sanitizeValue(err, 0, new Set<object>()),
  };
}

function safeToString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "[unstringifiable]";
  }
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function isEnabled(level: LogLevel): boolean {
  const configured = (process.env.LOG_LEVEL ?? "").trim().toLowerCase();
  const floor =
    configured in LEVEL_ORDER
      ? LEVEL_ORDER[configured as LogLevel]
      : isProduction()
        ? LEVEL_ORDER.info // debug lines are dev scaffolding, not drain fodder
        : LEVEL_ORDER.debug;
  return LEVEL_ORDER[level] >= floor;
}

function stringify(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

function consoleFor(level: LogLevel): (line: string) => void {
  // Bound at call time: Next replaces `console` methods in some runtimes.
  if (level === "error") return (line) => console.error(line);
  if (level === "warn") return (line) => console.warn(line);
  if (level === "debug") return (line) => console.debug(line);
  return (line) => console.log(line);
}

function writeJson(level: LogLevel, event: string, time: string, fields: LogFields): void {
  const record: LogFields = { level, event, time };
  for (const [key, value] of Object.entries(fields)) {
    // Envelope keys win, so a stray `event` field can never make a line
    // ambiguous to whatever is parsing it.
    record[key in record ? `${key}_` : key] = value;
  }
  let line = stringify(record);
  if (line === null || line.length > MAX_LINE_CHARS) {
    line =
      stringify({
        level,
        event,
        time,
        truncated: true,
        preview: (line ?? "[unserializable]").slice(0, MAX_LINE_CHARS),
      }) ?? `{"level":"${level}","event":"log_serialize_failed","time":"${time}"}`;
  }
  consoleFor(level)(line);
}

function formatInline(value: unknown): string {
  if (typeof value === "string") return value.includes(" ") ? JSON.stringify(value) : value;
  return stringify(value) ?? String(value);
}

function writePretty(level: LogLevel, event: string, time: string, fields: LogFields): void {
  const stamp = time.slice(11, 23); // HH:MM:SS.mmm -- the date is noise in a terminal
  const parts: string[] = [];
  const blocks: string[] = [];

  for (const [key, value] of Object.entries(fields)) {
    // Stacks are the reason you opened the terminal; give them their own lines.
    if (value && typeof value === "object" && typeof (value as LogFields).stack === "string") {
      blocks.push(`${key}: ${String((value as LogFields).stack)}`);
      continue;
    }
    const inline = formatInline(value);
    if (inline.length > 160) {
      blocks.push(`${key}: ${stringify(value) ?? inline}`);
      continue;
    }
    parts.push(`${key}=${inline}`);
  }

  const head = `${stamp} ${level.toUpperCase().padEnd(5)} ${event}${parts.length ? `  ${parts.join(" ")}` : ""}`;
  const body = blocks.map((b) => b.split("\n").map((l) => `    ${l}`).join("\n")).join("\n");
  consoleFor(level)(body ? `${head}\n${body}` : head);
}

function emit(level: LogLevel, event: string, bound: LogFields, fields?: LogFields): void {
  try {
    if (!isEnabled(level)) return;
    const safe = redact({ ...bound, ...fields });
    const time = new Date().toISOString();
    if (isProduction()) writeJson(level, event, time, safe);
    else writePretty(level, event, time, safe);
  } catch (err) {
    // Absolute floor: never let logging break the caller.
    try {
      console.error(`[log] failed to emit "${event}": ${safeToString(err)}`);
    } catch {
      /* nothing left to try */
    }
  }
}

function createLogger(bound: LogFields): Logger {
  return {
    debug: (event, fields) => emit("debug", event, bound, fields),
    info: (event, fields) => emit("info", event, bound, fields),
    warn: (event, fields) => emit("warn", event, bound, fields),
    error: (event, fields) => emit("error", event, bound, fields),
    child: (extra) => createLogger({ ...bound, ...redact(extra) }),
  };
}

/** The application logger. Use `log.info("upload.received", { userId })`. */
export const log: Logger = createLogger({});

/**
 * Short, greppable correlation id -- 8 chars is enough to tie a handful of
 * lines together within one deploy, and short enough to paste into a bug report.
 */
export function newRequestId(): string {
  const c: Crypto | undefined = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID().replace(/-/g, "").slice(0, 8);
  return Math.random().toString(36).slice(2, 10).padEnd(8, "0");
}

/** Reads an upstream correlation id off the request, so ours matches the host's. */
export function requestIdOf(req: Request): string {
  try {
    const header = req.headers.get("x-request-id") ?? req.headers.get("x-vercel-id");
    if (header) return header.trim().slice(0, 36);
  } catch {
    /* a synthetic Request may not have headers */
  }
  return newRequestId();
}

/**
 * Child logger stamping `reqId` on every line, so one failing request can be
 * pulled out of an interleaved drain. Accepts the `Request` itself for the
 * common case in a route handler.
 */
export function withRequestId(source?: Request | string): Logger {
  const reqId =
    typeof source === "string"
      ? source
      : source
        ? requestIdOf(source)
        : newRequestId();
  return log.child({ reqId });
}

/**
 * What a route's catch block should call. Normalises non-Error throwables so
 * `{ err }` is never logged as `{}`, and keeps the event name the thing you
 * grep for.
 */
export function logApiError(event: string, err: unknown, fields?: LogFields): void {
  log.error(event, { ...fields, err: normalizeError(err) });
}
