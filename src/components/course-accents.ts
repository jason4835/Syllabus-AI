import type { CSSProperties } from "react";
import type { Course } from "@/lib/types";

/**
 * Six accents, defined as tokens in globals.css so they re-theme in dark mode.
 * A course keeps the same accent everywhere — heatmap, roadmap, upcoming list —
 * which is what makes the panels read as one picture.
 */
export const COURSE_ACCENT_COUNT = 6;

export function accentVar(index: number): string {
  const slot = ((index % COURSE_ACCENT_COUNT) + COURSE_ACCENT_COUNT) % COURSE_ACCENT_COUNT;
  return `var(--color-course-${slot + 1})`;
}

/** Stable courseId -> accent lookup built from the course list's own order. */
export function buildAccentMap(courses: Course[]): Record<string, string> {
  const map: Record<string, string> = {};
  courses.forEach((course, index) => {
    map[course.id] = accentVar(index);
  });
  return map;
}

export function accentFor(map: Record<string, string>, courseId: string): string {
  return map[courseId] ?? "var(--color-muted)";
}

/** Inline custom property, typed without reaching for `any`. */
export function accentStyle(color: string): CSSProperties {
  return { "--accent": color } as CSSProperties;
}
