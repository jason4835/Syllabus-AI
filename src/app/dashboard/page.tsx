import type { Metadata } from "next";
import { DashboardShell } from "./dashboard-shell";

export const metadata: Metadata = {
  title: "Dashboard",
  description:
    "Your semester roadmap, workload heatmap, calendar sync and syllabus chat.",
};

export default function DashboardPage() {
  return <DashboardShell />;
}
