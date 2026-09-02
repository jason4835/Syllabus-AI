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

import type { ParsedSyllabus } from "../types";
import { addDays, normalizeDate, parseTime, termWindowFromLabel, type DateContext } from "./dates";

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
  weightPercent: z.number().nullable(),
  sourceText: z.string().nullable(),
  confidence: z.number(),
  notes: z.string().nullable(),
});

const GradeWeightSchema = z.object({
  category: z.string(),
  weightPercent: z.number(),
});

const MeetingTimeSchema = z.object({
  daysOfWeek: z.array(z.number()),
  startTime: z.string(),
  endTime: z.string(),
  location: z.string().nullable(),
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

2. DATES. dueDate must be ISO YYYY-MM-DD or null.
   - Resolve relative references ("Week 3", "the Friday before spring break", "the last day of class") against the term start and end dates whenever the syllabus gives you enough to do so, and say how you resolved it in notes.
   - If the syllabus omits the year, infer it from the term so the date lands INSIDE the term. A "Jan 20" in a Fall 2026 term is January 2027, not January 2026.
   - If you cannot resolve a date honestly, set dueDate to null, explain why in notes, and add a warning naming the item. NEVER guess a date. A null date is recoverable; a wrong date is not.
   - dueTime is 24-hour HH:MM, or null when no time is stated. "11:59 pm" is "23:59".

3. GRADING. Copy the grading-weight table into course.gradeWeights, one row per category, using the syllabus's own category names. If the weights do not sum to 100, record them as written and add a warning saying so. Put a per-item percentage in assessment.weightPercent only when the syllabus states one for that specific item.

4. POLICIES. Capture late-work / make-up, attendance, and academic-integrity policies into course.policies, plus grading-scale rules as "grading" and anything else notable as "other". summary is 1-3 sentences in your own words; sourceText is the verbatim passage.

5. SOURCE TEXT. assessment.sourceText is the VERBATIM line or sentence the item came from, copied exactly, so the student can click through to it. Never paraphrase it.

6. CONFIDENCE is your honest 0..1 belief that the item's title, kind and date are all correct. Use the full range. An item read straight from an explicit deadline table with a four-digit year is ~0.95. An item whose date you resolved from "Week 7" is ~0.6. An item you are unsure is even graded is ~0.35. Do not default everything to 0.9.

7. MEETING TIMES are the recurring class/lecture/recitation meetings only. Office hours are NOT meeting times. daysOfWeek uses 0 = Sunday through 6 = Saturday.

8. course.startDate and course.endDate are the term bounds, ISO, and only when the syllabus states or clearly implies them. Otherwise null.

Return only what the syllabus supports. Use warnings for anything ambiguous, missing, or that you had to reason around.`;

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

    assessments.push({
      title,
      kind: item.kind,
      dueDate,
      dueTime: item.dueTime ? parseTime(item.dueTime) : null,
      weightPercent:
        item.weightPercent === null ? null : clamp(Number(item.weightPercent), 0, 100),
      sourceText: trimOrNull(item.sourceText, 600),
      confidence: clamp(Number(item.confidence), 0, 1),
      notes: trimOrNull(item.notes, 400),
    });
  }

  if (droppedDates > 0) {
    warnings.push(
      `${droppedDates} due date(s) came back in an unreadable format and were left blank rather than guessed.`,
    );
  }

  const gradeWeights = raw.course.gradeWeights
    .map((w) => ({ category: collapse(w.category), weightPercent: Number(w.weightPercent) }))
    .filter((w) => w.category.length > 0 && Number.isFinite(w.weightPercent) && w.weightPercent > 0);

  const meetingTimes = raw.course.meetingTimes
    .map((m) => ({
      daysOfWeek: [...new Set(m.daysOfWeek.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort(
        (a, b) => a - b,
      ),
      startTime: parseTime(m.startTime) ?? "",
      endTime: parseTime(m.endTime) ?? "",
      location: trimOrNull(m.location, 120),
    }))
    .filter((m) => m.daysOfWeek.length > 0 && m.startTime !== "" && m.endTime !== "");

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
      gradeWeights: [],
      policies: [],
    },
    assessments: [],
    warnings: [],
  };

  const seenAssessment = new Set<string>();
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

    for (const m of c.meetingTimes) {
      const key = `${m.daysOfWeek.join(",")}|${m.startTime}|${m.endTime}`;
      if (seenMeeting.has(key)) continue;
      seenMeeting.add(key);
      merged.course.meetingTimes.push(m);
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
  const model = process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
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
