import type { Assessment, Course, MeetingTime } from "@/lib/types";
import { unansweredGroups } from "@/lib/sections";
import type { SectionGroup } from "@/lib/sections";
import { parseDaysOfWeek } from "@/lib/parse/dates";

/**
 * The questions a syllabus leaves open, and the answers turned into dates.
 *
 * A syllabus is a document about a course; the calendar is about one student.
 * Some gaps between the two cannot be closed by reading harder: the document
 * names the days a class meets and never its time; it schedules everything by
 * "Week N" and never says when Week 1 begins; it says "weekly" and never which
 * day. The extractor's job is to refuse to guess. This module's job is to ask
 * the one person who knows, and to do exactly what their answer implies.
 *
 * Everything here is pure. Deriving the questions from a course and its
 * assessments is what the UI renders; the resolvers are what the routes apply
 * once an answer arrives. Neither touches the store, so the same functions run
 * on the client (to show the questions) and on the server (to act on them),
 * and the two cannot disagree about what is being asked.
 */

/* -------------------------------------------------------------------------- */
/* Unknown times                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A meeting whose time the document never stated.
 *
 * `MeetingTime.startTime` is a string in the contract, and the extractor now
 * refuses to invent one -- so a class with days and no time is kept with its
 * times blank rather than dropped. Blank means unknown. Every consumer that
 * builds an event, a blackout, a Notion line or a sentence from a meeting must
 * skip a meeting for which this is true; the question below is how it gets
 * filled in.
 */
export const UNKNOWN_TIME = "";

export function meetingNeedsTime(m: Pick<MeetingTime, "startTime" | "endTime">): boolean {
  return !m.startTime || !m.endTime;
}

/* -------------------------------------------------------------------------- */
/* Week references                                                             */
/* -------------------------------------------------------------------------- */

/** "End of Week 10" -> { week: 10, edge: "end" }. Read from the item's own evidence. */
export interface WeekRef {
  week: number;
  /** "end of week" / "start of week", or null for a bare "Week 8". */
  edge: "start" | "end" | null;
  /** The phrase it came from, for the note that explains the placement. */
  phrase: string;
}

export function weekRefOf(a: Pick<Assessment, "sourceText" | "notes">): WeekRef | null {
  const text = `${a.sourceText ?? ""} ${a.notes ?? ""}`;
  const m = /\b(?:(end|start|beginning)\s+of\s+(?:the\s+)?)?week\s*(\d{1,2})\b/i.exec(text);
  if (!m) return null;
  const week = Number(m[2]);
  if (!Number.isInteger(week) || week < 1 || week > 30) return null;
  const edgeWord = m[1]?.toLowerCase();
  return {
    week,
    edge: edgeWord === "end" ? "end" : edgeWord ? "start" : null,
    phrase: m[0],
  };
}

