import type { Course, MeetingKind, MeetingTime } from "@/lib/types";

/**
 * Which of a syllabus's meetings this student actually attends.
 *
 * A big course's syllabus describes the whole course, not one student's
 * timetable: two lectures, three labs, four recitations, and the student is in
 * exactly one of each. Everything here exists to answer one question -- given
 * what the student has told us, which of these meetings are theirs?
 *
 * It lives in `lib` rather than beside the chooser because the calendar, the
 * study scheduler and the UI must all answer that question identically. Two
 * implementations would eventually put a student in a lab they do not attend.
 */

/** Trailing/leading space and inner runs collapse; "b " off a form finds "B". */
export function normalizeSection(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * What to call one group's question. Deliberately the student's word, not the
 * schema's: nobody is enrolled in an "office_hours".
 */
const GROUP_QUESTION: Record<MeetingKind, string> = {
  lecture: "Which lecture section are you in?",
  recitation: "Which recitation are you in?",
  lab: "Which lab are you in?",
  office_hours: "Which office hours do you attend?",
  other: "Which section are you in?",
};

/** The short form, for a heading beside a checkmark. */
const GROUP_LABEL: Record<MeetingKind, string> = {
  lecture: "Lecture",
  recitation: "Recitation",
  lab: "Lab",
  office_hours: "Office hours",
  other: "Section",
};

/**
 * One question the syllabus forces on the student, with its answers.
 *
 * A group exists only where there is a genuine choice: two or more distinct
 * labels of the same kind. A course with one lecture and three labs asks about
 * the labs and says nothing about the lecture, because there is nothing to ask
 * -- the single lecture is everybody's.
 */
export interface SectionGroup {
  kind: MeetingKind;
  /** "Lab" */
  label: string;
  /** "Which lab are you in?" */
  question: string;
  /** The labels offered, in the order the syllabus listed them. */
  options: SectionOption[];
  /** The label this student picked, or null while the question is open. */
  chosen: string | null;
}

export interface SectionOption {
  /** The label exactly as the syllabus writes it -- "LAB B", "003". */
  label: string;
  /** Every meeting carrying that label, in syllabus order. */
  meetings: MeetingTime[];
}

/** The kinds in the order a student thinks about their week. */
const KIND_ORDER: MeetingKind[] = [
  "lecture",
  "recitation",
  "lab",
  "other",
  "office_hours",
];

/**
 * Every question this syllabus asks, answered or not.
 *
 * Grouping is by meeting kind, which is what makes the whole thing work: the
 * labels "LEC 01, LEC 02, LAB A, LAB B, LAB C" are not five alternatives, they
 * are two questions. Pooling them into one list -- the shape this replaced --
 * meant a student who answered "LEC 01" was silently recorded as attending no
 * lab at all, and the labs never reached their calendar.
 */
export function sectionGroups(course: Course): SectionGroup[] {
  const byKind = new Map<MeetingKind, Map<string, SectionOption>>();

  for (const meeting of course.meetingTimes ?? []) {
    const label = meeting.section?.trim();
    if (!label) continue; // applies to everyone; never a choice
    const options = byKind.get(meeting.kind) ?? new Map<string, SectionOption>();
    const key = normalizeSection(label);
    const option = options.get(key) ?? { label, meetings: [] };
    option.meetings.push(meeting);
    options.set(key, option);
    byKind.set(meeting.kind, options);
  }

  const chosen = chosenSet(course);
  const groups: SectionGroup[] = [];
  for (const kind of KIND_ORDER) {
    const options = byKind.get(kind);
    // One label is not a choice: that meeting is everybody's, and asking about
    // it would be asking a question with a single answer.
    if (!options || options.size < 2) continue;
    const list = [...options.values()];
    groups.push({
      kind,
      label: GROUP_LABEL[kind],
      question: GROUP_QUESTION[kind],
      options: list,
      chosen: list.find((o) => chosen.has(normalizeSection(o.label)))?.label ?? null,
    });
  }
  return groups;
}

/** The student's answers, normalized for comparison. */
function chosenSet(course: Course): Set<string> {
  return new Set(
    (course.sections ?? [])
      .map((s) => s?.trim())
      .filter((s): s is string => Boolean(s))
      .map(normalizeSection),
  );
}

/** The questions still open. Empty means this course is fully answered. */
export function unansweredGroups(course: Course): SectionGroup[] {
  return sectionGroups(course).filter((group) => group.chosen === null);
}

/**
 * Is anything still unanswered? While this is true the meetings belonging to
 * the open groups are withheld from the calendar, because guessing puts the
 * student in someone else's classroom at someone else's hour -- and an empty
 * slot asks a question a wrong slot does not.
 */
export function needsSection(course: Course): boolean {
  return unansweredGroups(course).length > 0;
}

/**
 * The meetings this student attends: the ones that apply to everyone, the ones
 * whose kind offered no choice, and their own answer within each group they
 * did have to choose from. A group they have not answered yet contributes
 * nothing.
 */
export function meetingsForStudent(course: Course): MeetingTime[] {
  const groups = sectionGroups(course);
  const contested = new Map(groups.map((g) => [g.kind, g]));

  return (course.meetingTimes ?? []).filter((meeting) => {
    const label = meeting.section?.trim();
    if (!label) return true; // office hours, single-section courses
    const group = contested.get(meeting.kind);
    // A label whose kind never offered an alternative is not a choice the
    // student declined to make -- it is the only one there was.
    if (!group) return true;
    if (group.chosen === null) return false;
    return normalizeSection(group.chosen) === normalizeSection(label);
  });
}

/**
 * The answers a student may hold at once: at most one per group, and only
 * labels this syllabus actually names.
 *
 * Applied on the way in so a stale or hand-made request cannot enrol someone in
 * a section that does not exist, and so answering "LAB C" replaces "LAB A"
 * rather than accumulating both.
 */
export function reconcileSections(
  course: Course,
  requested: readonly string[],
): string[] {
  const groups = sectionGroups(course);
  const accepted: string[] = [];

  for (const group of groups) {
    // Last answer wins, so a re-answer of the same group replaces rather than
    // adds. Matching is by label, not position: the client sends labels back.
    let pick: string | null = null;
    for (const raw of requested) {
      const wanted = normalizeSection(raw ?? "");
      if (!wanted) continue;
      const option = group.options.find(
        (o) => normalizeSection(o.label) === wanted,
      );
      if (option) pick = option.label;
    }
    if (pick) accepted.push(pick);
  }
  return accepted;
}
