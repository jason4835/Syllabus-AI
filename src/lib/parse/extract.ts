/**
 * Syllabus text -> ParsedSyllabus, via an OpenAI structured-output call.
 *
 * We use structured outputs (a JSON Schema derived from a zod mirror of
 * `ParsedSyllabus`) rather than prompt-and-hope JSON, because the model is not
 * allowed to invent a field shape the rest of the app doesn't speak. Anything
 * the schema can't guarantee -- that a date is real, that a confidence is in
 * 0..1 -- is re-checked here in `sanitize` before it leaves the module.
 *
 * Server-only. The API key is read from the environment and must never appear
 * in a thrown message; see `redact`.
 */

import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

import type { MeetingKind, MeetingTime, NoClassPeriod, ParsedSyllabus } from "../types";
import { addDays, normalizeDate, parseDaysOfWeek, parseTime, termWindowFromLabel, type DateContext } from "./dates";
import { pluralize } from "@/components/format";
import { mergeNoClassPeriods } from "./fallback";

/**
 * Structured outputs are only guaranteed on 4o-2024-08-06 and later. Overridable
 * so an operator can move to a newer model without a deploy of this file, but
 * the default is a model we have actually validated the schema against.
 */
const DEFAULT_MODEL = "gpt-4o-2024-08-06";

/** Roughly 30k tokens of syllabus. Beyond this we chunk rather than truncate blindly. */
const MAX_CHARS_PER_CALL = 120_000;
const CHUNK_TARGET = 90_000;
/** Chunks overlap so a deadline table split across the seam is seen whole at least once. */
const CHUNK_OVERLAP = 4_000;
/** A "syllabus" longer than this is a course reader; parsing all of it wastes money for no gain. */
const MAX_CHUNKS = 4;

/** What a meeting with a stated start and no stated end is given. */
const DEFAULT_MEETING_MINUTES = 60;

