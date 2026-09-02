/**
 * Class-page body and database-row builders. **Pure: no store, no network.**
 *
 * This file is the single definition of what a Syllabus AI page *looks like*.
 * Keeping it free of I/O means the layout can be asserted directly in a test
 * -- "does the grading table have one row per weight", "does every schedule
 * entry link to its assignment" -- without a Notion workspace, and it means
 * `sync.ts` reads as orchestration rather than as a wall of block literals.
 *
 * Two Notion limits shape everything here:
 *
 * - **2000 characters per rich_text object.** A late-work policy quoted from a
 *   syllabus routinely runs longer, so all text goes through `richText`, which
 *   splits at the limit into several objects in the same block. Notion renders
 *   them as one continuous run, so the split is invisible.
 * - **100 children per append.** `buildCoursePageBlocks` returns the whole
 *   body as one flat array -- that is the thing worth testing -- and the
 *   caller is responsible for splitting it with `chunkBlocks` before sending.
 *   Chunking here would force the pure function to know about request shapes.
 */

import type { BlockObjectRequest, CreatePageParameters } from "@notionhq/client";
import { estimatedHoursFor, formatShortDate } from "@/lib/plan/workload";
import type {
  Assessment,
  Course,
  CoursePolicy,
  MeetingTime,
  StudyBlock,
} from "@/lib/types";

/** Notion's hard cap on one rich_text object's `content`. */
export const RICH_TEXT_LIMIT = 2000;

/** Notion's hard cap on `children` in a single append (and on page creation). */
export const CHILDREN_PER_APPEND = 100;

/**
 * Property bags for `pages.create` / `pages.update`. Both endpoints take the
 * same shape, so one alias keeps the row builders usable by either.
 */
export type PageProperties = NonNullable<CreatePageParameters["properties"]>;

/** Rich-text items are what nearly every field and block is made of. */
type RichText = Extract<BlockObjectRequest, { paragraph: unknown }>["paragraph"]["rich_text"];

/* -------------------------------------------------------------------------- */
/* Text helpers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Text as rich_text, split across as many objects as the 2000-char limit
 * requires. Empty input yields an empty array, which is how Notion spells "no
 * value" for a rich_text property.
 */
export function richText(content: string): RichText {
  if (!content) return [];
  const parts: RichText = [];
  for (let i = 0; i < content.length; i += RICH_TEXT_LIMIT) {
    parts.push({ type: "text", text: { content: content.slice(i, i + RICH_TEXT_LIMIT) } });
  }
  return parts;
}

/** A link to another Notion page, rendered inline as the page's live title. */
function pageMention(pageId: string): RichText[number] {
  return { type: "mention", mention: { type: "page", page: { id: pageId } } };
}

