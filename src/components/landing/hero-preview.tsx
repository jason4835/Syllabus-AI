import { AlertIcon, CalendarIcon } from "@/components/icons";

/**
 * A static, hand-composed picture of the real product: the workload heatmap
 * over a short roadmap. Pure CSS/SVG — no screenshots, no placeholder images,
 * and it re-themes with the rest of the page.
 */

type SampleWeek = {
  label: string;
  hours: number;
  intensity: 0 | 1 | 2 | 3;
  warned?: boolean;
};

const WEEKS: SampleWeek[] = [
  { label: "1", hours: 4, intensity: 0 },
  { label: "2", hours: 7, intensity: 1 },
  { label: "3", hours: 9, intensity: 1 },
  { label: "4", hours: 14, intensity: 2 },
  { label: "5", hours: 11, intensity: 1 },
  { label: "6", hours: 21, intensity: 3, warned: true },
  { label: "7", hours: 8, intensity: 1 },
  { label: "8", hours: 5, intensity: 0 },
  { label: "9", hours: 13, intensity: 2 },
  { label: "10", hours: 16, intensity: 2 },
  { label: "11", hours: 23, intensity: 3, warned: true },
  { label: "12", hours: 10, intensity: 1 },
  { label: "13", hours: 6, intensity: 0 },
  { label: "14", hours: 12, intensity: 2 },
];

const PEAK = 24;

const COURSES = [
  { code: "MATH 221", color: "var(--color-course-1)" },
  { code: "CHEM 104", color: "var(--color-course-2)" },
  { code: "HIST 310", color: "var(--color-course-3)" },
  { code: "CS 240", color: "var(--color-course-4)" },
];

const ITEMS = [
  {
    code: "MATH 221",
    color: "var(--color-course-1)",
    title: "Midterm 1 — Chapters 1–5",
    kind: "Exam",
    weight: "20%",
    when: "in 5 days",
  },
  {
    code: "CS 240",
    color: "var(--color-course-4)",
    title: "Problem Set 4",
    kind: "Assignment",
    weight: "6%",
    when: "in 6 days",
  },
  {
    code: "HIST 310",
    color: "var(--color-course-3)",
    title: "Source analysis paper",
    kind: "Project",
    weight: "15%",
    when: "in 9 days",
  },
];

export function HeroPreview() {
  return (
    <div
      aria-hidden="true"
      className="panel w-full overflow-hidden shadow-lift"
    >
      {/* Header strip */}
      <div className="flex items-center justify-between gap-3 border-b border-line bg-raised px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-load-3/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-load-2/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-load-1/70" />
        </div>
        <p className="font-mono text-[0.6875rem] tracking-wide text-muted">
          Fall semester · 14 weeks
        </p>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-accent-line bg-accent-soft px-2 py-0.5 text-[0.6875rem] font-medium text-accent">
          <CalendarIcon width={12} height={12} />
          Synced
        </span>
      </div>

      <div className="space-y-5 p-4 sm:p-5">
        {/* Course legend */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {COURSES.map((course) => (
            <span
              key={course.code}
              className="inline-flex items-center gap-1.5 text-[0.75rem] font-semibold tracking-wide text-ink-soft"
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: course.color }}
              />
              {course.code}
            </span>
          ))}
        </div>

        {/* Heatmap */}
        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <p className="text-[0.6875rem] font-semibold tracking-[0.09em] text-muted uppercase">
              Workload
            </p>
            <p className="text-[0.6875rem] text-muted">hours / week</p>
          </div>
          <div className="flex items-end gap-[3px] sm:gap-1.5">
            {WEEKS.map((week) => (
              <div key={week.label} className="flex flex-1 flex-col items-center gap-1">
                <div className="relative flex h-20 w-full items-end overflow-hidden rounded-[5px] bg-track sm:h-24">
                  <div
                    className={`w-full rounded-[5px] ${week.intensity === 3 ? "hatch" : ""}`}
                    style={{
                      height: `${Math.max(10, (week.hours / PEAK) * 100)}%`,
                      backgroundColor: `var(--color-load-${week.intensity})`,
                    }}
                  />
                  {week.warned ? (
                    <span className="absolute top-1 right-1 text-danger">
                      <AlertIcon width={11} height={11} strokeWidth={2.2} />
                    </span>
                  ) : null}
                </div>
                <span className="font-mono text-[0.5625rem] text-muted">
                  {week.label}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Callout for the crunch week */}
        <p className="flex items-start gap-2 rounded-md border border-warn-line bg-warn-soft px-3 py-2 text-[0.8125rem] leading-snug text-ink">
          <span className="mt-0.5 shrink-0 text-warn">
            <AlertIcon width={14} height={14} />
          </span>
          <span>
            <strong className="font-semibold">Week 11 is a crunch:</strong> two
            exams and a paper land in five days. Start CHEM review by week 9.
          </span>
        </p>

        {/* Upcoming */}
        <ul className="divide-y divide-line border-t border-line">
          {ITEMS.map((item) => (
            <li key={item.title} className="flex items-center gap-3 py-2.5">
              <span
                className="h-8 w-1 shrink-0 rounded-full"
                style={{ backgroundColor: item.color }}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[0.8125rem] font-medium text-ink">
                  {item.title}
                </p>
                <p className="text-[0.75rem] text-muted">
                  {item.code} · {item.kind} · {item.weight} of grade
                </p>
              </div>
              <span className="shrink-0 font-mono text-[0.75rem] text-ink-soft tabular-nums">
                {item.when}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