/** "09:30" + 60 -> "10:30"; wraps past midnight rather than throwing. */
function addMinutes(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const total = (h * 60 + m + minutes) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

const REQUEST_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------
// Schema -- a structural mirror of ParsedSyllabus in src/lib/types.ts
// ---------------------------------------------------------------------------
//
// Deliberately free of `.min()`/`.max()`/`.optional()`: OpenAI's structured
// outputs ignore or reject most refinements, and every field must be required
// (nullable is fine). Ranges are enforced in `sanitize` instead, where a bad
// value can be clamped rather than failing the whole upload.

const AssessmentKindSchema = z.enum([
  "assignment",
  "exam",
  "quiz",
  "project",
  "reading",
  "lab",
  "presentation",
  "other",
]);

const AssessmentSchema = z.object({
  title: z.string(),
  kind: AssessmentKindSchema,
  dueDate: z.string().nullable(),
  dueTime: z.string().nullable(),
  /**
   * When a sitting ends, for an item the syllabus gave a time range for. Null
   * for a deadline, and for a sitting with only a start -- re-checked against
   * `dueTime` in `sanitize`, because an end before its start would draw the
   * exam block in the wrong place entirely.
   */
  endTime: z.string().nullable(),
  weightPercent: z.number().nullable(),
  sourceText: z.string().nullable(),
  confidence: z.number(),
  notes: z.string().nullable(),
});

const GradeWeightSchema = z.object({
  category: z.string(),
  weightPercent: z.number(),
});

/**
 * What a recurring meeting IS. Mirrors `MeetingKind` in src/lib/types.ts.
 *
 * Office hours are a kind of meeting rather than something to be filtered out:
 * a student wants them, but everything downstream (event titles, the user's
 * per-kind sync preferences) has to be able to tell them apart from a class.
 */
const MeetingKindSchema = z.enum([
  "lecture",
  "recitation",
  "lab",
  "office_hours",
  "other",
]);

/** Runtime copy of the same union, for coercing a value that arrives off-schema. */
const MEETING_KINDS: readonly string[] = [
  "lecture",
  "recitation",
  "lab",
  "office_hours",
  "other",
];

const MeetingTimeSchema = z.object({
  kind: MeetingKindSchema,
  /**
   * The section label verbatim, when the syllabus lists more than one section.
   * Null on a single-section syllabus and on office hours.
   */
  section: z.string().nullable(),
  /**
   * The day abbreviation exactly as the syllabus writes it -- "M/R", "Mon, Thu",
   * "TTh". The numbers in `daysOfWeek` are derived from this by our own parser,
   * because the model indexed Monday as 0 on three meetings out of three across
   * two real syllabi, and a Monday/Thursday class silently landed on Sunday and
   * Wednesday. Copying a string is something it does reliably; counting is not.
   */
  daysText: z.string().nullable(),
  /** Who runs this meeting, when stated -- office hours especially. */
  instructor: z.string().nullable(),
  daysOfWeek: z.array(z.number()),
  startTime: z.string(),
  endTime: z.string(),
  location: z.string().nullable(),
});

/**
 * A stretch of the term the class does not meet. Inclusive; a single day has
 * start === end. Dates are ISO `YYYY-MM-DD`, re-verified in `sanitize`.
 */
const NoClassPeriodSchema = z.object({
  start: z.string(),
  end: z.string(),
  reason: z.string().nullable(),
});

const CoursePolicySchema = z.object({
  category: z.enum(["late_work", "attendance", "integrity", "grading", "other"]),
  summary: z.string(),
  sourceText: z.string().nullable(),
});

const CourseSchema = z.object({
  code: z.string(),
  title: z.string(),
  instructor: z.string().nullable(),
  term: z.string().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  meetingTimes: z.array(MeetingTimeSchema),
  noClass: z.array(NoClassPeriodSchema),
  gradeWeights: z.array(GradeWeightSchema),
  policies: z.array(CoursePolicySchema),
});

const ParsedSyllabusSchema = z.object({
  course: CourseSchema,
  assessments: z.array(AssessmentSchema),
  warnings: z.array(z.string()),
});

type ModelOutput = z.infer<typeof ParsedSyllabusSchema>;

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You extract structured course data from university syllabi. You are feeding a student's calendar and workload planner, so a missed deadline and an invented deadline are both serious errors.

RULES

1. EVERY dated graded item becomes one assessment: problem sets, homework, quizzes, midterms, the final exam, labs, papers, projects, project milestones, presentations, and graded reading responses. A syllabus that lists a deadline twice (once in a summary table, once in the weekly schedule) still yields ONE assessment. Do not invent items that are only discussed in prose ("exams are closed-book" is not an exam).
   - A GRADING ROW IS A LIST, NOT A SUMMARY. "Problem Sets (10) — 30%" with the ten dates in the schedule is ten assessments named as the schedule names them, never one item called "Problem Sets". Never collapse a series into a single entry when the individual deadlines are anywhere in the document.
   - A RECURRENCE RULE IS ALSO A LIST. "Reading responses are due every Monday at 9 AM from Week 2 through Week 14" states thirteen deadlines, so emit thirteen assessments, numbered in order, each on its own date, at confidence ~0.6 and with a note saying they were expanded from the rule. Skip any date the syllabus excludes (a break, a holiday, "except Week 8"). A rule that gives a weekday but no range, or a range but no weekday, cannot be expanded honestly -- emit ONE undated item and a warning instead.
   - A DERIVED DEADLINE ("reports due one week after each lab") is computed from the meeting schedule the same way, at confidence ~0.6 with the derivation in notes. When two stated rules give different dates for the same item ("one week after" vs "at the next lab" across a break), pick one, say which in notes, and add a warning naming the conflict -- never silently choose.
   - A GRADED CATEGORY WITH NO DATES ("Homework (weekly, online) — 15%", "Quizzes (5, unannounced)", "Lab grade 15%", "Labs") is still part of the grade. This includes labs, lab reports and lab grades when no lab dates are listed -- a lab is graded work, not only a meeting. Emit ONE undated assessment for it, titled with the syllabus's own words ("Quizzes (weekly)", "WebAssign homework", "Lab grade"), NEVER numbered -- "Quiz 1" or "Problem Set 1" claims a first item the document does not list -- at confidence ~0.5, with a warning that the dates are not in the document -- the student needs to know it exists and where to look. Never give it a date.

2. DATES. dueDate must be ISO YYYY-MM-DD or null.
   - Resolve relative references ("Week 3", "the Friday before spring break", "the last day of class") against the term start and end dates whenever the syllabus gives you enough to do so, and say how you resolved it in notes.
   - If the syllabus omits the year, infer it from the term so the date lands INSIDE the term. A "Jan 20" in a Fall 2026 term is January 2027, not January 2026.
   - If you cannot resolve a date honestly, set dueDate to null, explain why in notes, and add a warning naming the item. NEVER guess a date. A null date is recoverable; a wrong date is not. When dueDate is null the notes must say what is MISSING ("stated as 'End of Week 4'; the syllabus never says when Week 1 begins") and must never use the word "resolved" -- five items once read "Due date resolved from 'Week 5'" with no date at all. An APPROXIMATE anchor ("approximately during the week of Oct. 5", "sometime in November") is still information: dueDate stays null, and notes carry the anchor verbatim so the student keeps it.
   - dueTime is 24-hour HH:MM, or null when no time is stated. "11:59 pm" is "23:59".
   - When an item gives a time range, \`dueTime\` is the START and \`endTime\` the END, both 24h HH:MM. Exams and quizzes usually do.

3. GRADING. Copy the grading-weight table into course.gradeWeights, one row per category, using the syllabus's own category names. If the weights do not sum to 100, record them as written and add a warning saying so. Put a per-item percentage in assessment.weightPercent only when the syllabus states one for that specific item.
   - weightPercent IS A COPIED NUMBER OR NULL. NOTHING ELSE. It is the percentage the syllabus states for that exact item ("Essay 1 — 20%"), or the per-item figure it states for that item's series ("Quizzes (8 @ 2.5% each)" makes every quiz 2.5; "10 @ 1% each" makes every one 1). If neither is written, it is null. You never divide a category total across items, never average, never take a figure from a neighbouring row ("Quizzes 12%" beside "Exam 1 25%" does not make a quiz 25), and never turn a category total into a per-item number. The category total already lives in gradeWeights; it is not repeated on items.
   - RANK-BASED WEIGHTS ("35% for the exam with the highest grade, 25% for the second, 15% for the lowest"; "the highest of the four exams counts 45%") assign weight by SCORE, so no exam has a weight until grades exist. Copy the rows verbatim into gradeWeights and set weightPercent null on EVERY exam including the final. Never rewrite them as "Exam 1 45%". Never average them. Never give the final the top-ranked figure.

4. POLICIES. Capture late-work / make-up, attendance, and academic-integrity policies into course.policies, plus grading-scale rules as "grading" and anything else notable as "other". summary is 1-3 sentences in your own words; sourceText is the verbatim passage.

5. SOURCE TEXT. assessment.sourceText is the VERBATIM line or sentence the item came from, copied exactly, so the student can click through to it. Never paraphrase it.

6. CONFIDENCE is your honest 0..1 belief that the item's title, kind and date are all correct. Use the full range. An item read straight from an explicit deadline table with a four-digit year is ~0.95. An item whose date you resolved from "Week 7" is ~0.6. An item you are unsure is even graded is ~0.35. Do not default everything to 0.9.

7. MEETING TIMES are every recurring meeting the syllabus states. daysOfWeek uses 0 = Sunday through 6 = Saturday; startTime and endTime are 24-hour HH:MM.
   - OFFICE HOURS ARE NEVER A LECTURE, and a missing class time is never filled from them. When the document gives the class days but no class time, emit the office hours as office_hours and emit NO lecture -- do not relabel the office-hours slots as the class. One syllabus came back with four "lectures" that were its four office-hour blocks, in the professor's office.
   - NO TIME, BLANK TIME. If the document names the days a class meets but never states its time -- or the days are evident because every dated class row in the schedule falls on the same weekdays -- emit that meeting with daysOfWeek set and startTime and endTime both EMPTY STRINGS (""). The application asks the student for the time. Never borrow a time from office hours or another meeting, and never invent a duration: a fabricated 10:00 class once collided with the real 10:00 office hours on the same days. Emit nothing only when neither the days nor the time can be read from the document. When a row states a START time and no end ("9:30 Fri"), put the start in startTime and leave endTime "" -- the application gives it a default length and says so; do not invent an end.
   - DAYS AS WRITTEN. Put the day abbreviation into daysText EXACTLY as the document writes it ("M/R", "Mon, Thu", "TTh", "MWF", "Tuesdays and Thursdays"). daysOfWeek is computed from daysText by the application; fill it in as well, but daysText is what is trusted. Never leave daysText null when the document names days.
   - KIND. Every meeting gets one: "lecture" for a lecture, a class, a "Meets ..." line, or a bare "MWF 10:00-10:50" line; "recitation" for a recitation, discussion, section meeting, problem session or tutorial; "lab" for a lab or laboratory; "office_hours" for office hours, "OH", or student hours; "other" for anything recurring that fits none of these. Getting this wrong is not cosmetic: it decides the event's title and whether the student's preferences put it on the calendar at all, and "MATH 221 class" at the professor's door is a wrong fact.
   - OFFICE HOURS ARE MEETING TIMES. Extract them explicitly, with kind "office_hours", instructor set to whose hours they are, location set to where they are held, and section null. If the syllabus lists hours for several people -- the instructor and one or more TAs -- emit ONE entry per person per pattern. "and by appointment" is not a meeting; do not emit anything for it.
   - SECTIONS. A syllabus that lists several sections lists them ALL; the student attends ONE. Emit each with its own \`section\` label; do not guess which is theirs. When the document has a section table or repeated lines like "Section A / Sec. 01 / LEC 1 / 001 ... days times room [instructor]", emit one meeting per section per pattern, with \`section\` set to the label EXACTLY as the syllabus writes it and \`instructor\` set when that row names one. Never collapse several sections into one entry, never pick one, and never merge their days or rooms. A syllabus with a single section leaves \`section\` null.
   - LOCATION is the room or building string stated for THAT meeting, copied verbatim ("2MTC 907", "Hayes Hall 210"). Never carry a location over from a different line or a different section, never expand an abbreviation, never turn it into an address. Null when that meeting states none.

8. course.startDate and course.endDate are the term bounds, ISO, and only when the syllabus states or clearly implies them. Otherwise null.
   - A DATED SCHEDULE IMPLIES THEM. If the document lists dated class meetings ("Fri., Sept 4 ... Fri., Dec 11" or a week-by-week table with dates), startDate is the first listed meeting and endDate is the last listed meeting or exam, and you say so in a warning. Only leave both null when the document contains no dates that bound the term at all. This bounds the TERM only: it never dates an item. A "FINAL EXAM" printed under the last dated row with no date of its own stays undated -- it is not on the last listed day just because it is printed after it.

9. NO-CLASS PERIODS. course.noClass lists every stretch of the term when this class does NOT meet, as inclusive ISO date ranges ({ start, end, reason }); a single day has start === end. It decides which class meetings are left off the student's calendar, so both directions are errors: a missed break puts a class on the calendar that does not happen, and an invented one deletes a class that does.
   - Take them from explicit statements: "no class", "no classes", "class cancelled", "university closed", a named holiday, a recess, a break, reading days. A weekday named inside a week row resolves against that row's dates -- "No class Mon" in a "Week 3 | Sep 7 - Sep 11" row is 2026-09-07.
   - A GAP IN A DATED SCHEDULE IS A STATEMENT. When the document lists every meeting by date and one regular meeting date is missing from the list -- Fridays Nov 20 then Dec 4, with no Nov 27 -- the class does not meet on the missing date. Emit it as a no-class period with reason null (or the holiday if the document names one nearby). This is the most common way a syllabus expresses a break, and missing it puts a class on the calendar that does not happen.
   - LAST DAY OF CLASSES: if the syllabus states one and it falls before the end of the term, add ONE period running from the DAY AFTER it through course.endDate, with reason "After last day of classes". That is what keeps finals week, and the reading gap before it, off the class schedule. If no last day of classes is stated but a finals/exam week range is, use that range itself with reason "Finals week".
   - Keep a range as one entry: "Thanksgiving recess, Nov 25-27" is a single period, not three. Do not emit overlapping periods.
   - reason is a short label copied from the syllabus's own wording ("Labor Day", "Thanksgiving recess"), or null when it gives none.
   - Return [] when the syllabus mentions no breaks at all. Never add a holiday because your calendar knowledge says one falls in that week -- only what the document states.

Return only what the syllabus supports. Use warnings for anything ambiguous, missing, or that you had to reason around.

WARNINGS ARE NOT OPTIONAL when a date could honestly be two things. If a derived or resolved date has two defensible values -- "one week after the lab" says October 13 but "at the start of the next lab" says October 20 because a break sits between them -- you must (a) pick one, (b) put the reason in that item's notes, and (c) add a warning that names the item AND BOTH dates, so the student can check. A silently chosen date looks exactly like a certain one, and that is the failure this whole format exists to prevent.`;

function userPrompt(text: string, chunkIndex: number, chunkCount: number): string {
  const header =
    chunkCount > 1
      ? `This is part ${chunkIndex + 1} of ${chunkCount} of one syllabus. Extract everything present in THIS part; leave fields null and arrays empty when this part does not cover them.\n\n`
      : "";
  return `${header}SYLLABUS TEXT:\n"""\n${text}\n"""`;
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/** Splits on line boundaries so a deadline row is never cut in half. */
function chunkText(text: string): { chunks: string[]; truncated: boolean } {
  if (text.length <= MAX_CHARS_PER_CALL) return { chunks: [text], truncated: false };

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length && chunks.length < MAX_CHUNKS) {
    let end = Math.min(text.length, cursor + CHUNK_TARGET);
    if (end < text.length) {
      const boundary = text.lastIndexOf("\n", end);
      if (boundary > cursor + CHUNK_TARGET / 2) end = boundary;
    }
    chunks.push(text.slice(cursor, end));
    if (end >= text.length) break;
    cursor = Math.max(cursor + 1, end - CHUNK_OVERLAP);
  }

  const covered = chunks.reduce((n, c) => n + c.length, 0) - CHUNK_OVERLAP * (chunks.length - 1);
  return { chunks, truncated: covered < text.length * 0.98 };
}

// ---------------------------------------------------------------------------
// Post-processing
// ---------------------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function trimOrNull(s: string | null | undefined, max: number): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  return t.length === 0 ? null : t.slice(0, max);
}

