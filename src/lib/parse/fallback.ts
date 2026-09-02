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
  ParsedSyllabus,
} from "../types";
import {
  addDays,
  findDateSpans,
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
      gradeWeights,
      policies,
    },
    assessments,
    warnings,
  };
}
