/**
 * Deterministic, no-API-key syllabus parser.
 *
 * Two jobs, both load-bearing:
 *   1. Demo mode. Without an OPENAI_API_KEY the product still has to show a
 *      real course, so this has to be genuinely good -- not a stub.
 *   2. Insurance. When the OpenAI call fails mid-upload, the user gets this
 *      instead of an error page.
 *
 * The governing rule is honesty over coverage. Every item it emits carries a
 * confidence in the 0.4-0.6 band (the UI surfaces anything under 0.6 for
 * review) and the result always carries a warning saying pattern matching, not
 * AI, produced it. It would be easy to make this look more confident than it
 * is; that would be the wrong trade, because a student who trusts a wrong due
 * date misses a real deadline.
 */

import type {
  AssessmentKind,
  CoursePolicy,
  GradeWeight,
  MeetingKind,
  MeetingTime,
  NoClassPeriod,
  ParsedSyllabus,
} from "../types";
import {
  addDays,
  findDateSpans,
  isoDayOfWeek,
  normalizeDate,
  normalizeDateRange,
  parseDaysOfWeek,
  parseTime,
  parseTimeRange,
  termWindowFromLabel,
  type DateContext,
} from "./dates";

type LooseAssessment = ParsedSyllabus["assessments"][number];

/** Options let the caller explain WHY the fallback ran, which becomes a user-visible warning. */
export interface FallbackOptions {
  /** e.g. "the AI extractor timed out". Appended to the standard heuristic warning. */
  reason?: string;
}

/**
 * Kind classification, most specific first.
 *
 * Order is the whole design here: "Project final report" has to reach the
 * project rule before the generic "report -> assignment" rule, and "Final Exam"
 * has to beat both.
 */
const KIND_RULES: Array<{ re: RegExp; kind: AssessmentKind; strong: boolean }> = [
  { re: /\bfinal\s+(?:exam|examination)\b/i, kind: "exam", strong: true },
  { re: /\bmidterm\b/i, kind: "exam", strong: true },
  { re: /\bquiz(?:zes)?\b/i, kind: "quiz", strong: true },
  { re: /\b(?:problem\s+set|p-?set|homework|hw)\b/i, kind: "assignment", strong: true },
  { re: /\b(?:lab|laboratory)\b/i, kind: "lab", strong: true },
  { re: /\b(?:project|capstone|proposal|portfolio|thesis)\b/i, kind: "project", strong: true },
  { re: /\b(?:presentation|poster|demo\s+day)\b/i, kind: "presentation", strong: true },
  // A bare "final" means the final exam ONLY when it is not modifying some other
  // deliverable. Without the lookahead, "final report" and "final paper" get
  // filed as exams -- and a wrong kind propagates: weights.ts joins the grading
  // table on to assessments by name, so a phantom "exam" inherits the real final
  // exam's weight.
  {
    re: /\b(?:exam|examination|test)\b|\bfinal\b(?!\s+(?:project|report|paper|essay|portfolio|presentation|draft|submission|deliverable|write-?up))/i,
    kind: "exam",
    strong: true,
  },
  {
    re: /\b(?:assignment|paper|essay|report|write-?up|discussion\s+post|response|reflection)\b/i,
    kind: "assignment",
    strong: false,
  },
  { re: /\b(?:reading|readings|read\s+chapters?)\b/i, kind: "reading", strong: false },
];

/** Words that are never the name of a graded item, used to trim titles from the right. */
const TITLE_STOPWORDS = new Set([
  "due",
  "by",
  "on",
  "at",
  "in",
  "is",
  "are",
  "be",
  "will",
  "scheduled",
  "for",
  "from",
  "of",
  "the",
  "class",
  "week",
  "posted",
  "handed",
  "out",
  "week's",
]);

/** Full names included: "Final Exam: Wednesday," must trim all the way back to "Final Exam". */
const WEEKDAY_RE =
  /^(?:sunday|sun|monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\.?$/i;

/** All-caps token pairs that look like a course code but aren't. */
const CODE_BLOCKLIST = new Set(["ROOM", "RM", "HALL", "BLDG", "AM", "PM", "TBA", "TBD", "ISBN", "PO"]);

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

// ---------------------------------------------------------------------------
// Course header
// ---------------------------------------------------------------------------

function findCourseCode(lines: string[]): { code: string | null; lineIndex: number } {
  // Course codes live in the header. Scanning the whole document would happily
  // return "MATH 122" from the prerequisites line instead.
  const horizon = Math.min(lines.length, 80);
  const re = /\b([A-Z]{2,5})\s?[-/]?\s?(\d{3}[A-Z]?)\b/g;

  for (let i = 0; i < horizon; i += 1) {
    const line = lines[i];
    if (/\b(?:prerequisite|pre-?req|corequisite|textbook|isbn)\b/i.test(line)) continue;
    re.lastIndex = 0;
    for (let m = re.exec(line); m !== null; m = re.exec(line)) {
      const dept = m[1].toUpperCase();
      if (CODE_BLOCKLIST.has(dept)) continue;
      // "Hayes Hall 210" -- a room number trailing a proper noun, not a code.
      if (/\b(?:room|hall|bldg|building|suite|office)\s*$/i.test(line.slice(0, m.index))) continue;
      return { code: `${dept} ${m[2]}`, lineIndex: i };
    }
  }
  return { code: null, lineIndex: -1 };
}

function findTitle(lines: string[], code: string | null, codeLine: number): string {
  const stripTerm = (s: string): string =>
    collapse(s.replace(/\b(?:fall|spring|summer|winter|autumn)\s*,?\s*20\d{2}\b/i, "").replace(/[-–—:,\s]+$/, ""));

  if (code && codeLine >= 0) {
    // "MATH 221 - Multivariable Calculus": everything after the number is the title.
    const line = lines[codeLine];
    const afterCode = line.replace(new RegExp(`^.*?${code.split(" ")[1]}`), "");
    const tail = stripTerm(afterCode.replace(/^[\s\-–—:|.]+/, ""));
    if (tail.length >= 3) return tail;

    // Title on the following line is the other common layout.
    for (let i = codeLine + 1; i < Math.min(lines.length, codeLine + 4); i += 1) {
      const candidate = stripTerm(lines[i]);
      if (candidate.length >= 3 && !/^[-=_*.]+$/.test(candidate)) return candidate;
    }
  }

  const labelled = lines.find((l) => /^\s*course\s+(?:title|name)\s*[:\-]/i.test(l));
  if (labelled) {
    const value = stripTerm(labelled.replace(/^\s*course\s+(?:title|name)\s*[:\-]\s*/i, ""));
    if (value.length >= 3) return value;
  }

  return code ?? "Untitled course";
}

/**
 * A person's name with the contact noise stripped off.
 *
 * Shared by the course-level instructor and by the meeting scanner, which has
 * to answer the same question about a "Teaching Assistant: ..." line and about
 * an instructor column in a section table.
 */
function cleanPersonName(raw: string): string | null {
  const name = collapse(
    raw
      .replace(/\([^)]*@[^)]*\)/g, "")
      .replace(/[\w.+-]+@[\w.-]+\.\w+/g, "")
      .replace(/^[\s,;|:.\-–—]+/, "")
      .replace(/[\s,;|]+$/, ""),
  );
  if (name.length < 2 || name.length > 80) return null;
  // "Instructor: TBA" names nobody, and putting "TBA" on an event as the person
  // running it reads as a fact the syllabus never stated.
  if (/^(?:tba|tbd|staff|n\/a|none)$/i.test(name)) return null;
  return name;
}

