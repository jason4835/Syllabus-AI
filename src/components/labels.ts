import type { AssessmentKind, MeetingKind } from "@/lib/types";

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

/**
 * Meeting kinds, written the way a student would say them. `office_hours` is
 * never "class": what a row is called here is what ends up on the calendar.
 */
export const MEETING_KIND_LABEL: Record<MeetingKind, string> = {
  lecture: "Class",
  recitation: "Recitation",
  lab: "Lab",
  office_hours: "Office hours",
  other: "Meeting",
};

export function meetingKindLabel(kind: MeetingKind): string {
  return MEETING_KIND_LABEL[kind] ?? MEETING_KIND_LABEL.other;
}
