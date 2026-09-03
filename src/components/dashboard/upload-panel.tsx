"use client";

import { useCallback, useId, useRef, useState } from "react";
import { needsReview } from "@/lib/types";
import type { DragEvent } from "react";
import type { Assessment, Course } from "@/lib/types";
import { apiUpload } from "@/components/api-client";
import { Panel } from "@/components/ui/panel";
import { Button, Spinner } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ErrorState, Note } from "@/components/ui/states";
import { AlertIcon, CheckIcon, FileIcon, UploadIcon } from "@/components/icons";
import { AssessmentRow } from "@/components/dashboard/assessment-row";
import {
  SectionChooser,
  needsSection,
} from "@/components/dashboard/section-chooser";
import { formatPercent, pluralize } from "@/components/format";

export interface UploadResult {
  courseId: string;
  course: Course;
  assessments: Assessment[];
  warnings: string[];
  /**
   * The id of the course this upload replaced, when it was sent with
   * `replace=<id>`. Absent from an older server, which only ever added.
   */
  replaced?: string | null;
  /**
   * Present only when Notion is connected. Optional rather than `| null`
   * because an older server (or one whose Notion routes are not deployed) just
   * omits the field, and the upload is still a success either way.
   */
  notion?: {
    pageUrl: string | null;
    hubUrl: string | null;
    error: string | null;
  } | null;
}

/** What the 409 says we already have. */
export interface DuplicateCourse {
  id: string;
  code: string;
  title: string;
  term: string | null;
}

type Phase =
  | { kind: "idle" }
  | { kind: "uploading"; fileName: string; percent: number }
  | { kind: "parsing"; fileName: string }
  | { kind: "done"; result: UploadResult }
  /** The file is held here, so answering the question never means re-picking it. */
  | { kind: "duplicate"; file: File; duplicate: DuplicateCourse }
  | { kind: "error"; error: string; detail?: string };

/**
 * The upload route answers a duplicate with a 409 carrying `duplicateOf`. The
 * shared client hands back the envelope, not the status, so the field itself is
 * the signal -- and it is read defensively, because a server that has not
 * shipped this yet simply will not send it.
 */
function readDuplicate(result: unknown): DuplicateCourse | null {
  if (typeof result !== "object" || result === null) return null;
  const value = (result as { duplicateOf?: unknown }).duplicateOf;
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  return {
    id: record.id,
    code: typeof record.code === "string" ? record.code : "this course",
    title: typeof record.title === "string" ? record.title : "",
    term: typeof record.term === "string" ? record.term : null,
  };
}