/**
 * Re-checks everything the schema could not.
 *
 * The model is asked for ISO dates and it usually complies, but "usually" is
 * not a contract -- so every date goes back through `normalizeDate`, which will
 * also rescue a "Sep 12" the model failed to convert. A date it cannot verify
 * becomes null and earns a warning, never a guess.
 */
function sanitize(raw: ModelOutput, warnings: string[]): ParsedSyllabus {
  const term = trimOrNull(raw.course.term, 60);
  const seasonal = termWindowFromLabel(term);

  const startDate = raw.course.startDate ? normalizeDate(raw.course.startDate, seasonal) : null;
  const endDate = raw.course.endDate ? normalizeDate(raw.course.endDate, seasonal) : null;

  const ctx: DateContext = {
    termStart: startDate ? addDays(startDate, -30) : (seasonal.termStart ?? null),
    termEnd: endDate ? addDays(endDate, 30) : (seasonal.termEnd ?? null),
  };

  let droppedDates = 0;
  const assessments: ParsedSyllabus["assessments"] = [];
  for (const item of raw.assessments) {
    const title = trimOrNull(item.title, 200);
    if (!title) continue;

    const dueDate = item.dueDate ? normalizeDate(item.dueDate, ctx) : null;
    if (item.dueDate && !dueDate) droppedDates += 1;

    const dueTime = item.dueTime ? parseTime(item.dueTime) : null;
    // `endTime` goes back through `parseTime` like every other time, and is
    // then held to the one thing that makes it meaningful: it has to come
    // after the start. An end at or before the start (or with no start at all)
    // is dropped rather than kept, because a calendar block drawn from it
    // would sit somewhere the exam is not. Omitted entirely means null.
    let endTime = item.endTime ? parseTime(item.endTime) : null;
    if (endTime !== null && (dueTime === null || endTime <= dueTime)) endTime = null;

    assessments.push({
      title,
      kind: item.kind,
      dueDate,
      dueTime,
      endTime,
      weightPercent:
        item.weightPercent === null ? null : clamp(Number(item.weightPercent), 0, 100),
      sourceText: trimOrNull(item.sourceText, 600),
      confidence: clamp(Number(item.confidence), 0, 1),
      // Set here, never asked of the model: "a human has checked this" is a
      // fact about the user, not about the document, and the schema above is
      // deliberately free of any field the model could use to claim it.
      reviewedAt: null,
      notes: trimOrNull(item.notes, 400),
    });
  }

  if (droppedDates > 0) {
    warnings.push(
      `${pluralize(droppedDates, "due date")} came back in an unreadable format and ${droppedDates === 1 ? "was" : "were"} left blank rather than guessed.`,
    );
  }

  // Every no-class date is re-derived here for the same reason due dates are:
  // this array decides which class meetings are NOT written to the calendar, so
  // a hallucinated range would silently delete real meetings. A period we
  // cannot verify is dropped and named in a warning, never approximated.
  let droppedPeriods = 0;
  const noClass: NoClassPeriod[] = [];
  for (const period of raw.course.noClass ?? []) {
    const start = normalizeDate(period.start ?? "", ctx);
    // A single-day period is allowed to arrive with only a start.
    const end = normalizeDate(period.end ?? "", ctx) ?? start;
    if (!start || !end) {
      droppedPeriods += 1;
      continue;
    }
    noClass.push({
      start: start <= end ? start : end,
      end: start <= end ? end : start,
      reason: trimOrNull(period.reason, 120),
    });
  }
  if (droppedPeriods > 0) {
    warnings.push(
      `${pluralize(droppedPeriods, "no-class period")} came back with dates we could not verify and ${droppedPeriods === 1 ? "was" : "were"} dropped, so those days are shown as normal class meetings.`,
    );
  }

  const gradeWeights = raw.course.gradeWeights
    .map((w) => ({ category: collapse(w.category), weightPercent: Number(w.weightPercent) }))
    .filter((w) => w.category.length > 0 && Number.isFinite(w.weightPercent) && w.weightPercent > 0);


  // Meetings are re-checked field by field, and the new ones matter as much as
  // the times: a meeting with no `kind` would default to nothing downstream,
  // and a section label that went missing turns "one of four sections" back
  // into "the class", which is the whole bug this shape exists to prevent.
  const seenMeeting = new Set<string>();
  const meetingTimes: MeetingTime[] = [];
  let defaultedEnds = 0;
  for (const m of raw.course.meetingTimes ?? []) {
    // The verbatim day string wins whenever it parses. The model's own numbers
    // are the fallback only, for the same reason `daysText` exists at all.
    const fromText = m.daysText ? parseDaysOfWeek(m.daysText) : [];
    const daysOfWeek =
      fromText.length > 0
        ? fromText
        : [
            ...new Set((m.daysOfWeek ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)),
          ].sort((a, b) => a - b);
    const startTime = parseTime(m.startTime) ?? "";
    const endTime = parseTime(m.endTime) ?? "";
    // A fully blank pair is a meeting whose time the document never stated,
    // kept so the student can be asked (see `meetingNeedsTime` in setup.ts).
    // A stated start with no end -- a recitation table that lists "9:30 Fri"
    // and nothing more -- is a real meeting of unstated length: it keeps its
    // start and is given an hour, with the warning below saying so once.
    // Dropping it silently lost nine such recitations. An end with no start
    // is not a time; no days is not a meeting.
    const blank = startTime === "" && endTime === "";
    let endTimeOut = endTime;
    if (startTime !== "" && endTime === "") {
      endTimeOut = addMinutes(startTime, DEFAULT_MEETING_MINUTES);
      defaultedEnds += 1;
    }
    if (daysOfWeek.length === 0 || (!blank && (startTime === "" || endTimeOut === ""))) continue;

    // "lecture" is the honest default for a meeting the model did not label:
    // it is what an unlabelled "MWF 10:00-10:50" line means, and it is the one
    // kind the student is certainly expected to attend.
    const kind: MeetingKind =
      typeof m.kind === "string" && MEETING_KINDS.includes(m.kind)
        ? (m.kind as MeetingKind)
        : "lecture";
    // Office hours serve everyone enrolled, so a section label on them is a
    // model slip rather than a fact about the document.
    const section = kind === "office_hours" ? null : trimOrNull(m.section, 60);
    const instructor = trimOrNull(m.instructor, 120);
    const location = trimOrNull(m.location, 120);

    // Section and location are part of the identity. Two sections of a big
    // course share a day and a time in different rooms, and a key without them
    // would fold them into one -- exactly the collapse this file now guards.
    const key = [
      kind,
      section ?? "",
      instructor ?? "",
      daysOfWeek.join(","),
      startTime,
      endTime,
      location ?? "",
    ].join("|");
    if (seenMeeting.has(key)) continue;
    seenMeeting.add(key);

    meetingTimes.push({ kind, section, instructor, daysOfWeek, startTime, endTime: endTimeOut, location });
  }
  if (defaultedEnds > 0) {
    warnings.push(
      `${defaultedEnds} meeting${defaultedEnds === 1 ? "" : "s"} state${defaultedEnds === 1 ? "s" : ""} a start time but no end, so each was given one hour. Adjust the end time on the course card if it runs longer.`,
    );
  }


  const policies = raw.course.policies
    .map((p) => ({
      category: p.category,
      summary: collapse(p.summary).slice(0, 600),
      sourceText: trimOrNull(p.sourceText, 1500),
    }))
    .filter((p) => p.summary.length > 0);

  return {
    course: {
      code: collapse(raw.course.code).slice(0, 40) || "COURSE",
      title: collapse(raw.course.title).slice(0, 200) || "Untitled course",
      instructor: trimOrNull(raw.course.instructor, 120),
      term,
      startDate,
      endDate,
      meetingTimes,
      // Never asked of the model, for the same reason `reviewedAt` is not:
      // which sections the student is in is a fact about the student, not about
      // the document. A syllabus listing four sections gives the model no way
      // to know, and a guess puts them in someone else's classroom. Empty, not
      // absent: the questions exist, nobody has answered them yet.
      sections: [],
      // Overlaps folded together, so the same recess stated in the header and
      // again in the week row is one period rather than two.
      noClass: mergeNoClassPeriods(noClass),
      gradeWeights,
      policies,
    },
    assessments,
    warnings,
  };
}

