import type { AssessmentKind, MeetingKind, TermType } from "@/lib/types";

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

/**
 * Term types, written the way a student reads their own calendar. `custom` is
 * "Other" here rather than "Custom": on a select it is the answer for a term
 * this list has no name for, not a feature.
 */
export const TERM_TYPE_LABEL: Record<TermType, string> = {
  semester: "Semester",
  quarter: "Quarter",
  trimester: "Trimester",
  summer: "Summer session",
  winter: "Winter session",
  j_term: "January term",
  custom: "Other",
};

export function termTypeLabel(type: TermType): string {
  return TERM_TYPE_LABEL[type] ?? TERM_TYPE_LABEL.custom;
}