export function UploadPanel({
  demoMode,
  accent,
  onUploaded,
  onAssessmentChanged,
  onCourseChanged,
  onCourseReplaced,
}: {
  demoMode: boolean;
  /** Accent the newly added course will carry elsewhere in the dashboard. */
  accent: string;
  onUploaded: (result: UploadResult) => void;
  /** Hand a confirmed or edited item back to the shell. */
  onAssessmentChanged?: (updated: Assessment) => void;
  /**
   * A course edited from inside this card — picking a section, so far. The
   * card holds its own copy of the course, so it updates here as well as in
   * the shell; otherwise the question would still be on screen after it was
   * answered.
   */
  onCourseChanged?: (updated: Course) => void;
  /**
   * A replace swaps one course for another: the shell has to drop the old one
   * and its assessments, which a plain "uploaded" would not tell it to do.
   */
  onCourseReplaced?: (oldCourseId: string, result: UploadResult) => void;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const onRowChanged = useCallback(
    (updated: Assessment) => {
      setPhase((current) =>
        current.kind === "done"
          ? {
              kind: "done",
              result: {
                ...current.result,
                assessments: current.result.assessments.map((item) =>
                  item.id === updated.id ? updated : item,
                ),
              },
            }
          : current,
      );
      onAssessmentChanged?.(updated);
    },
    [onAssessmentChanged],
  );

  const onCourseSaved = useCallback(
    (updated: Course) => {
      setPhase((current) =>
        current.kind === "done" && current.result.course.id === updated.id
          ? { kind: "done", result: { ...current.result, course: updated } }
          : current,
      );
      onCourseChanged?.(updated);
    },
    [onCourseChanged],
  );
  const [dragging, setDragging] = useState(false);

  const busy = phase.kind === "uploading" || phase.kind === "parsing";

  const send = useCallback(
    async (file: File, fields?: Record<string, string>) => {
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
        fields,
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
        const duplicate = readDuplicate(result);
        if (duplicate) {
          setPhase({ kind: "duplicate", file, duplicate });
          return;
        }
        setPhase({ kind: "error", error: result.error, detail: result.detail });
        return;
      }
      setPhase({ kind: "done", result: result.data });

      // `replaced` comes from the server; the id we sent is the fallback for a
      // server that performs the swap without reporting it.
      const replacedId = result.data.replaced ?? fields?.replace ?? null;
      if (replacedId && onCourseReplaced) onCourseReplaced(replacedId, result.data);
      else onUploaded(result.data);
    },
    [onUploaded, onCourseReplaced],
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
        <ExtractionResult
          result={phase.result}
          accent={accent}
          onChanged={onAssessmentChanged ? onRowChanged : undefined}
          onCourseChanged={onCourseChanged ? onCourseSaved : undefined}
        />
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

          {phase.kind === "duplicate" ? (
            <DuplicateChoice
              duplicate={phase.duplicate}
              fileName={phase.file.name}
              onReplace={() =>
                void send(phase.file, { replace: phase.duplicate.id })
              }
              onKeepBoth={() => void send(phase.file, { allowDuplicate: "1" })}
              onCancel={() => setPhase({ kind: "idle" })}
            />
          ) : null}

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

/**
 * A duplicate is a question, not a failure: the parse worked, and both answers
 * are reasonable (a re-upload of a corrected syllabus, or two real sections).
 * The file stays in the phase, so answering costs one click and not a trip back
 * to the file picker.
 */
function DuplicateChoice({
  duplicate,
  fileName,
  onReplace,
  onKeepBoth,
  onCancel,
}: {
  duplicate: DuplicateCourse;
  fileName: string;
  onReplace: () => void;
  onKeepBoth: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="alert"
      className="rise rounded-lg border border-warn-line bg-warn-soft p-4"
    >
      <p className="flex items-start gap-2 text-[0.875rem] leading-relaxed font-medium text-ink">
        <span className="mt-0.5 shrink-0 text-warn">
          <AlertIcon width={15} height={15} />
        </span>
        <span>
          You already have{" "}
          <span className="font-mono text-[0.8125rem]">{duplicate.code}</span>
          {duplicate.term ? ` (${duplicate.term})` : ""} — Replace it, or keep
          both?
        </span>
      </p>
      <p className="mt-1.5 pl-7 text-[0.75rem] leading-relaxed text-ink-soft">
        Replacing deletes the old course and its items, then saves{" "}
        <span className="break-all">{fileName}</span> in its place. Keeping both
        leaves the existing course untouched.
      </p>
      <div className="mt-3 flex flex-wrap gap-2 pl-7">
        <Button size="sm" onClick={onReplace}>
          Replace it
        </Button>
        <Button size="sm" variant="secondary" onClick={onKeepBoth}>
          Keep both
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ExtractionResult({
  result,
  accent,
  onChanged,
  onCourseChanged,
}: {
  result: UploadResult;
  accent: string;
  onChanged?: (updated: Assessment) => void;
  onCourseChanged?: (updated: Course) => void;
}) {
  const { course, assessments, warnings, notion } = result;
  const flagged = assessments.filter(needsReview);
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

        {/*
          Notion is a bonus on top of a finished upload, never a gate on it: a
          failure is reported as a quiet aside so the extraction above still
          reads as the success it is.
        */}
        {notion?.pageUrl ? (
          <a
            href={notion.pageUrl}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={`Open the Notion page for ${course.code}`}
            className="mt-3 inline-block rounded-sm text-[0.8125rem] font-medium text-accent transition-colors hover:text-ink"
          >
            Created your Notion page →
          </a>
        ) : notion?.error ? (
          <p className="mt-3 text-[0.75rem] leading-relaxed text-muted">
            Uploaded — Notion page couldn&rsquo;t be created: {notion.error}
          </p>
        ) : null}

        {/* Asked here, at the moment the syllabus is read, rather than left
            for the student to discover on a calendar full of other people's
            classes. */}
        {onCourseChanged && needsSection(course) ? (
          <div className="mt-3.5">
            <SectionChooser course={course} onChanged={onCourseChanged} />
          </div>
        ) : null}
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
              onChanged={onChanged}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}
