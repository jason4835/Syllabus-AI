import type { AssessmentKind } from "@/lib/types";

export const KIND_LABEL: Record<AssessmentKind, string> = {
  assignment: "Assignment",
  exam: "Exam",
  quiz: "Quiz",
  project: "Project",
  reading: "Reading",
  lab: "Lab",
  presentation: "Presentation",
  other: "Item",
};

export function kindLabel(kind: AssessmentKind): string {
  return KIND_LABEL[kind] ?? "Item";
}

/** Exams and projects carry the most risk, so they get the strongest treatment. */
export function isHighStakes(kind: AssessmentKind): boolean {
  return kind === "exam" || kind === "project" || kind === "presentation";
}

export const INTENSITY_LABEL = ["Calm", "Steady", "Busy", "Crunch"] as const;

export function intensityLabel(intensity: 0 | 1 | 2 | 3): string {
  return INTENSITY_LABEL[intensity];
}

export function intensityColor(intensity: 0 | 1 | 2 | 3): string {
  return `var(--color-load-${intensity})`;
}