function findInstructor(lines: string[]): string | null {
  const re = /^\s*(?:instructor|professor|lecturer|teacher|faculty|taught\s+by)s?\s*[:\-]\s*(.+)$/i;
  for (const line of lines) {
    const m = re.exec(line);
    if (!m) continue;
    const name = cleanPersonName(m[1]);
    if (name) return name;
  }
  return null;
}

function findTerm(text: string): string | null {
  const m = /\b(fall|spring|summer|winter|autumn)\s*,?\s*(20\d{2})\b/i.exec(text);
  if (!m) return null;
  const season = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return `${season} ${m[2]}`;
}

/**
 * Term bounds the syllabus actually printed, distinguished from a guess.
 *
 * `explicit` gates whether these reach `Course.startDate` -- a seasonal guess is
 * good enough to disambiguate a year but must never be shown as a fact.
 */
function findTermRange(
  lines: string[],
  seasonal: DateContext,
): { start: string | null; end: string | null; explicit: boolean } {
  const rangeLine = lines.find((l) =>
    /\b(?:term|semester|quarter|course)\s+dates?\b|\bterm\s*[:\-]\s*\w+\s+\d/i.test(l),
  );
  if (rangeLine) {
    const { start, end } = normalizeDateRange(rangeLine, seasonal);
    if (start && end && start < end) return { start, end, explicit: true };
  }

  // Otherwise stitch bounds together from the two lines schools almost always
  // print: a first day of class and a last day / finals week.
  const startLine = lines.find((l) =>
    /\b(?:classes?\s+(?:begin|start)|first\s+day\s+of\s+class(?:es)?|instruction\s+begins)\b/i.test(l),
  );
  const endLine = lines.find((l) =>
    /\b(?:last\s+day\s+of\s+class(?:es)?|classes?\s+end|finals?\s+week|final\s+exam\s+(?:period|week))\b/i.test(l),
  );
  const start = startLine ? normalizeDate(startLine, seasonal) : null;
  const end = endLine ? normalizeDateRange(endLine, seasonal).end : null;
  if (start && end && start < end) return { start, end, explicit: true };

  return { start: seasonal.termStart ?? null, end: seasonal.termEnd ?? null, explicit: false };
}

// ---------------------------------------------------------------------------
// Meeting times
// ---------------------------------------------------------------------------

/**
 * What a labelled line is, most specific first.
 *
 * Office hours come first because they are the pattern most likely to be
 * mistaken for a class: same days, same times, same rooms. They are no longer
 * discarded -- a student wants them on the calendar -- but they must carry the
 * `office_hours` kind, because everything downstream (titles, defaults, the
 * user's sync preferences) keys off it and "MATH 221 class" at the professor's
 * door twice a week is a wrong fact, not a cosmetic one.
 */
const MEETING_KIND_RULES: Array<{ re: RegExp; kind: MeetingKind }> = [
  { re: /\b(?:office|student|drop-?in)\s+hours?\b/i, kind: "office_hours" },
  // "OH" only where it is used as a label; the word boundary and the colon keep
  // it away from ordinary prose.
  { re: /\bOH\b\s*[:\-]/, kind: "office_hours" },
  {
    re: /\b(?:recitation|discussion|section\s+meetings?|problem\s+sessions?|tutorial|workshop)\b/i,
    kind: "recitation",
  },
  { re: /\b(?:lab|laboratory)\b/i, kind: "lab" },
  { re: /\b(?:lecture|classes?|meets|meetings?|seminar|studio)\b/i, kind: "lecture" },
];

function classifyMeetingLabel(text: string): MeetingKind | null {
  for (const rule of MEETING_KIND_RULES) {
    if (rule.re.test(text)) return rule.kind;
  }
  return null;
}

/**
 * A leading label, e.g. "Lecture:", "Section 002:", "Office hours:".
 *
 * Stripping it matters beyond tidiness: the compact day-code scanner reads the
 * letters T, U and R out of the word "LECTURE" if the label is left in place.
 * Digits are allowed in the label so "Section 002:" is recognised as one.
 *
 * The colon must be followed by whitespace. Without that requirement the
 * pattern swallows the front of any line up to the colon inside a time --
 * "Section 001  MWF 9:00-9:50" would be read as a label of "Section 001  MWF 9"
 * and the meeting would be lost.
 */