/** Splits a body into append-sized batches. See the file header for why here. */
export function chunkBlocks(
  blocks: BlockObjectRequest[],
  size: number = CHILDREN_PER_APPEND,
): BlockObjectRequest[][] {
  const chunks: BlockObjectRequest[][] = [];
  for (let i = 0; i < blocks.length; i += size) chunks.push(blocks.slice(i, i + size));
  return chunks;
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

const DAY_LETTERS = ["Su", "M", "T", "W", "Th", "F", "Sa"];

/** "MWF 10:00-10:50 - Hayes Hall 210" */
export function formatMeetingTime(m: MeetingTime): string {
  const days = m.daysOfWeek
    .slice()
    .sort((a, b) => a - b)
    .map((d) => DAY_LETTERS[d] ?? "?")
    .join("");
  const when = `${days} ${m.startTime}–${m.endTime}`;
  return m.location ? `${when} · ${m.location}` : when;
}

const POLICY_LABELS: Record<CoursePolicy["category"], string> = {
  late_work: "Late work",
  attendance: "Attendance",
  integrity: "Academic integrity",
  grading: "Grading",
  other: "Other",
};

const KIND_LABELS: Record<Assessment["kind"], string> = {
  assignment: "Assignment",
  exam: "Exam",
  quiz: "Quiz",
  project: "Project",
  reading: "Reading",
  lab: "Lab",
  presentation: "Presentation",
  other: "Other",
};

/** `MATH 221 -- Multivariable Calculus`, the Courses row title. */
export function courseTitle(course: Course): string {
  return course.title ? `${course.code} — ${course.title}` : course.code;
}

/**
 * The term line, e.g. "Fall 2026 - Aug 24 - Dec 18". Returns null when the
 * syllabus gave neither a label nor dates, so the caller can drop the row
 * rather than print "Term - ".
 */
function formatTerm(course: Course): string | null {
  const span =
    course.startDate && course.endDate
      ? `${formatShortDate(course.startDate)} – ${formatShortDate(course.endDate)}`
      : null;
  if (course.term && span) return `${course.term} · ${span}`;
  return course.term ?? span;
}

function formatInstructor(course: Course): string | null {
  return course.instructor;
}

/** Assessments in the order a student reads a schedule: by date, undated last. */
function bySchedule(a: Assessment, b: Assessment): number {
  if (a.dueDate === b.dueDate) return a.title.localeCompare(b.title);
  if (a.dueDate === null) return 1;
  if (b.dueDate === null) return -1;
  return a.dueDate < b.dueDate ? -1 : 1;
}

/* -------------------------------------------------------------------------- */
/* Row properties -- shared by sync and its tests                              */
/* -------------------------------------------------------------------------- */

/**
 * A Courses row.
 *
 * `Syllabus AI ID` is on every row in every database on purpose: it is the
 * recovery key if the link table is ever lost, and it is the join that a
 * future status-pull-back would need.
 */
export function courseProperties(course: Course): PageProperties {
  const props: PageProperties = {
    Name: { title: richText(courseTitle(course)) },
    Code: { rich_text: richText(course.code) },
    Instructor: { rich_text: richText(course.instructor ?? "") },
    Term: { rich_text: richText(course.term ?? "") },
    Meets: {
      rich_text: richText(course.meetingTimes.map(formatMeetingTime).join(" · ")),
    },
    "Syllabus AI ID": { rich_text: richText(course.id) },
  };

  // A date property with a null start is rejected; omit the range entirely
  // when the syllabus never gave one.
  props.Dates = course.startDate
    ? { date: { start: course.startDate, end: course.endDate ?? null } }
    : { date: null };

  return props;
}

export interface AssessmentPropertyOptions {
  /**
   * True only when the row is being created. `Status` is written once and
   * never again: the design makes Notion the source of truth for status, so a
   * re-sync that re-asserted "Not started" would silently un-tick work the
   * student had already marked done.
   */
  initial?: boolean;
}

/** An Assignments row. `coursePageId` is null when the course page is unknown. */
export function assessmentProperties(
  assessment: Assessment,
  coursePageId: string | null,
  options: AssessmentPropertyOptions = {},
): PageProperties {
  const props: PageProperties = {
    Name: { title: richText(assessment.title) },
    Course: { relation: coursePageId ? [{ id: coursePageId }] : [] },
    Type: { select: { name: KIND_LABELS[assessment.kind] } },
    // Notion's `percent` number format multiplies by 100 for display, so a
    // syllabus's "18%" is stored as 0.18. Storing 18 would render "1800%".
    Weight: {
      number: assessment.weightPercent === null ? null : assessment.weightPercent / 100,
    },
    "Est. hours": { number: estimatedHoursFor(assessment) },
    // The extractor's own confidence, surfaced as a checkbox the student can
    // filter on -- "what did the parser guess at" is a real question.
    "Needs review": { checkbox: assessment.confidence < 0.6 },
    "Syllabus AI ID": { rich_text: richText(assessment.id) },
  };

  props.Due = assessment.dueDate
    ? {
        date: {
          start: assessment.dueTime
            ? `${assessment.dueDate}T${assessment.dueTime}:00`
            : assessment.dueDate,
        },
      }
    : { date: null };

  if (options.initial) props.Status = { select: { name: "Not started" } };

  return props;
}

export interface SessionPropertyOptions {
  /** True on create only -- see `AssessmentPropertyOptions.initial`. */
  initial?: boolean;
}

/** A Study Sessions row. */
export function sessionProperties(
  block: StudyBlock,
  coursePageId: string | null,
  assessmentPageId: string | null,
  options: SessionPropertyOptions = {},
): PageProperties {
  const props: PageProperties = {
    Name: { title: richText(block.title) },
    Course: { relation: coursePageId ? [{ id: coursePageId }] : [] },
    Assignment: { relation: assessmentPageId ? [{ id: assessmentPageId }] : [] },
    When: { date: { start: block.start, end: block.end } },
    Why: { rich_text: richText(block.rationale) },
    "Syllabus AI ID": { rich_text: richText(block.id) },
  };

  if (options.initial) props.Done = { checkbox: false };

  return props;
}

/* -------------------------------------------------------------------------- */
/* The class-page body                                                         */
/* -------------------------------------------------------------------------- */

export interface CoursePageOptions {
  /** Injected so the callout's date is assertable. Defaults to now. */
  now?: Date;
}

/**
 * The body of a Courses row -- the thing a student would otherwise spend an
 * evening building.
 *
 * Written once, on create, and never rewritten: everything after the divider
 * belongs to the student. That is why the schedule entries are `mention`
 * links rather than copied text -- a due date that moves is corrected in the
 * Assignments row, and this list keeps pointing at the truth without anyone
 * touching the page.
 *
 * @param links assessment id -> Notion page id, for the schedule mentions.
 *              An assessment with no entry degrades to plain text rather than
 *              being dropped: a listed deadline beats a missing one.
 */
export function buildCoursePageBlocks(
  course: Course,
  assessments: Assessment[],
  links: Map<string, string>,
  options: CoursePageOptions = {},
): BlockObjectRequest[] {
  const now = options.now ?? new Date();
  const syncedOn = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(now);

  const blocks: BlockObjectRequest[] = [];

  // The contract with the student, stated on the page itself rather than in a
  // help doc nobody opens.
  blocks.push({
    callout: {
      icon: { type: "emoji", emoji: "\u{1F4A1}" },
      rich_text: richText(
        `Synced from Syllabus AI on ${syncedOn}. Properties stay current on re-sync; everything below the divider is yours and is never touched.`,
      ),
    },
  });

  /* --- Course info --- */
  blocks.push({ heading_2: { rich_text: richText("Course info") } });

  const info: Array<[string, string]> = [];
  const instructor = formatInstructor(course);
  if (instructor) info.push(["Instructor", instructor]);
  if (course.meetingTimes.length > 0) {
    info.push(["Meets", course.meetingTimes.map(formatMeetingTime).join(" · ")]);
  }
  const term = formatTerm(course);
  if (term) info.push(["Term", term]);

  if (info.length === 0) {
    blocks.push({
      paragraph: { rich_text: richText("The syllabus did not state course details.") },
    });
  } else {
    for (const [label, value] of info) {
      blocks.push({
        paragraph: {
          rich_text: [
            { type: "text", text: { content: `${label} · ` }, annotations: { bold: true } },
            ...richText(value),
          ],
        },
      });
    }
  }

  /* --- Grading --- */
  blocks.push({ heading_2: { rich_text: richText("Grading") } });

  if (course.gradeWeights.length === 0) {
    blocks.push({
      paragraph: { rich_text: richText("The syllabus did not state a grading breakdown.") },
    });
  } else {
    blocks.push({
      table: {
        table_width: 2,
        has_column_header: false,
        has_row_header: false,
        children: course.gradeWeights.map((w) => ({
          table_row: {
            cells: [richText(w.category), richText(`${w.weightPercent}%`)],
          },
        })),
      },
    });
  }

  /* --- Schedule --- */
  blocks.push({ heading_2: { rich_text: richText("Schedule") } });

  const scheduled = assessments.slice().sort(bySchedule);
  if (scheduled.length === 0) {
    blocks.push({
      paragraph: { rich_text: richText("No dated work was found in this syllabus.") },
    });
  } else {
    for (const a of scheduled) {
      const pageId = links.get(a.id);
      const line: RichText = [
        // Fixed-width-ish date prefix so the list scans as a column.
        { type: "text", text: { content: `${a.dueDate ? formatShortDate(a.dueDate) : "TBD"}  ` } },
        // The mention is the whole point: this list is a table of contents
        // into live rows, not a second copy of the schedule.
        ...(pageId ? [pageMention(pageId)] : richText(a.title)),
      ];
      if (a.weightPercent !== null) {
        line.push({
          type: "text",
          text: { content: `  · ${a.weightPercent}%` },
          annotations: { color: "gray" },
        });
      }
      blocks.push({ bulleted_list_item: { rich_text: line } });
    }
  }

  /* --- Policies --- */
  if (course.policies.length > 0) {
    blocks.push({ heading_2: { rich_text: richText("Policies") } });
    for (const policy of course.policies) {
      blocks.push({
        // Collapsed by default: policy text is long and is reference material,
        // not something to read past on the way to the schedule.
        toggle: {
          rich_text: richText(POLICY_LABELS[policy.category]),
          children: [{ paragraph: { rich_text: richText(policy.summary) } }],
        },
      });
    }
  }

  /* --- The student's half --- */
  blocks.push({ divider: {} });
  blocks.push({ heading_2: { rich_text: richText("Your notes") } });

  return blocks;
}
