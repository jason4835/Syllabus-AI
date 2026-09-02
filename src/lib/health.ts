import { MIN_SESSION_SECRET_LENGTH } from "@/lib/session";

/**
 * Health-report logic, kept out of the route file because Next.js only allows
 * HTTP verbs and a fixed set of config exports from a route module -- exporting
 * a helper from there fails the build.
 */

/**
 * What `GET /api/health` reports, inside the usual `ApiResult` envelope.
 *
 * Booleans and a driver name only. This endpoint is unauthenticated, so a
 * value, a prefix, a length or a hash of any credential would be a public leak
 * -- "is it configured" is the entire question it is allowed to answer.
 */
export interface HealthReport {
  status: "ok" | "degraded";
  /** Build identity, when the host exposes it. Neither is a secret. */
  version: string | null;
  commit: string | null;
  environment: string;
  /** Process uptime. Resets on every cold start, which is itself a useful signal. */
  uptimeSeconds: number;
  time: string;
  /** Which persistence driver this instance is running on. */
  storage: "supabase" | "volume" | "local";
  capabilities: {
    openai: boolean;
    google: boolean;
    supabase: boolean;
    sessionSecret: boolean;
    notion: boolean;
  };
  /** Plain-language description of each thing that made the status `degraded`. */
  warnings: string[];
}

export type Env = Record<string, string | undefined>;

/** Whitespace-only env vars are a classic paste accident; treat them as unset. */
function has(env: Env, name: string): boolean {
  return (env[name] ?? "").trim().length > 0;
}

function firstOf(env: Env, names: string[]): string | null {
  for (const name of names) {
    const value = (env[name] ?? "").trim();
    if (value) return value;
  }
  return null;
}

/**
 * Pure -- the report is a function of env alone, so it can be exercised against
 * a fabricated environment without booting a server. Reads env directly and
 * never imports the store: a health check that opens a database connection is
 * a health check that can take the app down.
 */
export function buildHealthReport(env: Env, uptimeSeconds: number, now: Date): HealthReport {
  const google = has(env, "GOOGLE_CLIENT_ID") && has(env, "GOOGLE_CLIENT_SECRET");
  // Mirrors getStore(): both halves or it falls back to the local JSON file.
  const supabase = has(env, "SUPABASE_URL") && has(env, "SUPABASE_SERVICE_ROLE_KEY");
  // Presence is not enough: session.ts REFUSES a secret shorter than this in
  // production, so a short one must report unhealthy rather than green-while-dead.
  const sessionSecret =
    (env.SESSION_SECRET ?? "").trim().length >= MIN_SESSION_SECRET_LENGTH;
  const isProduction = env.NODE_ENV === "production";

  const warnings: string[] = [];
  if (isProduction && !sessionSecret) {
    // Two very different failures deserve two different instructions: an unset
    // secret is "you forgot", a short one is "you set it wrong".
    warnings.push(
      has(env, "SESSION_SECRET")
        ? `SESSION_SECRET is shorter than ${MIN_SESSION_SECRET_LENGTH} characters, so every request is failing. Replace it with \`openssl rand -hex 32\` and redeploy.`
        : "SESSION_SECRET is not set, so every request is failing. Without it sessions would be signed with the public dev key and anyone could forge one. Set it and redeploy.",
    );
  }
  // A local store is only a problem when nothing durable is behind it. An
  // explicit DATA_DIR means the operator mounted a volume on purpose, so
  // warning about it would train them to ignore this endpoint.
  const persistentVolume = has(env, "DATA_DIR");
  if (isProduction && !supabase && !persistentVolume) {
    warnings.push(
      "Neither Supabase nor a persistent volume is configured. Data is being written inside the deployment and will be lost on the next redeploy or cold start. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or mount a volume and set DATA_DIR to its path.",
    );
  }

  return {
    status: warnings.length > 0 ? "degraded" : "ok",
    version: firstOf(env, ["APP_VERSION", "NEXT_PUBLIC_APP_VERSION", "npm_package_version"]),
    commit: firstOf(env, ["VERCEL_GIT_COMMIT_SHA", "GIT_COMMIT_SHA", "COMMIT_SHA"]),
    environment: env.VERCEL_ENV ?? env.NODE_ENV ?? "development",
    uptimeSeconds,
    time: now.toISOString(),
    storage: supabase ? "supabase" : persistentVolume ? "volume" : "local",
    capabilities: {
      openai: has(env, "OPENAI_API_KEY"),
      google,
      supabase,
      sessionSecret,
      notion: has(env, "NOTION_CLIENT_ID") && has(env, "NOTION_CLIENT_SECRET"),
    },
    warnings,
  };
}
