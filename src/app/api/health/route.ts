import { ok } from "@/lib/api";
import { buildHealthReport, type Env } from "@/lib/health";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * Uptime monitors poll this on a loop; logging every degraded response would
 * bury the drain in the same three lines. Once per process is enough to notice.
 */
let warnedThisProcess = false;

/**
 * Answers "is this deploy alive, and is it actually wired up?" without
 * authentication -- so it stays boolean-only and touches nothing but env.
 */
export async function GET() {
  const report = buildHealthReport(
    process.env as Env,
    Math.round(typeof process.uptime === "function" ? process.uptime() : 0),
    new Date(),
  );

  if (report.status === "degraded" && !warnedThisProcess) {
    warnedThisProcess = true;
    log.warn("health.degraded", { warnings: report.warnings, storage: report.storage });
  }

  // Always 200: the process is up and answering, and `status` carries the
  // nuance. A 503 here would page someone over a missing env var.
  return ok(report);
}