const MEETING_LABEL_RE = /^\s*([A-Za-z][A-Za-z0-9 .()\/&'#-]{0,34}):(?=\s|$)\s*/;

/**
 * A section label written the way registrars write them: a keyword, a
 * separator, and a short code -- "Section A", "Sec. 01", "LEC 1", "Lab 003".
 *
 * The separator is REQUIRED. Without it the pattern happily reads "Lecture" as
 * the keyword "Lec" plus the label "ture", and every single-section syllabus
 * would start claiming it has a section called "Lecture".
 */
const SECTION_LABEL_RE =
  /^[\s\-*•|]*((?:section|sect|sec|lecture|lec|recitation|rec|discussion|disc|lab|seminar|group)s?\.?[\s#]+[A-Za-z0-9][A-Za-z0-9-]{0,5})\b/i;

/**
 * A bare section code in the first column of a table -- "001", "A", "L2".
 *
 * Only ever applied to a delimited row, where the surrounding columns say what
 * the cell is. On a prose line it would match far too much.
 */
const BARE_SECTION_RE = /^(?:\d{2,3}[A-Z]?|[A-Z]\d{0,2}|[A-Z]{1,3}\s?\d{1,3})$/;

/** Lines that introduce a person, so the office hours under them can say whose. */
const PERSON_LINE_RE =
  /^\s*(?:(?:course|teaching|graduate|lab|head|lead|primary)\s+)?(?:instructors?|professors?|prof|lecturers?|teachers?|faculty|assistants?|tas?|tutors?|preceptors?|graders?)(?:\s+of\s+record)?\s*\d?\s*[:\-]\s*(\S.*)$/i;

/**
 * How far below a "Teaching Assistant: ..." line their office hours may sit.
 *
 * Contact blocks put the name, the email, the office and the hours within a few
 * lines of each other. Beyond that the association is a guess, and attributing
 * one person's hours to another is worse than leaving the field null.
 */
const PERSON_CONTEXT_LINES = 6;

/** A time range, scanned globally so one line can carry several. */
const TIME_RANGE_G =
  /(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?\s*m\.?)?)\s*(?:-|to|until)\s*(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?\s*m\.?)?)/gi;

/** Spelled-out weekdays, used to find where one meeting's text starts. */
const DAY_WORD_RE =
  /\b(?:sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday)?\b/i;

/** The compact registrar codes: "MWF", "TR", "TTh". Upper case only, by design. */
const DAY_CODE_RE = /\b[MTWRFSUH]{1,7}\b/;

/** A run that is nothing but day tokens -- what a bare "MWF 10:00-10:50" line starts with. */
const PURE_DAYS_RE =
  /^(?:[MTWRFSUH]{1,7}|(?:(?:sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday)?[\s,\/&+-]*)+)$/i;

/** Where a meeting's day expression begins inside a fragment, or -1. */
function dayTokenStart(text: string): number {
  const word = DAY_WORD_RE.exec(text);
  if (word) return word.index;
  const code = DAY_CODE_RE.exec(text);
  return code ? code.index : -1;
}

/** Building words: a room is never a person, however name-shaped it reads. */
const PLACE_WORD_RE =
  /\b(?:hall|room|rm|bldg|building|center|centre|library|annex|tower|auditorium|theater|theatre|campus|floor|suite|online|zoom|remote)\b/i;

function looksLikeRoom(text: string): boolean {
  const t = collapse(text);
  if (t.length === 0 || t.length > 48) return false;
  if (/@/.test(t)) return false;
  if (/\b[ap]\.?\s?m\.?\b/i.test(t)) return false;
  // A date is not a room. "Aug 24" in a schedule row would otherwise become one.
  if (findDateSpans(t).length > 0) return false;
  if (/^(?:tba|tbd|online|remote|zoom|virtual)\b/i.test(t)) return true;
  return /\d/.test(t);
}

function looksLikePerson(text: string): boolean {
  const t = collapse(text);
  if (t.length < 3 || t.length > 60) return false;
  if (/\d/.test(t)) return false;
  if (!/^[A-Z]/.test(t)) return false;
  if (!/^[A-Za-z.'\- ]+$/.test(t)) return false;
  if (PLACE_WORD_RE.test(t)) return false;
  if (classifyMeetingLabel(t)) return false;
  // Two tokens minimum. A single capitalised word is as likely to be a column
  // heading or a stray fragment as it is to be somebody's name.
  return t.split(" ").length >= 2;
}

/** "Prof. Chen", "Dr. Elena Vasquez" -- a name wearing its title. */
function titledPerson(text: string): string | null {
  const m = /\b((?:Prof|Professor|Dr|Mr|Ms|Mrs|Mx)\.?\s+[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})/.exec(
    text,
  );
  return m ? collapse(m[1]) : null;
}

/**
 * A person named on the line itself.
 *
 * `allowBare` is off for a label ("Office hours" is two capitalised words and
 * would sail through `looksLikePerson`) and on for the fragment before a day
 * code, which is where "Dr. Chen, MW 1:00-2:00" puts the name.
 */
function findInlinePerson(text: string, allowBare: boolean): string | null {
  const titled = titledPerson(text);
  if (titled) return titled;

  for (const m of text.matchAll(/\(([^)]{2,60})\)/g)) {
    const inner = collapse(m[1]);
    const innerTitled = titledPerson(inner);
    if (innerTitled) return innerTitled;
    if (looksLikePerson(inner)) return inner;
  }

  if (!allowBare) return null;
  const bare = cleanPersonName(text.replace(/\([^)]*\)/g, ""));
  return bare && looksLikePerson(bare) ? bare : null;
}

/**
 * The room and the person a meeting's trailing text names.
 *
 * Split on the separators a syllabus actually uses -- commas, semicolons,
 * pipes, and column padding -- then decide part by part. Picking the room by
 * shape rather than by position is what keeps "…, 2MTC 907, Prof. Chen" from
 * filing the instructor as the location.
 */
function readTrailingDetails(tail: string): { location: string | null; instructor: string | null } {
  const cleaned = tail.replace(/^\s*[ap]\.?\s*m\.?\b/i, "");
  const parts = cleaned
    .split(/\s{2,}|[,;|]/)
    .map((p) => collapse(p.replace(/^(?:in|at|room|rm\.?)\s+/i, "")))
    .filter((p) => p.length > 0);

  let location: string | null = null;
  let instructor: string | null = null;
  for (const part of parts) {
    if (!location && looksLikeRoom(part)) {
      location = part;
      continue;
    }
    if (!instructor) {
      const person = titledPerson(part) ?? (looksLikePerson(part) ? part : null);
      if (person) instructor = person;
    }
  }
  return { location, instructor };
}

/** One meeting pattern read off a line, before section labels are finalised. */
interface RawMeeting {
  kind: MeetingKind;
  section: string | null;
  instructor: string | null;
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  location: string | null;
}

/**
 * Every `<days> <time range> [room] [person]` pattern on one line.
 *
 * A line routinely carries more than one: "Office hours: Tuesday 2:00-3:30 PM,
 * Thursday 11:00 AM-12:30 PM" is two meetings, and reading only the first is
 * how half a professor's availability used to vanish. Each pattern's room is
 * taken from the text between IT and the next pattern's days, so a location can
 * never be borrowed from a neighbouring meeting.
 */
function scanMeetingPatterns(body: string): Array<{
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  location: string | null;
  instructor: string | null;
}> {
  // Dash normalisation is 1:1, so every index below still refers to `body`.
  const text = body.replace(/[‐-―−]/g, "-");
  const matches = [...text.matchAll(TIME_RANGE_G)];
  if (matches.length === 0) return [];

  const out: Array<{
    daysOfWeek: number[];
    startTime: string;
    endTime: string;
    location: string | null;
    instructor: string | null;
  }> = [];

  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const previousEnd = i === 0 ? 0 : (matches[i - 1].index ?? 0) + matches[i - 1][0].length;

    const lead = text.slice(previousEnd, start);
    const daysOfWeek = parseDaysOfWeek(lead);
    if (daysOfWeek.length === 0) continue;

    const range = parseTimeRange(match[0]);
    if (!range) continue;

    // The tail stops where the NEXT meeting's days begin, so this meeting can
    // only ever be given a room the syllabus wrote beside it.
    let tail: string;
    if (i + 1 < matches.length) {
      const nextLead = text.slice(end, matches[i + 1].index ?? end);
      const cut = dayTokenStart(nextLead);
      tail = cut === -1 ? nextLead : nextLead.slice(0, cut);
    } else {
      tail = text.slice(end);
    }

    const details = readTrailingDetails(tail);
    const leadStart = dayTokenStart(lead);
    const leadPerson =
      leadStart > 0 ? findInlinePerson(lead.slice(0, leadStart), true) : null;

    out.push({
      daysOfWeek,
      startTime: range.start,
      endTime: range.end,
      location: details.location,
      instructor: details.instructor ?? leadPerson,
    });
  }

  return out;
}

/**
 * Reads a delimited section row: `Section A | MW | 8:00-9:50 | 2MTC 907 | Chen`.
 *
 * Column by column rather than by scanning the joined row, because the days,
 * the room and the instructor each sit in a cell of their own and the section
 * cell must be kept away from `parseDaysOfWeek` -- "Section A" tokenises to
 * S and T, which would put the class on Saturday.
 */
function readSectionRow(
  cells: string[],
  section: string | null,
): Omit<RawMeeting, "kind" | "section"> | null {
  const sectionIndex = section === null ? -1 : 0;

  let timeIndex = -1;
  for (let i = 0; i < cells.length; i += 1) {
    if (i === sectionIndex) continue;
    if (!/\d\s*:\s*\d{2}|\d\s*[ap]\.?\s*m\.?/i.test(cells[i])) continue;
    if (parseTimeRange(cells[i])) {
      timeIndex = i;
      break;
    }
  }
  if (timeIndex === -1) return null;
  const range = parseTimeRange(cells[timeIndex]);
  if (!range) return null;

  // Days may share the time cell ("MW 8:00-9:50") or have one of their own.
  const firstTimeAt = cells[timeIndex].search(/\d/);
  let daysOfWeek =
    firstTimeAt > 0 ? parseDaysOfWeek(cells[timeIndex].slice(0, firstTimeAt)) : [];
  for (let i = timeIndex - 1; i >= 0 && daysOfWeek.length === 0; i -= 1) {
    if (i === sectionIndex) continue;
    daysOfWeek = parseDaysOfWeek(cells[i]);
  }
  if (daysOfWeek.length === 0) return null;

  const details = readTrailingDetails(cells.slice(timeIndex + 1).join(" | "));
  return {
    daysOfWeek,
    startTime: range.start,
    endTime: range.end,
    location: details.location,
    instructor: details.instructor,
  };
}

/**
 * Every recurring meeting the syllabus states -- classes, recitations, labs AND
 * office hours, each carrying the kind, section and person it was written with.
 *
 * The bug this shape exists to prevent: a large course's syllabus lists EVERY
 * section ("MW 8:00-9:50 2MTC 907", "TR 10:00-11:50 6MTC 674", ...), and a
 * parser that flattens them into one list tells the calendar the student
 * attends all of them. Each section is emitted separately, labelled with the
 * syllabus's own wording, and which one is the student's is a question only the
 * student can answer -- see `Course.section`.
 */
function findMeetingTimes(lines: string[]): MeetingTime[] {
  // Who was most recently introduced, so an "Office hours:" line a couple of
  // lines below "Teaching Assistant: Marcus Owusu" can say whose hours they are.
  const personAt: Array<string | null> = [];
  let recent: { name: string; line: number } | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const m = PERSON_LINE_RE.exec(lines[i]);
    if (m) {
      const name = cleanPersonName(m[1]);
      if (name) recent = { name, line: i };
    }
    personAt.push(
      recent && i - recent.line <= PERSON_CONTEXT_LINES ? recent.name : null,
    );
  }

  const raw: RawMeeting[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().length === 0) continue;

    const cells = segments(line);
    const isRow = cells.length >= 3;

    // --- section label -----------------------------------------------------
    let section: string | null = null;
    let labelText = "";
    let body = line;

    if (isRow) {
      const rowMatch = SECTION_LABEL_RE.exec(cells[0]);
      if (rowMatch) section = collapse(rowMatch[1]);
      else if (BARE_SECTION_RE.test(collapse(cells[0]))) section = collapse(cells[0]);
      labelText = cells[0];
    } else {
      const labelMatch = MEETING_LABEL_RE.exec(line);
      // "Monday, Wednesday: 10:00-10:50" leads with its days, not with a label;
      // stripping them would throw the meeting away.
      const labelled = labelMatch !== null && !PURE_DAYS_RE.test(collapse(labelMatch[1]));
      if (labelMatch && labelled) {
        labelText = labelMatch[1];
        body = line.slice(labelMatch[0].length);
      }
      const sectionMatch = SECTION_LABEL_RE.exec(labelText || line);
      if (sectionMatch) {
        section = collapse(sectionMatch[1]);
        // Keep the label out of the day scanner: "Section A" tokenises to S+T.
        if (!labelled) body = line.slice(sectionMatch[0].length);
      }
    }

    // --- is this a meeting line at all? ------------------------------------
    const kindFromLabel = classifyMeetingLabel(labelText) ?? classifyMeetingLabel(line);
    const bare =
      !isRow &&
      line.length <= 80 &&
      findDateSpans(line).length === 0 &&
      PURE_DAYS_RE.test(collapse(body.slice(0, Math.max(0, body.search(/\d/)))));
    if (!kindFromLabel && section === null && !bare) continue;

    // A bare "MWF 10:00-10:50" line is the lecture: it is what a syllabus
    // writes when the course has exactly one meeting worth naming.
    const kind: MeetingKind = kindFromLabel ?? "lecture";

    // Office hours belong to a person, never to a section: a big course runs
    // one set of hours for everyone enrolled.
    const sectionForKind = kind === "office_hours" ? null : section;

    const contextPerson =
      kind === "office_hours" ||
      /\b(?:TA|T\.A\.|teaching\s+assistant|tutors?|preceptors?|graders?)\b/i.test(labelText)
        ? personAt[i]
        : null;
    const labelPerson = findInlinePerson(labelText, false);

    if (isRow) {
      const rowMeeting = readSectionRow(cells, section);
      if (!rowMeeting) continue;
      raw.push({
        ...rowMeeting,
        kind,
        section: sectionForKind,
        instructor: rowMeeting.instructor ?? labelPerson ?? contextPerson,
      });
      continue;
    }

    for (const pattern of scanMeetingPatterns(body)) {
      raw.push({
        kind,
        section: sectionForKind,
        daysOfWeek: pattern.daysOfWeek,
        startTime: pattern.startTime,
        endTime: pattern.endTime,
        location: pattern.location,
        instructor: pattern.instructor ?? labelPerson ?? contextPerson,
      });
    }
  }

  // A label is only meaningful when there is something to choose between. One
  // section is just "the class", and labelling it would make the calendar sync
  // wait forever for a choice the student does not have to make.
  const labels = new Set(raw.map((m) => m.section).filter((s): s is string => s !== null));
  const keepSections = labels.size > 1;

  const out: MeetingTime[] = [];
  const seen = new Set<string>();
  for (const m of raw) {
    const section = keepSections ? m.section : null;
    // Section is part of the identity: two sections of a big course can share a
    // day and time in different rooms, and folding them together is exactly the
    // collapse this parser exists to avoid.
    const key = [
      m.kind,
      section ?? "",
      m.daysOfWeek.join(","),
      m.startTime,
      m.endTime,
      m.location ?? "",
      m.instructor ?? "",
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: m.kind,
      section,
      instructor: m.instructor ?? null,
      daysOfWeek: m.daysOfWeek,
      startTime: m.startTime,
      endTime: m.endTime,
      location: m.location && m.location.length >= 2 ? m.location : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Grading weights
// ---------------------------------------------------------------------------

/** "Problem Sets (7)          24%" -- category, dot/space leaders, percentage, end of line. */
const WEIGHT_LINE =
  /^[\s\-*•|]*([A-Za-z][A-Za-z0-9 &/'(),.+-]{1,44}?)[\s.:|–—-]*(\d{1,3}(?:\.\d+)?)\s*%\s*\|?\s*$/;

/** "Homework: 30%" appearing inline. The colon is required so prose can't match. */
const WEIGHT_INLINE = /([A-Za-z][A-Za-z0-9 &/'()-]{1,34}?)\s*[:=]\s*(\d{1,3}(?:\.\d+)?)\s*%/g;

const WEIGHT_CATEGORY_BLOCKLIST = /^(?:total|totals|sum|subtotal|overall|grand\s+total|final\s+grade|grade)$/i;

function cleanCategory(raw: string): string {
  return collapse(raw.replace(/[.\s:|–—-]+$/, "").replace(/^[.\s:|–—-]+/, ""));
}

function findGradeWeights(lines: string[]): GradeWeight[] {
  const out: GradeWeight[] = [];
  const seen = new Set<string>();

  const push = (rawCategory: string, rawPercent: string): void => {
    const category = cleanCategory(rawCategory);
    const weightPercent = Number(rawPercent);
    if (category.length < 2 || category.length > 45) return;
    if (WEIGHT_CATEGORY_BLOCKLIST.test(category)) return;
    if (!Number.isFinite(weightPercent) || weightPercent <= 0 || weightPercent > 100) return;
    // A category that is really a sentence -- the syllabus is discussing a
    // percentage, not tabulating one.
    if (category.split(/\s+/).length > 7) return;
    const key = category.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ category, weightPercent });
  };

  for (const line of lines) {
    const m = WEIGHT_LINE.exec(line);
    if (m) {
      push(m[1], m[2]);
      continue;
    }
    // Inline form, but only on short lines: a long line is prose.
    if (line.length > 90) continue;
    WEIGHT_INLINE.lastIndex = 0;
    for (let inline = WEIGHT_INLINE.exec(line); inline !== null; inline = WEIGHT_INLINE.exec(line)) {
      push(inline[1], inline[2]);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Assessments
// ---------------------------------------------------------------------------

function classify(text: string): { kind: AssessmentKind; strong: boolean } | null {
  for (const rule of KIND_RULES) {
    if (rule.re.test(text)) return { kind: rule.kind, strong: rule.strong };
  }
  return null;
}

/**
 * Trims a schedule cell down to just the item's name.
 *
 * We cut at the first date rather than pattern-matching the name, because the
 * name is the part we cannot predict ("Modeling Project final report") while
 * the date is the part we can.
 */
function cleanTitle(segment: string): string {
  let text = segment.replace(/^[\s\-*•|]+/, "");

  const spans = findDateSpans(text);
  if (spans.length > 0) text = text.slice(0, spans[0].start);

  // Dot leaders in a deadline table, and any trailing time-of-day.
  text = text.split(/\.{3,}/)[0];
  text = text.replace(/\s*\d{1,2}(?::\d{2})?\s*[ap]\.?\s*m\.?.*$/i, "");
  text = collapse(text.replace(/\s+/g, " "));

  // Peel trailing filler ("Problem Set 1 due Fri," -> "Problem Set 1").
  let previous = "";
  while (text !== previous) {
    previous = text;
    text = text.replace(/[\s,;:.\-–—|(]+$/, "");
    const words = text.split(" ");
    const last = words[words.length - 1] ?? "";
    if (words.length > 1 && (TITLE_STOPWORDS.has(last.toLowerCase()) || WEEKDAY_RE.test(last))) {
      text = words.slice(0, -1).join(" ");
    }
  }

  return trimLeadingFragment(collapse(text.replace(/^[\s:|.\-–—]+/, "")));
}

/**
 * Drops a leading word fragment left by a mid-word slice.
 *
 * `unwrapHardBreaks` in pdf.ts repairs the common cause of these, but a table
 * cell can still be cut by other means, and a title must never begin mid-word.
 * Capitalization is the usable signal: schedule cells title-case their items, so
 * a lowercase first token followed by a capitalized one has almost certainly
 * lost its real first word ("Midterm Exam 1" -> "term Exam 1" -> "Exam 1").
 *
 * Deliberately conservative -- it only fires on a SHORT leading lowercase token,
 * so a genuinely lowercase title like "presentation slides" is left alone. What
 * it produces is a shorter-but-honest title that the near-duplicate pass can
 * then fold back into the intact one.
 */
function trimLeadingFragment(title: string): string {
  const words = title.split(" ");
  if (words.length < 2) return title;
  if (!/^[a-z]/.test(words[0]) || words[0].length > 6) return title;
  if (!/^[A-Z]/.test(words[1])) return title;
  return words.slice(1).join(" ");
}

function normalizeTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Splits a schedule row into cells.
 *
 * Pipes and tabs are the separators PDFs and plain-text syllabi actually
 * produce; we deliberately do NOT split on runs of spaces, because deadline
 * tables use dot leaders and column padding inside a single logical cell.
 */
function segments(line: string): string[] {
  return line
    .split(/[|\t]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * A written time range, captured in pieces so a trailing meridiem can be shared
 * with the start and so the phrase itself can be quoted back in a warning.
 *
 * Deliberately unanchored: a schedule row wraps the range in a title, a date
 * and a room ("Midterm 1 ... Tuesday, October 6, 2026, 12:30-1:50 PM"), so we
 * scan for every range-shaped run rather than expecting one at a known spot.
 */
const TIME_RANGE_SHAPE =
  /(\d{1,2}(?::\d{2})?)(?:\s*([ap])\.?\s*m\.?)?\s*(-|\bto\b|\buntil\b)\s*(\d{1,2}(?::\d{2})?)(?:\s*([ap])\.?\s*m\.?)?/gi;

/** Every dash a syllabus might write a range with, flattened to a plain hyphen. */
function plainDashes(s: string): string {
  return s.replace(/[‐-―−]/g, "-");
}

/** Same warning from a summary table and again from the week grid is one warning. */
function pushWarning(warnings: string[], message: string): void {
  if (!warnings.includes(message)) warnings.push(message);
}

interface DueTimes {
  start: string;
  /** Null for a lone time, and for a range whose end did not land after its start. */
  end: string | null;
}

/**
 * Reads when an item happens, and -- when the syllabus wrote a range -- when it
 * ends.
 *
 * This is the exam fix. "Midterm: Tuesday, Oct 6, 12:30-1:50 PM" used to keep
 * only the 12:30 and throw the rest away, so the calendar drew a default-length
 * block ENDING at 12:30, an hour before the student's exam actually started.
 *
 * A trailing meridiem governs both ends of a range -- "12:30-1:50 PM" is 12:30
 * PM to 1:50 PM, "8-9:50 AM" is 08:00 to 09:50 -- so it is pushed onto a bare
 * start before `parseTimeRange` reads the pair, rather than letting each end be
 * read on its own. An end that is not after its start is a misprint or a
 * misread; we keep the start, drop the end and say so, because an end time we
 * made up is precisely the bug this replaced.
 */
function parseDueTimes(text: string, warnings: string[]): DueTimes | null {
  const source = plainDashes(text);

  TIME_RANGE_SHAPE.lastIndex = 0;
  for (let m = TIME_RANGE_SHAPE.exec(source); m !== null; m = TIME_RANGE_SHAPE.exec(source)) {
    const [phrase, startClock, startMeridiem, separator, endClock, endMeridiem] = m;
    const normalized =
      !startMeridiem && endMeridiem
        ? `${startClock} ${endMeridiem}m ${separator} ${endClock} ${endMeridiem}m`
        : phrase;
    // "Oct 5-7" and "chapters 2 to 5" are the same shape; only a pair that
    // actually reads as two clock times counts as a range.
    const range = parseTimeRange(normalized);
    if (!range) continue;

    if (range.end > range.start) return { start: range.start, end: range.end };

    pushWarning(
      warnings,
      `The time range "${collapse(phrase)}" ends at or before it starts, so only its start time was kept.`,
    );
    return { start: range.start, end: null };
  }

  const lone = parseTime(source);
  return lone ? { start: lone, end: null } : null;
}

function findAssessments(
  lines: string[],
  ctx: DateContext,
  warnings: string[],
): LooseAssessment[] {
  const candidates: LooseAssessment[] = [];

  for (const line of lines) {
    if (line.trim().length === 0) continue;
    // A weight table row is a grading scheme, not a dated item.
    if (WEIGHT_LINE.test(line)) continue;

    const cells = segments(line);
    for (const cell of cells) {
      const rule = classify(cell);
      if (!rule) continue;

      // A dateless mention is almost always prose ("Exams are closed-book"), so
      // require the cell or its row to actually carry a date.
      const cellHasDate = findDateSpans(cell).length > 0 || /\bweek\s*#?\s*\d{1,2}\b/i.test(cell);
      const dated = cellHasDate ? cell : line;
      if (!cellHasDate && findDateSpans(line).length === 0) continue;

      const dueDate = normalizeDate(dated, ctx);
      const title = cleanTitle(cell);
      if (title.length < 3) continue;
      // "Week 5" alone is a schedule label, not an assignment.
      if (/^week\s*\d+$/i.test(title)) continue;

      // The cell is preferred over the row for the same reason the date is: a
      // week row carries other items' times too.
      const times =
        parseDueTimes(cell, warnings) ?? (cellHasDate ? null : parseDueTimes(line, warnings));

      // An explicit four-digit year removes the riskiest guess we make, so it
      // earns a little confidence; a missing date costs some.
      const hasExplicitYear = /\b20\d{2}\b/.test(dated);
      let confidence = 0.45;
      if (rule.strong) confidence += 0.05;
      if (hasExplicitYear) confidence += 0.1;
      if (!dueDate) confidence -= 0.1;

      const inlineWeight = /\((\d{1,3}(?:\.\d+)?)\s*%\)/.exec(cell);

      candidates.push({
        title,
        kind: rule.kind,
        dueDate,
        dueTime: times?.start ?? null,
        // Null unless the syllabus actually wrote a range. A sitting with no
        // stated end is one the calendar layer gets to make its own guess
        // about; a wrong end here would look like a stated fact.
        endTime: times?.end ?? null,
        weightPercent: inlineWeight ? Number(inlineWeight[1]) : null,
        sourceText: collapse(line).slice(0, 400),
        confidence: clamp(Number(confidence.toFixed(2)), 0.4, 0.6),
        // Nothing here has been seen by a human yet. Everything this parser
        // emits sits in the 0.4-0.6 band precisely so the UI asks the student
        // to confirm it; marking it reviewed would erase that request.
        reviewedAt: null,
        notes: null,
      });
      break; // One graded item per cell; the first match is the specific one.
    }
  }

  return mergeAssessments(candidates);
}

/**
 * Folds duplicate mentions together.
 *
 * A good syllabus lists every deadline twice -- once in a summary table and
 * once in the weekly schedule -- and the two mentions carry different details
 * (the table has the 11:59 PM, the schedule has the week). Same title AND same
 * date means the same item; same title with two different dates means a
 * recurring item like a weekly quiz, which must stay split.
 */
function mergeAssessments(items: LooseAssessment[]): LooseAssessment[] {
  const byTitle = new Map<string, LooseAssessment[]>();
  for (const item of items) {
    const key = normalizeTitleKey(item.title);
    const bucket = byTitle.get(key);
    if (bucket) bucket.push(item);
    else byTitle.set(key, [item]);
  }

  const out: LooseAssessment[] = [];
  for (const bucket of byTitle.values()) {
    const dated = bucket.filter((i) => i.dueDate !== null);
    const chosen = dated.length > 0 ? dated : bucket.slice(0, 1);

    const byDate = new Map<string, LooseAssessment>();
    for (const item of chosen) {
      const key = item.dueDate ?? "";
      const existing = byDate.get(key);
      if (!existing) {
        byDate.set(key, { ...item });
        continue;
      }
      // Keep the richer of the two mentions. An end time only travels with the
      // start it was written next to: the deadline table's "10:15 AM-12:15 PM"
      // and the week grid's bare "10:15 AM" are the same sitting, but pairing
      // one mention's end with another's start would be an invented fact.
      if (existing.dueTime === null) {
        existing.dueTime = item.dueTime;
        existing.endTime = item.endTime;
      } else if (existing.endTime === null && item.dueTime === existing.dueTime) {
        existing.endTime = item.endTime;
      }
      existing.weightPercent = existing.weightPercent ?? item.weightPercent;
      existing.confidence = Math.max(existing.confidence, item.confidence);
      if ((item.sourceText?.length ?? 0) > (existing.sourceText?.length ?? 0)) {
        existing.sourceText = item.sourceText;
      }
      if (item.title.length > existing.title.length) existing.title = item.title;
    }
    out.push(...byDate.values());
  }

  // Chronological, undated last -- this is the order the review UI reads best in.
  return out.sort((a, b) => {
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return a.title.localeCompare(b.title);
  });
}

// ---------------------------------------------------------------------------
// No-class periods
// ---------------------------------------------------------------------------

/**
 * Phrases that mean "the class does not meet on these days".
 *
 * Deliberately narrow. Everything here has to survive contact with policy
 * prose, which is why "closed" only counts next to a campus word ("closed-book"
 * exams are not a holiday) and why a bare "break" still has to come with a date
 * before it produces anything. The cost of a false positive is a class meeting
 * silently missing from the student's calendar, which is worse than a break we
 * failed to notice: that one only puts an extra meeting on the calendar, where
 * the student can see it and delete it.
 */
const NO_CLASS_TRIGGER =
  /\bno\s+class(?:es)?\b|\bclass(?:es)?\s+(?:will\s+be\s+|are\s+|is\s+)?cancell?ed\b|\bcancell?ed\s+class(?:es)?\b|\b(?:university|campus|college|school)\s+(?:is\s+|will\s+be\s+)?closed\b|\bholidays?\b|\brecess\b|\bbreaks?\b|\breading\s+days?\b/i;

/** The stated last day of instruction -- everything after it is a no-class stretch. */
const LAST_DAY_RE = /\blast\s+day\s+of\s+(?:class(?:es)?|instruction|lectures?)\b/i;

/** The finals window, used only when no last day of classes was stated. */
const FINALS_RE =
  /\b(?:finals?\s+week|final\s+exam(?:ination)?s?\s+(?:period|week)|examination\s+period|exam\s+week)\b/i;

/**
 * Weekday words ONLY -- never the compact registrar codes.
 *
 * `parseDaysOfWeek` also accepts "MWF"/"TTh", which is right for a meeting-time
 * line and catastrophic here: it reads the letters out of ordinary prose, so
 * "Thanksgiving recess" would come back as Thursday.
 */
const NO_CLASS_WEEKDAYS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tues: 2,
  tue: 2,
  wednesday: 3,
  weds: 3,
  wed: 3,
  thursday: 4,
  thurs: 4,
  thur: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

const WEEKDAY_WORD_PATTERN = Object.keys(NO_CLASS_WEEKDAYS)
  .sort((a, b) => b.length - a.length)
  .join("|");

/** "No class Wed-Fri" -- a weekday range inside a week row. */
const WEEKDAY_RANGE_RE = new RegExp(
  `\\b(${WEEKDAY_WORD_PATTERN})\\b\\s*(?:-|to|through|thru|&|and)\\s*\\b(${WEEKDAY_WORD_PATTERN})\\b`,
  "i",
);

const WEEKDAY_WORD_RE = new RegExp(`\\b(${WEEKDAY_WORD_PATTERN})\\b`, "gi");

/**
 * A clause longer than this is a paragraph, not a schedule note. Prose about
 * "a break in the middle of the term" must not become a calendar fact.
 */
const MAX_NO_CLASS_CLAUSE = 160;

interface DateWindow {
  start: string;
  end: string;
}

/** The ISO date of `dayOfWeek` inside a week window, or null if it falls outside. */
function weekdayInWindow(window: DateWindow, dayOfWeek: number): string | null {
  let cursor: string | null = window.start;
  for (let i = 0; cursor !== null && cursor <= window.end && i < 21; i += 1) {
    if (isoDayOfWeek(cursor) === dayOfWeek) return cursor;
    cursor = addDays(cursor, 1);
  }
  return null;
}

/**
 * The date span a schedule row covers ("Week 3 | Sep 7 - Sep 11 | ...").
 *
 * `skipIndex` is the cell we are resolving, so a cell that carries its own
 * dates ("Thanksgiving recess, Nov 25-27") cannot be mistaken for the row's
 * week window and resolve a weekday against itself.
 */
function rowWindow(cells: string[], skipIndex: number, ctx: DateContext): DateWindow | null {
  for (let i = 0; i < cells.length; i += 1) {
    if (i === skipIndex) continue;
    const { start, end } = normalizeDateRange(cells[i], ctx);
    if (!start || !end || start >= end) continue;
    // A week row spans a week; anything wider is a term range, not a window a
    // weekday can be resolved inside.
    const span = Number(new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime());
    if (span > 13 * 86_400_000) continue;
    return { start, end };
  }
  return null;
}

/**
 * Turns the clause a period came from into a short human reason.
 *
 * The dates are stripped out because the period already carries them; what is
 * left is the part a student actually wants to read ("Thanksgiving recess",
 * "No class Mon (Labor Day)").
 */
function noClassReason(clause: string): string | null {
  let text = clause;
  const spans = findDateSpans(text);
  for (let i = spans.length - 1; i >= 0; i -= 1) {
    text = `${text.slice(0, spans[i].start)} ${text.slice(spans[i].end)}`;
  }
  text = collapse(text);

  let previous = "";
  while (text !== previous) {
    previous = text;
    text = text.replace(/^[\s,;:.\-–—|]+/, "").replace(/[\s,;:.\-–—|]+$/, "");
    // The "-27, 2026" half of a range: `findDateSpans` only reports the
    // fragment carrying the month, so the tail is left behind.
    text = text.replace(/[-–—]?\s*\d{1,2}(?:st|nd|rd|th)?\s*,?\s*(?:\d{4})?\s*$/, "");
    const words = text.split(" ");
    const last = words[words.length - 1] ?? "";
    if (words.length > 1 && WEEKDAY_RE.test(last)) text = words.slice(0, -1).join(" ");
  }

  const cleaned = collapse(text).slice(0, 90);
  return cleaned.length >= 3 ? cleaned : null;
}

/**
 * Every stretch of the term the syllabus says the class does not meet.
 *
 * Three sources, in the order we trust them:
 *   1. An explicit note with its own dates ("Thanksgiving recess, Nov 25-27").
 *   2. A weekday inside a week row ("No class Mon" in a `Week 3 | Sep 7 - Sep 11`
 *      row resolves to that Monday).
 *   3. The stated last day of classes: everything after it, through the end of
 *      the term, is finals week and the reading gap before it.
 *
 * Nothing is inferred beyond that. A syllabus that never mentions a break gets
 * an empty array, which is the honest answer -- inventing a Thanksgiving recess
 * because most US terms have one would delete real class meetings from a
 * calendar for a course that actually met.
 */
function findNoClassPeriods(
  lines: string[],
  ctx: DateContext,
  termRange: { start: string | null; end: string | null; explicit: boolean },
  warnings: string[],
): NoClassPeriod[] {
  const found: NoClassPeriod[] = [];
  const unresolved: string[] = [];

  for (const line of lines) {
    if (!NO_CLASS_TRIGGER.test(line)) continue;
    const cells = segments(line);

    for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
      const cell = cells[cellIndex];
      if (!NO_CLASS_TRIGGER.test(cell)) continue;

      let window: DateWindow | null | undefined;
      const cellFound: NoClassPeriod[] = [];
      const bare: string[] = [];

      for (const rawClause of cell.split(/;/)) {
        const clause = collapse(rawClause);
        if (clause.length === 0 || clause.length > MAX_NO_CLASS_CLAUSE) continue;
        if (!NO_CLASS_TRIGGER.test(clause)) continue;
        // "Problem Set 5 due the Friday before spring break" is a deadline that
        // mentions a break, not a break.
        if (/\bdue\b/i.test(clause)) continue;

        if (findDateSpans(clause).length > 0) {
          const { start, end } = normalizeDateRange(clause, ctx);
          if (start && end) {
            cellFound.push({
              start: start <= end ? start : end,
              end: start <= end ? end : start,
              reason: noClassReason(clause),
            });
          } else {
            unresolved.push(clause);
          }
          continue;
        }

        WEEKDAY_WORD_RE.lastIndex = 0;
        const weekdays = [...clause.matchAll(WEEKDAY_WORD_RE)].map(
          (m) => NO_CLASS_WEEKDAYS[m[1].toLowerCase()],
        );
        if (weekdays.length === 0) {
          bare.push(clause);
          continue;
        }

        if (window === undefined) window = rowWindow(cells, cellIndex, ctx);
        if (!window) {
          unresolved.push(clause);
          continue;
        }

        const reason = noClassReason(clause);
        const range = WEEKDAY_RANGE_RE.exec(clause);
        if (range) {
          // "Wed-Fri" is one stretch, not two days with a hole in the middle.
          const first = weekdayInWindow(window, NO_CLASS_WEEKDAYS[range[1].toLowerCase()]);
          const last = weekdayInWindow(window, NO_CLASS_WEEKDAYS[range[2].toLowerCase()]);
          if (first && last && first <= last) {
            cellFound.push({ start: first, end: last, reason });
            continue;
          }
        }
        for (const day of new Set(weekdays)) {
          const date = weekdayInWindow(window, day);
          if (date) cellFound.push({ start: date, end: date, reason });
          else unresolved.push(clause);
        }
      }

      // A trailing bare "no class" restates the dated clause beside it
      // ("Thanksgiving recess, Nov 25-27; no class") -- taking it as a separate
      // fact would blank out the whole week the recess sits in. On its own,
      // though, it means the row's entire week.
      if (cellFound.length === 0 && bare.length > 0) {
        if (window === undefined) window = rowWindow(cells, cellIndex, ctx);
        if (window) {
          cellFound.push({ start: window.start, end: window.end, reason: noClassReason(bare[0]) });
        } else if (cells.length > 1) {
          // Only worth a warning when it came out of a schedule row. A bare
          // trigger in running prose ("take a break when you need one") names
          // no days at all, so there is nothing for the reader to go fix.
          unresolved.push(bare[0]);
        }
      }

      found.push(...cellFound);
    }
  }

  // Everything after the last day of classes: finals week plus the reading gap
  // before it. Stated by the syllabus, not assumed -- and only when it really
  // is before the end of the term.
  const finals = firstResolvedRange(lines, FINALS_RE, ctx);
  const lastDay = firstResolvedDate(lines, LAST_DAY_RE, ctx);
  const termEnd = termRange.explicit ? termRange.end : (finals?.end ?? null);

  if (lastDay && termEnd && lastDay < termEnd) {
    const dayAfter = addDays(lastDay, 1);
    if (dayAfter && dayAfter <= termEnd) {
      found.push({ start: dayAfter, end: termEnd, reason: "After last day of classes" });
    }
  } else if (!lastDay && finals && finals.start <= finals.end) {
    found.push({ start: finals.start, end: finals.end, reason: "Finals week" });
  }

  for (const phrase of [...new Set(unresolved)].slice(0, 5)) {
    warnings.push(
      `A no-class note ("${phrase.slice(0, 80)}") had no date we could resolve, so those days were left as normal class meetings.`,
    );
  }

  return mergeNoClassPeriods(found);
}

/** First line matching `re` that also yields a date -- prose mentions resolve to null and are skipped. */
function firstResolvedDate(lines: string[], re: RegExp, ctx: DateContext): string | null {
  for (const line of lines) {
    if (!re.test(line)) continue;
    const date = normalizeDate(line, ctx);
    if (date) return date;
  }
  return null;
}

function firstResolvedRange(lines: string[], re: RegExp, ctx: DateContext): DateWindow | null {
  for (const line of lines) {
    if (!re.test(line)) continue;
    const { start, end } = normalizeDateRange(line, ctx);
    if (start && end) return { start, end };
  }
  return null;
}

/**
 * Sorts and folds overlapping periods together.
 *
 * A well-written syllabus states the same break twice (a header list and the
 * week row), and the two mentions rarely have identical text. Overlap is the
 * only reliable signal that they are the same closure, so overlapping ranges
 * merge into one.
 *
 * Which reason survives follows `mergeAssessments`: the richer mention wins,
 * because the two are usually the same closure described once in passing and
 * once properly ("recess" in a wrapped header line, "Thanksgiving recess" in
 * the week row).
 *
 * Exported because the AI extractor has to answer the same question about the
 * periods the model returns, and two implementations of "is this the same
 * closure" would eventually disagree.
 */
export function mergeNoClassPeriods(periods: NoClassPeriod[]): NoClassPeriod[] {
  const sorted = [...periods].sort(
    (a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end),
  );

  const out: NoClassPeriod[] = [];
  for (const period of sorted) {
    const previous = out[out.length - 1];
    if (previous && period.start <= previous.end) {
      const sameRange = period.start === previous.start && period.end === previous.end;
      if (period.end > previous.end) previous.end = period.end;
      if (
        period.reason &&
        (!previous.reason || (sameRange && period.reason.length > previous.reason.length))
      ) {
        previous.reason = period.reason;
      }
      continue;
    }
    out.push({ ...period });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

const POLICY_RULES: Array<{ re: RegExp; category: CoursePolicy["category"] }> = [
  { re: /^\W*(?:late\s+(?:work|assignments?|submissions?|policy)|missed\s+(?:work|deadlines?)|extensions?)\b/i, category: "late_work" },
  { re: /^\W*(?:attendance|absences?|participation\s+and\s+attendance)\b/i, category: "attendance" },
  { re: /^\W*(?:academic\s+(?:integrity|honesty|dishonesty|misconduct)|integrity|plagiarism|collaboration\s+policy|honor\s+code)\b/i, category: "integrity" },
  { re: /^\W*(?:grading|grade\s+(?:scale|breakdown|policy)|assessment\s+and\s+grading)\b/i, category: "grading" },
  { re: /^\W*(?:accessibility|accommodations?|disability|students?\s+with\s+disabilities)\b/i, category: "other" },
];

function firstSentences(text: string, limit: number): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  let out = "";
  for (const s of sentences) {
    if (out.length > 0 && out.length + s.length > limit) break;
    out = out.length === 0 ? s : `${out} ${s}`;
    if (out.length >= limit * 0.6) break;
  }
  if (out.length === 0) out = text;
  return collapse(out).slice(0, limit);
}

function findPolicies(text: string): CoursePolicy[] {
  const blocks = text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0 && !/^[-=_*—–.\s]+$/.test(b));

  // Score every candidate and keep the meatiest per category: a syllabus often
  // has a bare "GRADING" heading AND a real grading paragraph, and the heading
  // is worthless on its own.
  const best = new Map<CoursePolicy["category"], { body: string; heading: string }>();

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    const lines = block.split("\n");
    const heading = lines[0].trim();
    const rule = POLICY_RULES.find((r) => r.re.test(heading));
    if (!rule) continue;

    let body: string;
    if (lines.length === 1 && heading.length <= 70) {
      // Standalone heading: the policy is the next block, unless that is also a heading.
      const next = blocks[i + 1];
      body = next && !POLICY_RULES.some((r) => r.re.test(next.split("\n")[0].trim())) ? next : heading;
    } else {
      body = block;
    }

    const normalized = collapse(body);
    const current = best.get(rule.category);
    if (!current || normalized.length > current.body.length) {
      best.set(rule.category, { body: normalized, heading });
    }
  }

  const out: CoursePolicy[] = [];
  for (const [category, { body }] of best) {
    if (body.length < 40) continue; // A heading with no policy text under it.
    out.push({
      category,
      summary: firstSentences(body, 240),
      sourceText: body.slice(0, 1200),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parses syllabus text with regexes and heuristics only. Never throws: a
 * syllabus it cannot read produces an empty-but-valid result plus warnings,
 * because the upload flow needs something to render either way.
 */
export function fallbackParse(text: string, options: FallbackOptions = {}): ParsedSyllabus {
  const lines = text.split("\n");
  const warnings: string[] = [];

  const base =
    "Heuristic extraction: this syllabus was read with pattern matching, not AI. Double-check dates and grading weights before relying on them.";
  warnings.push(options.reason ? `${base} (${options.reason})` : base);

  const term = findTerm(text);
  const seasonal = termWindowFromLabel(term);
  const termRange = findTermRange(lines, seasonal);

  // Year inference gets a padded window: a syllabus routinely lists an add/drop
  // deadline a week before class starts, or a grade-appeal date after finals,
  // and clipping to the exact term would null those out for no good reason.
  const inferenceCtx: DateContext = {
    termStart: termRange.start ? addDays(termRange.start, -30) : null,
    termEnd: termRange.end ? addDays(termRange.end, 30) : null,
  };

  const { code, lineIndex } = findCourseCode(lines);
  const title = findTitle(lines, code, lineIndex);
  const instructor = findInstructor(lines);
  const meetingTimes = findMeetingTimes(lines);
  const gradeWeights = findGradeWeights(lines);
  const policies = findPolicies(text);
  const assessments = findAssessments(lines, inferenceCtx, warnings);
  const noClass = findNoClassPeriods(lines, inferenceCtx, termRange, warnings);

  if (!code) {
    warnings.push("No course code (like \"MATH 221\") was found -- please set the course name yourself.");
  }
  if (!termRange.explicit && term) {
    warnings.push(
      `The syllabus didn't state its term dates, so undated years were inferred from "${term}". Check any date that looks off by a year.`,
    );
  }
  if (!termRange.start && !termRange.end) {
    warnings.push(
      "No term dates or term name were found, so any date written without a year could not be resolved.",
    );
  }

  if (gradeWeights.length === 0) {
    warnings.push("No grading-weight table was recognized, so assignment weights are unknown.");
  } else {
    const total = gradeWeights.reduce((sum, w) => sum + w.weightPercent, 0);
    if (Math.abs(total - 100) > 0.5) {
      warnings.push(
        `Grading weights add up to ${Number(total.toFixed(1))}%, not 100% -- a category was probably missed or double-counted.`,
      );
    }
  }

  if (assessments.length === 0) {
    warnings.push("No dated assignments or exams were recognized. Try the AI parser, or add items by hand.");
  } else {
    const undated = assessments.filter((a) => a.dueDate === null).length;
    if (undated > 0) {
      warnings.push(
        `${undated} item(s) had no date we could resolve confidently and were left undated rather than guessed.`,
      );
    }
  }

  // Office hours are meetings now, so "we found something" is no longer the
  // same question as "we found the class".
  if (!meetingTimes.some((m) => m.kind !== "office_hours")) {
    warnings.push("No class meeting time was recognized.");
  }

  const sections = [...new Set(meetingTimes.map((m) => m.section).filter((s) => s !== null))];
  if (sections.length > 1) {
    warnings.push(
      `This syllabus lists ${sections.length} sections (${sections.slice(0, 4).join(", ")}${sections.length > 4 ? ", ..." : ""}). All of them were kept -- choose yours before syncing, so only your own meetings reach your calendar.`,
    );
  }

  return {
    course: {
      code: code ?? "COURSE",
      title,
      instructor,
      term,
      startDate: termRange.explicit ? termRange.start : null,
      endDate: termRange.explicit ? termRange.end : null,
      meetingTimes,
      // Which section is the student's is a fact about the student, not about
      // the document. The parser never guesses it; the UI asks.
      section: null,
      // Empty is a real answer: it means the syllabus never said the class
      // skips a day, not that we failed to look.
      noClass,
      gradeWeights,
      policies,
    },
    assessments,
    warnings,
  };
}
