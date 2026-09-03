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

function findInstructor(lines: string[]): string | null {
  const re = /^\s*(?:instructor|professor|lecturer|teacher|faculty|taught\s+by)s?\s*[:\-]\s*(.+)$/i;
  for (const line of lines) {
    const m = re.exec(line);
    if (!m) continue;
    // Strip a trailing email or parenthetical contact so the name stands alone.
    const name = collapse(
      m[1]
        .replace(/\([^)]*@[^)]*\)/g, "")
        .replace(/[\w.+-]+@[\w.-]+\.\w+/g, "")
        .replace(/[,;|]\s*$/, ""),
    );
    if (name.length >= 2 && name.length <= 80) return name;
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

function findMeetingTimes(lines: string[]): MeetingTime[] {
  const out: MeetingTime[] = [];
  const seen = new Set<string>();

  for (const raw of lines) {
    // Office hours are the single biggest false positive here: same shape, and
    // putting them on a student's class schedule would be actively wrong.
    if (/\boffice\s+hours?\b|\bby\s+appointment\b/i.test(raw)) continue;
    if (!/\b(?:lecture|lectures|class|classes|meets|meeting|recitation|discussion|seminar|studio|lab|laboratory)\b/i.test(raw)) {
      continue;
    }

    // Drop a leading "Lecture:" label -- otherwise the compact day-code scanner
    // reads the letters T, U and R out of the word "LECTURE".
    const body = raw.replace(/^\s*[A-Za-z][A-Za-z \/&'-]{0,30}:\s*/, "");

    const range = parseTimeRange(body);
    if (!range) continue;

    const firstTimeAt = body.search(/\d{1,2}\s*:\s*\d{2}/);
    if (firstTimeAt <= 0) continue;
    const days = parseDaysOfWeek(body.slice(0, firstTimeAt));
    if (days.length === 0) continue;

    const after = body.slice(firstTimeAt);
    const locationMatch = /(?:,|\bin\b|\broom\b|\brm\.?\b|\bat\b)\s*([A-Z][A-Za-z.'-]*(?:\s+[A-Za-z0-9.'-]+){0,4})\s*$/.exec(
      after,
    );
    const location = locationMatch ? collapse(locationMatch[1]) : null;

    const key = `${days.join(",")}|${range.start}|${range.end}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      daysOfWeek: days,
      startTime: range.start,
      endTime: range.end,
      location: location && location.length >= 2 ? location : null,
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

function findAssessments(lines: string[], ctx: DateContext): LooseAssessment[] {
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

      const dueTime = parseTime(cell) ?? (cellHasDate ? null : parseTime(line));

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
        dueTime,
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
      // Keep the richer of the two mentions.
      existing.dueTime = existing.dueTime ?? item.dueTime;
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
  const assessments = findAssessments(lines, inferenceCtx);
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

  if (meetingTimes.length === 0) {
    warnings.push("No class meeting time was recognized.");
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