function collapse(s: string): string {
  return typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
}

function titleKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Folds per-chunk results into one syllabus, dropping the duplicates the overlap creates. */
function mergeChunks(parts: ModelOutput[]): ModelOutput {
  const merged: ModelOutput = {
    course: {
      code: "",
      title: "",
      instructor: null,
      term: null,
      startDate: null,
      endDate: null,
      meetingTimes: [],
      noClass: [],
      gradeWeights: [],
      policies: [],
    },
    assessments: [],
    warnings: [],
  };

  const seenAssessment = new Set<string>();
  const seenNoClass = new Set<string>();
  const seenWeight = new Set<string>();
  const seenPolicy = new Set<string>();
  const seenMeeting = new Set<string>();
  const seenWarning = new Set<string>();

  for (const part of parts) {
    const c = part.course;
    if (!merged.course.code && c.code) merged.course.code = c.code;
    if (!merged.course.title && c.title) merged.course.title = c.title;
    merged.course.instructor = merged.course.instructor ?? c.instructor;
    merged.course.term = merged.course.term ?? c.term;
    merged.course.startDate = merged.course.startDate ?? c.startDate;
    merged.course.endDate = merged.course.endDate ?? c.endDate;

    // Kind, section and room are part of the key: two sections of a big course
    // meet at the same time in different rooms, and a day/time key would drop
    // every section after the first as a duplicate of it.
    for (const m of c.meetingTimes) {
      const key = `${m.kind}|${m.section ?? ""}|${m.instructor ?? ""}|${m.daysOfWeek.join(",")}|${m.startTime}|${m.endTime}|${m.location ?? ""}`;
      if (seenMeeting.has(key)) continue;
      seenMeeting.add(key);
      merged.course.meetingTimes.push(m);
    }
    // Keyed on the dates, not the wording: the chunk overlap shows the same
    // break to two passes, which describe it in two different ways.
    for (const p of c.noClass ?? []) {
      const key = `${p.start}|${p.end}`;
      if (seenNoClass.has(key)) continue;
      seenNoClass.add(key);
      merged.course.noClass.push(p);
    }
    for (const w of c.gradeWeights) {
      const key = titleKey(w.category);
      if (!key || seenWeight.has(key)) continue;
      seenWeight.add(key);
      merged.course.gradeWeights.push(w);
    }
    for (const p of c.policies) {
      const key = `${p.category}|${titleKey(p.summary).slice(0, 60)}`;
      if (seenPolicy.has(key)) continue;
      seenPolicy.add(key);
      merged.course.policies.push(p);
    }
    for (const a of part.assessments) {
      const key = `${titleKey(a.title)}|${a.dueDate ?? ""}`;
      if (seenAssessment.has(key)) continue;
      seenAssessment.add(key);
      merged.assessments.push(a);
    }
    for (const warning of part.warnings) {
      const key = titleKey(warning);
      if (seenWarning.has(key)) continue;
      seenWarning.add(key);
      merged.warnings.push(warning);
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Strips anything key-shaped out of a message before it can reach a log or a
 * user. SDK errors sometimes echo request headers, and an API key in an error
 * banner is a credential leak that is very hard to walk back.
 */
function redact(message: string): string {
  return message
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "sk-***")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, "$1***")
    .slice(0, 400);
}

/** True when an OpenAI-backed parse is even possible in this environment. */
export function isConfigured(): boolean {
  const key = process.env.OPENAI_API_KEY;
  return typeof key === "string" && key.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Extracts a syllabus with the OpenAI structured-output API.
 *
 * @throws Error (already redacted) when the model is unreachable, refuses, or
 * returns something unparseable. The caller is expected to fall back rather
 * than surface this directly.
 */
export async function extractWithAi(text: string, signal?: AbortSignal): Promise<ParsedSyllabus> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error("AI parsing is not configured (OPENAI_API_KEY is unset).");
  }

  const client = new OpenAI({
    apiKey,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 1,
  });
  // `OPENAI_PARSE_MODEL` first, then the shared `OPENAI_MODEL` for anyone whose
  // deployment already sets it. One knob for both call sites meant an operator
  // upgrading the parser to gpt-4o silently upgraded chat from mini too, at
  // sixteen times the price per token, with no local test that would show it.
  const model =
    process.env.OPENAI_PARSE_MODEL?.trim() ||
    process.env.OPENAI_MODEL?.trim() ||
    DEFAULT_MODEL;
  const responseFormat = zodResponseFormat(ParsedSyllabusSchema, "parsed_syllabus");

  const { chunks, truncated } = chunkText(text);
  const warnings: string[] = [];
  if (chunks.length > 1) {
    warnings.push(
      `This document was long, so it was read in ${chunks.length} passes. Overlapping items were merged; double-check the schedule for gaps.`,
    );
  }
  if (truncated) {
    warnings.push(
      "This document was too long to read in full. Content past roughly the first 90 pages was skipped.",
    );
  }

  const parts: ModelOutput[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    let completion;
    try {
      completion = await client.chat.completions.parse(
        {
          model,
          temperature: 0,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt(chunks[i], i, chunks.length) },
          ],
          response_format: responseFormat,
        },
        { signal },
      );
    } catch (err) {
      const detail = err instanceof Error ? redact(err.message) : "unknown error";
      throw new Error(`The AI syllabus reader could not be reached: ${detail}`);
    }

    const message = completion.choices[0]?.message;
    if (message?.refusal) {
      throw new Error(`The AI syllabus reader declined to process this document: ${redact(message.refusal)}`);
    }
    const parsed = message?.parsed;
    if (!parsed) {
      throw new Error("The AI syllabus reader returned an unreadable response.");
    }
    parts.push(parsed);
  }

  if (parts.length === 0) {
    throw new Error("The AI syllabus reader returned nothing to parse.");
  }

  const merged = parts.length === 1 ? parts[0] : mergeChunks(parts);
  return sanitize(merged, [...warnings, ...merged.warnings]);
}
