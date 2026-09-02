import type { Assessment } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { AlertIcon } from "@/components/icons";
import { formatDate, formatPercent, formatRelative, formatTime } from "@/components/format";
import { isHighStakes, kindLabel } from "@/components/labels";

export interface AssessmentRowProps {
  assessment: Assessment;
  courseCode: string;
  color: string;
  /** Show the "in 5 days" column — off inside week-scoped lists. */
  showRelative?: boolean;
  /** Flag confidence < 0.6 with a "check this" affordance. */
  showConfidence?: boolean;
}

export function AssessmentRow({
  assessment,
  courseCode,
  color,
  showRelative = true,
  showConfidence = false,
}: AssessmentRowProps) {
  const weight = formatPercent(assessment.weightPercent);
  const time = formatTime(assessment.dueTime);
  const lowConfidence = assessment.confidence < 0.6;

  return (
    <li className="flex items-start gap-3 py-3">
      <span
        aria-hidden="true"
        className="mt-0.5 h-9 w-1 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-[0.75rem] font-semibold tracking-wide text-ink-soft">
            {courseCode}
          </span>
          <span aria-hidden="true" className="text-line-strong">
            ·
          </span>
          <span className="text-[0.75rem] text-muted">
            {kindLabel(assessment.kind)}
          </span>
          {weight ? (
            <span className="text-[0.75rem] text-muted">
              · {weight} of grade
            </span>
          ) : null}
        </div>
        <p
          className={`mt-0.5 text-[0.9375rem] leading-snug text-ink ${
            isHighStakes(assessment.kind) ? "font-semibold" : "font-medium"
          }`}
        >
          {assessment.title}
        </p>
        <p className="mt-0.5 text-[0.8125rem] text-muted">
          {formatDate(assessment.dueDate)}
          {time ? ` · ${time}` : ""}
        </p>
        {assessment.notes ? (
          <p className="mt-1 text-[0.8125rem] leading-snug text-ink-soft">
            {assessment.notes}
          </p>
        ) : null}
        {showConfidence && lowConfidence ? (
          <details className="mt-2 rounded-md border border-warn-line bg-warn-soft px-2.5 py-1.5">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[0.75rem] font-medium text-warn">
              <AlertIcon width={13} height={13} />
              Check this — low confidence (
              {Math.round(assessment.confidence * 100)}%)
            </summary>
            <p className="mt-1.5 text-[0.75rem] leading-relaxed text-ink-soft">
              {assessment.sourceText
                ? `From the syllabus: “${assessment.sourceText}”`
                : "The extractor could not point at a clear line in the syllabus for this one. Confirm the date against the original."}
            </p>
          </details>
        ) : null}
      </div>
      {showRelative ? (
        <div className="shrink-0 text-right">
          <span className="font-mono text-[0.75rem] whitespace-nowrap text-ink-soft tabular-nums">
            {formatRelative(assessment.dueDate)}
          </span>
          {showConfidence && lowConfidence ? (
            <span className="mt-1 block">
              <Badge tone="warn">check</Badge>
            </span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
