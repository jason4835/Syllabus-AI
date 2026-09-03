import type { Assessment, Course } from "@/lib/types";
import { Panel } from "@/components/ui/panel";
import { ListIcon, UploadIcon } from "@/components/icons";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { LoadingRegion, SkeletonRows } from "@/components/ui/skeleton";
import { AssessmentRow } from "@/components/dashboard/assessment-row";
import { accentFor } from "@/components/course-accents";
import { daysUntil } from "@/components/format";

const LIMIT = 10;

export function UpcomingPanel({
  loading,
  error,
  courses,
  assessments,
  accents,
  onRetry,
  onAssessmentChanged,
  onAssessmentDeleted,
}: {
  loading: boolean;
  error?: { error: string; detail?: string };
  courses: Course[];
  assessments: Assessment[];
  accents: Record<string, string>;
  onRetry: () => void;
  /** Hand a confirmed or edited item back to the shell. */
  onAssessmentChanged?: (updated: Assessment) => void;
  /** Remove a deleted item from the shell's state. */
  onAssessmentDeleted?: (id: string) => void;
}) {
  const byId = new Map(courses.map((course) => [course.id, course]));

  const upcoming = assessments
    .filter((item) => {
      const days = daysUntil(item.dueDate ?? "");
      return days !== null && days >= 0;
    })
    .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""))
    .slice(0, LIMIT);

  const undated = assessments.filter((item) => !item.dueDate).length;

  return (
    <Panel
      id="upcoming"
      title="Upcoming"
      icon={<ListIcon width={17} height={17} />}
      description="The next ten things due, across every course."
    >
      {loading ? (
        <LoadingRegion label="Loading upcoming work">
          <SkeletonRows rows={4} />
        </LoadingRegion>
      ) : error ? (
        <ErrorState error={error.error} detail={error.detail} onRetry={onRetry} />
      ) : upcoming.length === 0 ? (
        <EmptyState
          icon={<UploadIcon width={22} height={22} />}
          title={
            assessments.length === 0
              ? "Nothing scheduled yet"
              : "Nothing left on the calendar"
          }
          body={
            assessments.length === 0
              ? "Upload a syllabus and every deadline in it shows up here, sorted by what is closest."
              : "Every dated item in your courses is already in the past. Upload another syllabus to keep going."
          }
        />
      ) : (
        <>
          <ul className="divide-y divide-line">
            {upcoming.map((assessment) => (
              <AssessmentRow
                key={assessment.id}
                assessment={assessment}
                courseCode={byId.get(assessment.courseId)?.code ?? "Course"}
                color={accentFor(accents, assessment.courseId)}
                showConfidence
                onChanged={onAssessmentChanged}
                onDeleted={onAssessmentDeleted}
              />
            ))}
          </ul>
          {undated > 0 ? (
            <p className="mt-3 border-t border-line pt-3 text-[0.8125rem] text-muted">
              {undated} more {undated === 1 ? "item has" : "items have"} no
              resolvable due date and are not listed here.
            </p>
          ) : null}
        </>
      )}
    </Panel>
  );
}
