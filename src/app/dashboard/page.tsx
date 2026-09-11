import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { readSession } from "@/lib/session";
import { DashboardShell } from "./dashboard-shell";

/**
 * Per-visitor by necessity: this page decides whether to mint a sandbox, which
 * means reading a cookie, which cannot be prerendered. It was static before,
 * but only as an empty shell -- every panel's content was always fetched on the
 * client, so nothing is lost but a build-time HTML file.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Dashboard",
  description:
    "Your semester roadmap, workload heatmap, calendar sync and syllabus chat.",
};

/**
 * A cookieless visitor gets their sandbox before any of the page's own fetches
 * run -- see `/api/session/start` for why that has to happen here rather than in
 * the panels. `readSession` is a pure read, so a visitor who already has a
 * cookie renders straight through and pays nothing.
 */
export default async function DashboardPage() {
  if (!(await readSession())) redirect("/api/session/start?next=/dashboard");
  return <DashboardShell />;
}
