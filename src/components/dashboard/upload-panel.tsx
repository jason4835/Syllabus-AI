"use client";

import { useCallback, useId, useRef, useState } from "react";
import type { DragEvent } from "react";
import type { Assessment, Course } from "@/lib/types";
import { apiUpload } from "@/components/api-client";
import { Panel } from "@/components/ui/panel";
import { Button, Spinner } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ErrorState, Note } from "@/components/ui/states";
import { AlertIcon, CheckIcon, FileIcon, UploadIcon } from "@/components/icons";
import { AssessmentRow } from "@/components/dashboard/assessment-row";
import { formatPercent, pluralize } from "@/components/format";

export interface UploadResult {
  courseId: string;
  course: Course;
  assessments: Assessment[];
  warnings: string[];
}

type Phase =
  | { kind: "idle" }
  | { kind: "uploading"; fileName: string; percent: number }
  | { kind: "parsing"; fileName: string }
  | { kind: "done"; result: UploadResult }
  | { kind: "error"; error: string; detail?: string };

export function UploadPanel({
  demoMode,
  accent,
  onUploaded,
}: {
  demoMode: boolean;
  /** Accent the newly added course will carry elsewhere in the dashboard. */
  accent: string;
  onUploaded: (result: UploadResult) => void;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);

  const busy = phase.kind === "uploading" || phase.kind === "parsing";

  const send = useCallback(
    async (file: File) => {
      if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
        setPhase({
          kind: "error",
          error: "That file is not a PDF",
          detail: `“${file.name}” could not be read. Export your syllabus as a PDF and try again.`,
        });
        return;
      }

      setPhase({ kind: "uploading", fileName: file.name, percent: 0 });

      const result = await apiUpload<UploadResult>("/api/upload", file, {
        onProgress: (percent) => {
          setPhase((current) =>
            current.kind === "uploading"
              ? { ...current, percent }
              : current,
          );
          if (percent >= 100) {
            setPhase((current) =>
              current.kind === "uploading"
                ? { kind: "parsing", fileName: current.fileName }
                : current,
            );
          }
        },
      });

      if (!result.ok) {
        setPhase({ kind: "error", error: result.error, detail: result.detail });
        return;
      }
      setPhase({ kind: "done", result: result.data });
      onUploaded(result.data);
    },
    [onUploaded],
  );

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    const file = event.dataTransfer.files?.[0];
    if (file) void send(file);
  };

  return (
    <Panel
      id="upload"
      title="Upload a syllabus"
      icon={<UploadIcon width={17} height={17} />}
      description={
        demoMode
          ? "Demo mode parses your PDF with the built-in fixture extractor."
          : "PDF only. One course per file."
      }
      action={
        phase.kind === "done" || phase.kind === "error" ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setPhase({ kind: "idle" })}
          >
            Upload another
          </Button>
        ) : null
      }
    >
      {phase.kind === "done" ? (
        <ExtractionResult result={phase.result} accent={accent} />
      ) : (
        <div className="space-y-3">
          <div
            onDragOver={(event) => {
              event.preventDefault();
              if (!busy) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors ${
              dragging
                ? "border-accent bg-accent-soft"
                : "border-line-strong bg-sunken/50"
            }`}
          >
            {busy ? (
              <div className="mx-auto max-w-xs">
                <p className="flex items-center justify-center gap-2 text-[0.875rem] font-medium text-ink">
                  <Spinner label="Working" />
                  {phase.kind === "uploading"
                    ? `Uploading ${phase.fileName}`
                    : "Reading the syllabus…"}
                </p>
                <div
                  role="progressbar"
                  aria-label="Upload progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={phase.kind === "uploading" ? phase.percent : 100}
                  className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-track"
                >
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-200"
                    style={{
                      width:
                        phase.kind === "uploading"
                          ? `${Math.max(4, phase.percent)}%`
                          : "100%",
                    }}
                  />
                </div>
                <p className="mt-2 text-[0.75rem] text-muted">
                  {phase.kind === "uploading"
                    ? `${phase.percent}% sent`
                    : "Extracting courses, dates and grading weights."}
                </p>
              </div>
            ) : (
              <>
                <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-accent-soft text-accent">
                  <FileIcon width={20} height={20} />
                </span>
                <p className="text-[0.9375rem] font-medium text-ink">
                  Drop a syllabus PDF here
                </p>
                <p className="mt-1 text-[0.8125rem] text-muted">
                  or pick one from your computer
                </p>
                <div className="mt-4">
                  <label htmlFor={inputId} className="sr-only">
                    Syllabus PDF file
                  </label>
                  <input
                    ref={inputRef}
                    id={inputId}
                    type="file"
                    accept="application/pdf,.pdf"
                    className="sr-only"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void send(file);
                      event.target.value = "";
                    }}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => inputRef.current?.click()}
                  >
                    Choose a PDF
                  </Button>
                </div>
              </>
            )}
          </div>

          {phase.kind === "error" ? (
            <ErrorState
              error={phase.error}
              detail={phase.detail}
              onRetry={() => setPhase({ kind: "idle" })}
            />
          ) : null}
        </div>
      )}
    </Panel>
  );
}

function ExtractionResult({
  result,
  accent,
}: {
  result: UploadResult;
  accent: string;
}) {
  const { course, assessments, warnings } = result;
  const flagged = assessments.filter((item) => item.confidence < 0.6);
  const totalWeight = course.gradeWeights.reduce(
    (sum, row) => sum + row.weightPercent,
    0,
  );

  return (
    <div className="rise space-y-5">
      <div
        className="rounded-lg border border-line bg-raised p-4"
        style={{ borderLeft: `3px solid ${accent}` }}
      >
        <p className="flex items-center gap-1.5 text-[0.75rem] font-semibold tracking-wide text-ok">
          <CheckIcon width={14} height={14} />
          Extracted
        </p>
        <h3 className="mt-1.5 text-[1.125rem] leading-tight text-ink">
          <span className="font-mono text-[0.875rem] tracking-wide text-ink-soft">
            {course.code}
          </span>{" "}
          {course.title}
        </h3>
        <p className="mt-1 text-[0.8125rem] text-muted">
          {[course.instructor, course.term].filter(Boolean).join(" · ") ||
            "No instructor or term listed"}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Badge tone="accent">
            {pluralize(assessments.length, "assessment")}
          </Badge>
          <Badge tone="neutral">
            {pluralize(course.gradeWeights.length, "grading row")}
          </Badge>
          {flagged.length > 0 ? (
            <Badge tone="warn">{flagged.length} to check</Badge>
          ) : null}
        </div>
      </div>

      {warnings.length > 0 ? (
        <div>
          <h4 className="mb-2 text-[0.6875rem] font-semibold tracking-[0.12em] text-muted uppercase">
            Warnings
          </h4>
          <ul className="space-y-1.5">
            {warnings.map((warning, index) => (
              <li
                key={`${warning}-${index}`}
                className="flex items-start gap-2 rounded-md border border-warn-line bg-warn-soft px-3 py-2 text-[0.8125rem] leading-relaxed text-ink"
              >
                <span className="mt-0.5 shrink-0 text-warn">
                  <AlertIcon width={13} height={13} />
                </span>
                {warning}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {course.gradeWeights.length > 0 ? (
        <div>
          <h4 className="mb-2 text-[0.6875rem] font-semibold tracking-[0.12em] text-muted uppercase">
            Grading weights
          </h4>
          <ul className="space-y-1.5">
            {course.gradeWeights.map((row) => (
              <li key={row.category} className="flex items-center gap-3">
                <span className="w-28 shrink-0 truncate text-[0.8125rem] text-ink-soft sm:w-36">
                  {row.category}
                </span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-track">
                  <span
                    className="block h-full rounded-full"
                    style={{
                      width: `${Math.min(100, row.weightPercent)}%`,
                      backgroundColor: accent,
                    }}
                  />
                </span>
                <span className="w-11 shrink-0 text-right font-mono text-[0.8125rem] text-ink tabular-nums">
                  {formatPercent(row.weightPercent)}
                </span>
              </li>
            ))}
          </ul>
          {Math.abs(totalWeight - 100) > 0.5 ? (
            <div className="mt-2.5">
              <Note tone="warn">
                These weights add up to {formatPercent(totalWeight)}, not 100%.
                Worth a look at the original syllabus.
              </Note>
            </div>
          ) : null}
        </div>
      ) : (
        <Note>
          No grading breakdown was found in this syllabus. Weights will show as
          blank until you add them.
        </Note>
      )}

      <div>
        <h4 className="mb-1 text-[0.6875rem] font-semibold tracking-[0.12em] text-muted uppercase">
          Assessments found
        </h4>
        <ul className="divide-y divide-line">
          {assessments.map((assessment) => (
            <AssessmentRow
              key={assessment.id}
              assessment={assessment}
              courseCode={course.code}
              color={accent}
              showConfidence
            />
          ))}
        </ul>
      </div>
    </div>
  );
}