/** ISO date arithmetic in UTC, so a day is a day regardless of the host's zone. */
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 0 = Sunday .. 6 = Saturday, for an ISO date. */
function weekdayOf(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

/** The Monday on or before `iso`. Weeks are counted Monday to Sunday. */
function mondayOf(iso: string): string {
  const wd = weekdayOf(iso);
  return addDays(iso, wd === 0 ? -6 : 1 - wd);
}

/**
 * The days this course meets, from its meetings that are the student's --
 * office hours excluded, since "end of the week" means the last class, not
 * the last time the professor is in. Empty when no meeting names days.
 */
function classDays(course: Pick<Course, "meetingTimes">): number[] {
  const days = new Set<number>();
  for (const m of course.meetingTimes ?? []) {
    if (m.kind === "office_hours") continue;
    for (const d of m.daysOfWeek) days.add(d);
  }
  return [...days].sort((a, b) => a - b);
}

/**
 * Where in the week a reference lands, given the week's Monday.
 *
 * "End of Week N" is the week's last class day when the course names its
 * days, else Friday -- a Sunday-night deadline would be a guess the document
 * did not make. "Start of Week N" and a bare "Week N" are the week's first
 * class day, else Monday. Either way the date is an inference from a stated
 * week, never a stated date, and the resolver says so on the item.
 */
function placeInWeek(monday: string, edge: WeekRef["edge"], days: number[]): string {
  // Sunday-indexed days mapped onto a Monday-based week: Mon=0 .. Sun=6.
  const offsets = days.map((d) => (d === 0 ? 6 : d - 1)).sort((a, b) => a - b);
  if (edge === "end") return addDays(monday, offsets.length ? offsets[offsets.length - 1] : 4);
  return addDays(monday, offsets.length ? offsets[0] : 0);
}

/** One resolved placement: what to write on the item, and why. */
export interface WeekPlacement {
  id: string;
  dueDate: string;
  notes: string;
}

/**
 * Every undated item that names a week, placed against the term start.
 *
 * Applied once `course.startDate` is known -- the answer to the "when does Week
 * 1 begin?" question -- and only to items that are still undated, so an item
 * the student has since dated by hand is never overwritten. The confidence of
 * a placed item is the caller's business; it should land at the review
 * threshold, because the week is stated and the day within it is not.
 */
export function resolveWeekRefs(
  course: Pick<Course, "startDate" | "meetingTimes">,
  assessments: Pick<Assessment, "id" | "dueDate" | "sourceText" | "notes">[],
): WeekPlacement[] {
  if (!course.startDate) return [];
  const week1 = mondayOf(course.startDate);
  const days = classDays(course);
  const out: WeekPlacement[] = [];
  for (const a of assessments) {
    if (a.dueDate !== null) continue;
    const ref = weekRefOf(a);
    if (!ref) continue;
    const monday = addDays(week1, 7 * (ref.week - 1));
    const dueDate = placeInWeek(monday, ref.edge, days);
    out.push({
      id: a.id,
      dueDate,
      notes: `Placed from "${ref.phrase}" and the term start you entered (${course.startDate}). The syllabus states the week, not the day -- check it.`,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Weekly rules                                                                */
/* -------------------------------------------------------------------------- */

/** "Business article review due each Sunday at 11:59PM" -> weekly, Sunday, 23:59. */
export interface WeeklyRule {
  /** Null when the document says weekly but never which day. */
  weekday: number | null;
  /** HH:MM when stated alongside the rule, else null. */
  time: string | null;
}

/**
 * Is this undated item a weekly rule, and does the document say which day?
 *
 * Only for an item that has no date and whose own evidence says it recurs.
 * The weekday, when present, is read by the same day parser the extractor
 * uses, from the sentence that states the rule -- never from elsewhere.
 */
export function weeklyRuleOf(a: Pick<Assessment, "dueDate" | "sourceText" | "notes" | "dueTime">): WeeklyRule | null {
  if (a.dueDate !== null) return null;
  const text = `${a.sourceText ?? ""} ${a.notes ?? ""}`;
  if (!/\b(?:weekly|every\s+week|each\s+week|per\s+week|each\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)|every\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday))\b/i.test(text)) {
    return null;
  }
  const dayWord = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/i.exec(text);
  const weekday = dayWord ? (parseDaysOfWeek(dayWord[1])[0] ?? null) : null;
  return { weekday, time: a.dueTime ?? null };
}

/** What an expanded weekly item looks like before it has an id. */
export type WeeklyItem = Omit<Assessment, "id" | "courseId">;

/**
 * One item per week of the term on the given weekday, from a weekly rule.
 *
 * Needs the term bounds; a weekly rule with no term is a question the
 * `term-start` question has to answer first, which is why that one is asked
 * before this one. A week wholly inside a no-class period is skipped -- the
 * work does not exist that week -- and a partial break is not, because a
 * Sunday deadline stands whether or not Thursday's class met.
 */
export function expandWeekly(
  course: Pick<Course, "startDate" | "endDate" | "noClass">,
  placeholder: Pick<Assessment, "title" | "kind" | "weightPercent" | "sourceText" | "dueTime" | "endTime">,
  weekday: number,
  time: string | null,
): WeeklyItem[] {
  if (!course.startDate || !course.endDate) return [];
  const out: WeeklyItem[] = [];
  // First occurrence of `weekday` on or after the term start.
  let d = course.startDate;
  while (weekdayOf(d) !== weekday) d = addDays(d, 1);
  let n = 1;
  for (; d <= course.endDate; d = addDays(d, 7), n += 1) {
    const monday = mondayOf(d);
    const sunday = addDays(monday, 6);
    const weekOff = (course.noClass ?? []).some((p) => p.start <= monday && p.end >= sunday);
    if (weekOff) continue;
    out.push({
      title: `${placeholder.title} ${n}`,
      kind: placeholder.kind,
      dueDate: d,
      dueTime: time ?? placeholder.dueTime ?? null,
      endTime: null,
      weightPercent: placeholder.weightPercent,
      sourceText: placeholder.sourceText,
      confidence: 0.6,
      reviewedAt: null,
      notes: `Expanded from a weekly rule on the day you chose. The syllabus states the rule, not this date -- check it.`,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* The questions                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One open question about one course. Each carries exactly what its input
 * needs and what its answer will change, so the card can say "this dates 8
 * items" rather than asking in the abstract.
 */
export type SetupQuestion =
  | {
      kind: "term-start";
      courseId: string;
      /** The undated items a start date will place, for the card to name. */
      affects: { id: string; title: string; phrase: string }[];
    }
  | {
      kind: "meeting-time";
      courseId: string;
      /** Index into `course.meetingTimes`, which is what the PATCH sends back. */
      meetingIndex: number;
      meeting: MeetingTime;
    }
  | {
      kind: "weekly-day";
      courseId: string;
      assessmentId: string;
      title: string;
      /** The sentence that states the rule, quoted on the card. */
      sourceText: string | null;
      rule: WeeklyRule;
    }
  | {
      kind: "section";
      courseId: string;
      group: SectionGroup;
    };

/**
 * Every question this course still needs answered, most consequential first.
 *
 * Order is impact, not discovery: a term start dates every week-numbered item
 * at once and unlocks the weekly questions, so it comes first; a class time
 * puts a series on the calendar; a weekly day places a series; a section
 * trims the calendar to the student's own. Nothing here is asked when the
 * document answers it, and nothing is asked twice -- an answered question
 * simply stops being derived.
 */
export function setupQuestions(course: Course, assessments: Assessment[]): SetupQuestion[] {
  const out: SetupQuestion[] = [];

  if (!course.startDate) {
    const affects = assessments
      .filter((a) => a.dueDate === null)
      .map((a) => ({ a, ref: weekRefOf(a) }))
      .filter((x): x is { a: Assessment; ref: WeekRef } => x.ref !== null)
      .map(({ a, ref }) => ({ id: a.id, title: a.title, phrase: ref.phrase }));
    if (affects.length > 0) out.push({ kind: "term-start", courseId: course.id, affects });
  }

  (course.meetingTimes ?? []).forEach((meeting, meetingIndex) => {
    if (meeting.kind === "office_hours") return;
    if (meetingNeedsTime(meeting)) out.push({ kind: "meeting-time", courseId: course.id, meetingIndex, meeting });
  });

  // Weekly rules can only be placed once the term has bounds; until then the
  // term-start question above is the one that matters.
  if (course.startDate && course.endDate) {
    for (const a of assessments) {
      const rule = weeklyRuleOf(a);
      if (!rule) continue;
      out.push({ kind: "weekly-day", courseId: course.id, assessmentId: a.id, title: a.title, sourceText: a.sourceText, rule });
    }
  }

  for (const group of unansweredGroups(course)) {
    out.push({ kind: "section", courseId: course.id, group });
  }

  return out;
}

/** How many questions a course has open -- what the panels badge and the sync panel warns about. */
export function openQuestionCount(course: Course, assessments: Assessment[]): number {
  return setupQuestions(course, assessments).length;
}
