/**
 * Natural-language Q&A over a built semester plan.
 *
 * Two paths, one contract:
 *
 * - With `OPENAI_API_KEY`, a compact serialization of the plan goes into the
 *   system prompt and the model answers as a study coach. The model is given
 *   the data and told, in as many words, to refuse to invent a date. Every
 *   number it can legitimately quote is already in the context.
 * - Without a key -- demo mode, per docs/API.md -- a deterministic matcher
 *   answers the four questions students actually ask. It is not a stub: it
 *   looks the item up, reads its real study blocks, and answers.
 *
 * The fallback also catches a failed API call, because a chat box that returns
 * "something went wrong" when the network hiccups is worse than one that
 * answers from local data.
 *
 * Both paths share one voice, enforced in different ways. The model parrots the
 * shape of its context, so the context is written the way a person speaks --
 * "Tuesday, October 6th at 12:30 PM (two weeks out)", never "2026-10-06 12:30".
 * Nothing in this file hands an ISO date or a 24-hour clock time to a student
 * or to the model; `friendlyDate`, `friendlyTime` and `relativeDay` are the only
 * way a date becomes words.
 */

import type {
  Assessment,
  AssessmentKind,
  Course,
  SemesterPlan,
  StudyBlock,
  WeekLoad,
} from "@/lib/types";
import { isSitting } from "@/lib/types";
import {
  addDays,
  dayOfWeek,
  daysBetween,
  estimateAssessmentHours,
  estimatedHoursFor,
  formatShortDate,
  heaviestWeek,
  minutesOfDay,
  mondayOf,
  parseISODate,
} from "@/lib/plan/workload";

export interface ChatContext {
  courses: Course[];
  assessments: Assessment[];
  plan: SemesterPlan;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  /** Defaults to `process.env.OPENAI_API_KEY`. Pass "" to force the local path. */
  apiKey?: string;
  /** Defaults to `process.env.OPENAI_MODEL` then a small, cheap chat model. */
  model?: string;
  /** Injectable clock, so "this week" is testable. */
  now?: Date;
  history?: ChatTurn[];
}

const DEFAULT_MODEL = "gpt-4o-mini";

/* -------------------------------------------------------------------------- */
/* Public entry                                                                */
/* -------------------------------------------------------------------------- */

export async function answerQuestion(
  question: string,
  ctx: ChatContext,
  opts: ChatOptions = {},
): Promise<string> {
  const now = opts.now ?? new Date();
  const trimmed = question.trim();
  if (!trimmed) return "Ask me about a deadline, a week, or what to start studying for.";

  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? "";
  if (!apiKey) return answerLocally(trimmed, ctx, now);

  try {
    return await answerWithModel(trimmed, ctx, { ...opts, apiKey, now });
  } catch {
    // Degrade to the local answer rather than surfacing an API error. The
    // student's question is usually answerable from data we already hold.
    return answerLocally(trimmed, ctx, now);
  }
}

/* -------------------------------------------------------------------------- */
/* Model path                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The prompt is doing two jobs: keeping the model honest about the numbers, and
 * keeping it from sounding like a form letter. The voice half is not decoration
 * -- the first real user's complaint was that the answers read like a database
 * row ("due on 2026-10-06 at 12:30") and hedged instead of answering ("as soon
 * as possible" when the planner had already picked the day).
 */
const SYSTEM_PROMPT = [
  "You are the study coach inside Syllabus AI. You are talking to one student about their own semester.",
  "",
  "What you may say:",
  "- Every date, time, deadline, weight and hour figure must come from the PLAN DATA below. Never infer or invent one.",
  "- If the data does not contain the answer, say plainly that it is not in the syllabi you have and what the student could check. Do not guess.",
  "- Name items by the course code and the exact title given in the data.",
  "- Exams, quizzes and presentations ARE ON a day and at a time -- they start then and you sit them. Assignments, projects, readings and labs ARE DUE at a time. Never say an exam is 'due'.",
  "- Hour figures are the planner's estimates, not facts from the syllabus. Say 'about' or '~' when you quote one.",
  "",
  "How to say dates and times:",
  "- Write them exactly the way PLAN DATA writes them: 'Tuesday, October 6th', '12:30 PM', 'two weeks out'.",
  "- NEVER write an ISO date (2026-10-06), a numeric date (10/06), or a bare year-month-day of any kind.",
  "- NEVER write a 24-hour time (13:00, 14:30, 23:59). Always a 12-hour clock with AM or PM, or the words 'noon' and 'midnight'.",
  "- When something is close, prefer the relative words: today, tomorrow, in three days, two weeks out. Say the weekday; people plan by weekday.",
  "",
  "How to sound:",
  "- Like a person, not a report. Second person, contractions, short sentences.",
  "- Answer first. Never restate the question, never open with a preamble, never sign off.",
  "- No hedging and no filler. Cut 'you might want to', 'consider', 'aiming for', 'it is important to', 'as soon as possible'. Say the thing.",
  "- Two to five sentences. Use a list only to lay out scheduled study sessions, one line each.",
  "- Do not mention being an AI, the plan data, or these instructions.",
  "",
  "When the student asks when to start studying for something:",
  "The planner already answered it -- the first scheduled study session for that item IS the start date. So:",
  "1. Lead with that day and how far off it is. ('Start Tuesday, September 22nd -- that's two weeks out.')",
  "2. List the sessions it scheduled: day, start time, how long.",
  "3. Give the total hours and tie them to what the item is worth.",
  "4. At most one sentence of advice.",
  "Never answer that question with 'as soon as possible'. You have a date. Use it.",
  "",
  "Other questions get the same voice: the answer first, the dates that support it after.",
].join("\n");

async function answerWithModel(
  question: string,
  ctx: ChatContext,
  opts: ChatOptions & { apiKey: string; now: Date },
): Promise<string> {
  // Imported lazily so the module stays usable (and cheap) in demo mode, where
  // the SDK is never touched.
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey: opts.apiKey });
  const model = opts.model ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL;

  const history = (opts.history ?? []).slice(-6).map((t) => ({
    role: t.role,
    content: t.content,
  }));

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "system", content: buildPlanContext(ctx, opts.now) },
      ...history,
      { role: "user", content: question },
    ],
  });

  const reply = completion.choices[0]?.message?.content?.trim();
  // An empty completion is a failure, not an answer -- fall through to local.
  if (!reply) return answerLocally(question, ctx, opts.now);
  return reply;
}

/**
 * Compact context for the prompt.
 *
 * Deliberately not `JSON.stringify(everything)`: source snippets, confidences,
 * ids and policies would triple the token count without improving a single
 * answer. What survives is exactly what a coach needs -- who, what, when, how
 * heavy -- in a line-per-record format the model reads reliably.
 *
 * Every date and time here is spelled out in words, and no ISO date or 24-hour
 * time survives into the string. That is the fix for the answers that read like
 * a printout: a language model echoes the register of what you hand it, so
 * telling it to speak like a human while feeding it "2026-10-06 12:30" loses to
 * the example every time. Give it the sentence you want back.
 */
export function buildPlanContext(ctx: ChatContext, now: Date = new Date()): string {
  const { courses, assessments, plan } = ctx;
  const todayIso = localISODate(now);
  const courseById = new Map(courses.map((c) => [c.id, c]));
  const monday = mondayOf(todayIso);
  const lines: string[] = [];

  lines.push("PLAN DATA");
  // The one place the year is spelled out: it anchors every relative phrase
  // below, and no other line needs it.
  lines.push(`Today is ${friendlyDate(todayIso)}, ${todayIso.slice(0, 4)}.`);
  lines.push(`This week runs ${dateRangePhrase(monday, addDays(monday, 6))}.`);
  lines.push("Dates and times below are written the way people say them. Write them back the same way.");

  lines.push("", "COURSES");
  for (const c of courses) {
    const meets = (c.meetingTimes ?? [])
      .map((m) => `${meetingDays(m.daysOfWeek ?? [])} ${timeRangePhrase(m.startTime, m.endTime)}`.trim())
      .join("; ");
    const term =
      c.startDate && c.endDate
        ? ` | term runs ${dateRangePhrase(c.startDate, c.endDate, todayIso)}`
        : "";
    lines.push(`- ${c.code} ${c.title}${meets ? ` | meets ${meets}` : ""}${term}`);
  }

  const dated = assessments
    .filter((a): a is Assessment & { dueDate: string } => Boolean(a.dueDate))
    .slice()
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  // No ids: nothing downstream parses this back, and an id that leaks into an
  // answer ("assessment a3f9c1 is due...") is exactly the machine voice we are
  // trying to get rid of. Course code plus title is how the student names it.
  // "when it happens", not "when it's due": exams, quizzes and presentations are
  // written as happening ON a day, and the model copies the shape it is given.
  lines.push("", "ASSESSMENTS (soonest first: course | title | kind | weight | when it happens -- 'on' for a sitting you attend, 'due' for a deadline | prep estimate)");
  for (const a of dated) {
    const code = courseById.get(a.courseId)?.code ?? "?";
    const weight = a.weightPercent === null ? "weight not stated" : `worth ${a.weightPercent}%`;
    const at = atRange(a);
    const relative =
      a.dueDate < todayIso
        ? `${relativeDay(todayIso, a.dueDate)}, already past`
        : relativeDay(todayIso, a.dueDate);
    lines.push(
      `- ${code} | ${a.title} | ${a.kind} | ${weight} | ${whenWord(a)} ${friendlyDate(a.dueDate, todayIso)}${at ? ` at ${at}` : ""} (${relative}) | about ${estimatedHoursFor(a)}h of prep`,
    );
  }

  const undated = assessments.filter((a) => !a.dueDate);
  if (undated.length) {
    lines.push("", "UNDATED (no resolvable date in the syllabus -- never claim a date for these)");
    for (const a of undated) {
      const code = courseById.get(a.courseId)?.code ?? "?";
      lines.push(`- ${code} | ${a.title} | ${a.kind}`);
    }
  }

  lines.push("", "WEEKLY LOAD (week | dates | estimated hours | how heavy | warning)");
  for (const w of plan.weeks) {
    if (w.assessmentIds.length === 0 && w.estimatedHours === 0) continue; // empty weeks say nothing
    lines.push(
      `- Week ${w.weekNumber} | ${shortDayDate(w.weekStart)} to ${shortDayDate(addDays(w.weekStart, 6))} | about ${w.estimatedHours}h | ${INTENSITY_LABELS[w.intensity]} | ${w.warning ?? "-"}`,
    );
  }

  // Only the near-term blocks: the student is asking about now, and the full
  // term's worth of blocks is mostly noise in a prompt.
  const horizon = addDays(todayIso, 21);
  const upcoming = plan.studyBlocks
    .filter((b) => b.start.slice(0, 10) >= todayIso && b.start.slice(0, 10) <= horizon)
    .slice(0, 40);
  lines.push("", "SCHEDULED STUDY SESSIONS (next three weeks)");
  if (upcoming.length === 0) lines.push("- none scheduled in this window");
  for (const b of upcoming) {
    const day = b.start.slice(0, 10);
    // Spelled out in full here rather than abbreviated: this is the line the
    // model quotes back when it says when to start, so it should already be a
    // sentence fragment a person would say out loud.
    lines.push(
      `- ${friendlyDate(day, todayIso)} (${relativeDay(todayIso, day)}), ${blockTimePhrase(b)} | ${humanizeClockTimes(b.title)}`,
    );
  }

  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Deterministic path                                                          */
/* -------------------------------------------------------------------------- */

const STOPWORDS = new Set([
  "a", "am", "an", "and", "any", "are", "at", "be", "before", "by", "can", "do", "does", "due",
  "for", "get", "got", "have", "how", "i", "im", "in", "is", "it", "long", "many", "me", "much",
  "my", "need", "of", "on", "or", "prep", "should", "start", "studying", "than", "that", "the",
  "this", "to", "up", "was", "we", "what", "whats", "when", "where", "which", "will", "with",
  "you", "your",
]);

/**
 * Shorthand students actually type. Without this, "calc midterm" matches
 * nothing in a course literally called "MATH 221 Calculus II".
 */
const ALIASES: Record<string, string[]> = {
  calc: ["calculus", "math"],
  bio: ["biology"],
  chem: ["chemistry"],
  orgo: ["organic", "chemistry"],
  cs: ["computer", "comp", "csci", "cse"],
  psych: ["psychology"],
  econ: ["economics"],
  stat: ["statistics", "stats"],
  stats: ["statistics", "stat"],
  phys: ["physics"],
  lit: ["literature", "english"],
  hist: ["history"],
  hw: ["homework", "assignment", "problem", "set"],
  homework: ["assignment", "problem", "set"],
  pset: ["problem", "set", "assignment"],
  ps: ["problem", "set", "assignment"],
  proj: ["project"],
  mt: ["midterm", "exam"],
  pres: ["presentation"],
  paper: ["essay", "assignment"],
  midterm: ["exam"],
  final: ["exam"],
  test: ["exam"],
  presentation: ["talk"],
};

/**
 * Normalize free text for matching.
 *
 * Also splits letter/digit runs, so "PS3" and "ps 3" reduce to the same tokens
 * as "Problem Set 3" -- students type the compressed form constantly.
 */
function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

function contentTokens(s: string): string[] {
  return normalizeText(s)
    .split(" ")
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/** Alias expansion applies to the QUERY only -- see `scoreAssessment`. */
function expandQuery(tokens: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of tokens) {
    out.add(t);
    for (const alias of ALIASES[t] ?? []) out.add(alias);
  }
  return out;
}

/**
 * Words in an assessment title that corroborate its `kind`. Kept local rather
 * than shared with the grade-weight join: the two solve the same collision but
 * answer to different vocabularies, and coupling them would mean a tweak for
 * one silently re-ranks the other.
 */
const KIND_WORDS: Record<AssessmentKind, string[]> = {
  exam: ["exam", "exams", "midterm", "midterms", "final", "finals", "test", "tests"],
  quiz: ["quiz", "quizzes"],
  project: ["project", "projects", "capstone"],
  assignment: ["assignment", "assignments", "homework", "problem", "set", "sets", "paper", "essay"],
  reading: ["reading", "readings", "response", "responses"],
  lab: ["lab", "labs", "laboratory"],
  presentation: ["presentation", "presentations", "talk", "speech"],
  other: [],
};

/** Course-title words too generic to identify a course. */
const COURSE_GENERIC = new Set([
  "introduction", "intro", "general", "principles", "fundamentals", "topics",
  "i", "ii", "iii", "iv", "and", "of", "to", "the",
]);

/** The words that would make a student recognise a course: its code and its subject. */
function courseKeywords(c: Course): string[] {
  const code = contentTokens(c.code);
  const title = contentTokens(c.title).filter((t) => t.length >= 4 && !COURSE_GENERIC.has(t));
  return [...new Set([...code, ...title])];
}

const numbersIn = (tokens: string[]) => tokens.filter((t) => /^\d+$/.test(t));

/* Scoring weights. Tiered so that a better *kind* of evidence always beats a
 * larger amount of weaker evidence -- an exact title match can never lose to a
 * pile of incidental shared words. */
const SCORE_EXACT_TITLE = 1000;
const SCORE_PHRASE_BASE = 600;
const SCORE_PHRASE_PER_TOKEN = 20;
const SCORE_COVERAGE = 100; // x fraction of the title the query actually names
const SCORE_PER_COVERED_TOKEN = 12;
const SCORE_KIND_DIRECT = 25;
const SCORE_KIND_ALIAS = 12;
const SCORE_COURSE_NAMED = 20;
const PENALTY_WRONG_COURSE = 60;
const SCORE_NUMBER_MATCH = 15;
const PENALTY_NUMBER_MISMATCH = 40;
/** Below this, we would rather admit we don't know which item was meant. */
const MIN_SCORE = 35;

interface Query {
  normalized: string;
  tokens: string[];
  expanded: Set<string>;
  /** Ids of courses the query explicitly names, if any. */
  namedCourseIds: Set<string>;
}

function buildQuery(question: string, courses: Course[]): Query {
  const normalized = normalizeText(question);
  const tokens = contentTokens(question);
  const expanded = expandQuery(tokens);
  const namedCourseIds = new Set<string>();
  for (const c of courses) {
    if (courseKeywords(c).some((k) => expanded.has(k))) namedCourseIds.add(c.id);
  }
  return { normalized, tokens, expanded, namedCourseIds };
}

/**
 * Score one assessment against the query.
 *
 * The ranking is tiered, because the failure this replaces was a flat additive
 * score: "Final Exam" and "Project final report" both contain "final", and the
 * longer title collected more incidental hits, so it won. Handing a student
 * their project timeline when they asked about their final is the worst kind of
 * wrong -- confidently, specifically wrong.
 *
 *   1. the query *is* the title                    -> unbeatable
 *   2. the query contains the title as a phrase    -> longer titles win ties
 *   3. token overlap weighted by how much of the TITLE is covered, not by how
 *      many words happened to collide. "final" covers half of "Final Exam" and
 *      a third of "Project final report", which is the whole fix.
 *
 * Alias expansion applies to the query only. Expanding the title too (the old
 * behaviour) let "final" in a project title masquerade as the word "exam".
 */
function scoreAssessment(q: Query, a: Assessment, course: Course | undefined): number {
  const title = normalizeText(a.title);
  const titleTokens = contentTokens(a.title);
  if (titleTokens.length === 0) return 0;

  const courseNamed = course ? q.namedCourseIds.has(course.id) : false;
  // Naming a different course is disqualifying evidence, not neutral: "my CS
  // final" must not return the calculus final.
  const wrongCourse = q.namedCourseIds.size > 0 && !courseNamed;

  if (q.normalized === title) return SCORE_EXACT_TITLE - (wrongCourse ? PENALTY_WRONG_COURSE : 0);

  if (` ${q.normalized} `.includes(` ${title} `)) {
    return (
      SCORE_PHRASE_BASE +
      SCORE_PHRASE_PER_TOKEN * titleTokens.length -
      (wrongCourse ? PENALTY_WRONG_COURSE : 0)
    );
  }

  const queryTokenSet = new Set(q.tokens);
  let direct = 0;
  let viaAlias = 0;
  for (const t of titleTokens) {
    if (queryTokenSet.has(t)) direct++;
    else if (q.expanded.has(t)) viaAlias++;
  }
  // An alias hit is real but softer evidence than the student's own word.
  const covered = direct + 0.5 * viaAlias;

  const kindWords = KIND_WORDS[a.kind] ?? [];
  const kindDirect = q.tokens.some((t) => kindWords.includes(t));
  const kindAlias = !kindDirect && kindWords.some((w) => q.expanded.has(w));

  if (covered === 0 && !kindDirect && !courseNamed) return 0;

  let score =
    SCORE_COVERAGE * (covered / titleTokens.length) + SCORE_PER_COVERED_TOKEN * covered;

  if (kindDirect) score += SCORE_KIND_DIRECT;
  else if (kindAlias) score += SCORE_KIND_ALIAS;
  if (courseNamed) score += SCORE_COURSE_NAMED;
  if (wrongCourse) score -= PENALTY_WRONG_COURSE;

  // Ordinals are the most discriminating token an assessment title has:
  // "Midterm 1" and "Midterm 2" are otherwise identical. A number the student
  // typed that the title contradicts is strong evidence they meant another item.
  const titleNumbers = numbersIn(titleTokens);
  if (titleNumbers.length > 0) {
    const courseNumbers = new Set(course ? numbersIn(contentTokens(course.code)) : []);
    const queryNumbers = numbersIn(q.tokens).filter((n) => !courseNumbers.has(n));
    if (queryNumbers.length > 0) {
      score += queryNumbers.some((n) => titleNumbers.includes(n))
        ? SCORE_NUMBER_MATCH
        : -PENALTY_NUMBER_MISMATCH;
    }
  }

  return score;
}

export interface AssessmentMatch {
  assessment: Assessment;
  score: number;
}

/**
 * All plausible matches, best first, with ties already broken.
 *
 * Exposed separately from `findAssessment` because a tie across two courses is
 * information the caller should act on: "Final Exam" when two courses have one
 * is genuinely ambiguous, and picking silently is how a student ends up reading
 * the wrong course's schedule without noticing.
 */
export function rankAssessments(
  question: string,
  courses: Course[],
  assessments: Assessment[],
  now: Date = new Date(),
): AssessmentMatch[] {
  const courseById = new Map(courses.map((c) => [c.id, c]));
  const q = buildQuery(question, courses);
  const today = localISODate(now);

  // Equal evidence: the student almost certainly means the one still ahead of
  // them, soonest first. Falling back to the most recent past item keeps "how
  // did the midterm go" answerable late in the term.
  const preference = (a: Assessment): number => {
    const due = a.dueDate ?? "";
    const rank = due >= today ? 0 : 1;
    const t = due ? parseISODate(due).getTime() : 0;
    return rank === 0 ? t : -t;
  };

  return assessments
    .map((a) => ({ assessment: a, score: scoreAssessment(q, a, courseById.get(a.courseId)) }))
    .filter((r) => r.score >= MIN_SCORE)
    .sort((x, y) => {
      if (y.score !== x.score) return y.score - x.score;
      const px = preference(x.assessment);
      const py = preference(y.assessment);
      const fx = (x.assessment.dueDate ?? "") >= today ? 0 : 1;
      const fy = (y.assessment.dueDate ?? "") >= today ? 0 : 1;
      if (fx !== fy) return fx - fy;
      return px - py;
    });
}

/**
 * Best assessment match for a free-text query, or null when nothing is close
 * enough to name confidently -- the caller then asks which item was meant,
 * which is a better answer than a confident wrong one.
 */
export function findAssessment(
  question: string,
  courses: Course[],
  assessments: Assessment[],
  now: Date = new Date(),
): Assessment | null {
  return rankAssessments(question, courses, assessments, now)[0]?.assessment ?? null;
}

/**
 * A same-score runner-up in a *different* course means the query named an item
 * that exists in more than one class. Returns the note to lead with, or null.
 */
function ambiguityNote(
  matches: AssessmentMatch[],
  courses: Course[],
  chosen: Assessment,
): string | null {
  if (matches.length < 2) return null;
  const rivals = matches.filter(
    (m) => m.score === matches[0].score && m.assessment.courseId !== chosen.courseId,
  );
  if (rivals.length === 0) return null;
  const codeOf = (id: string) => courses.find((c) => c.id === id)?.code ?? "another course";
  const others = [...new Set(rivals.map((m) => codeOf(m.assessment.courseId)))];
  return `Heads up: ${others.length + 1} of your courses have something by that name (${[codeOf(chosen.courseId), ...others].join(", ")}). I'm answering for the one that comes first -- name the course if you meant another.`;
}

type Intent = "heaviest" | "dueThisWeek" | "behind" | "studyFor" | "overview";

function classify(question: string): Intent {
  const q = question.toLowerCase();
  if (/(heaviest|busiest|worst|hardest|craziest|toughest)\s+(week|stretch)/.test(q)) return "heaviest";
  if (/\bweek\b/.test(q) && /(heavy|busy|bad|rough|hard)/.test(q)) return "heaviest";
  if (/(behind|catch\s*up|falling\s+behind|slipping|overdue|missed|late)/.test(q)) return "behind";
  if (/(due|coming up|deadline|happening|on my plate).{0,20}(this week|week|soon|now)/.test(q)) {
    return "dueThisWeek";
  }
  if (/^what'?s? (due|coming|next)/.test(q)) return "dueThisWeek";
  if (/(when|how).{0,30}(start|begin|study|studying|prep|prepare|work on|revise)/.test(q)) {
    return "studyFor";
  }
  if (/(study|prep|prepare|revise|ready) (for|4)\b/.test(q)) return "studyFor";
  return "overview";
}

/**
 * Answers without a model. Never returns a shrug for the four common shapes --
 * it either has the data and says it, or says precisely what is missing.
 */
export function answerLocally(question: string, ctx: ChatContext, now: Date = new Date()): string {
  const intent = classify(question);
  switch (intent) {
    case "heaviest":
      return answerHeaviest(ctx, now);
    case "dueThisWeek":
      return answerDueThisWeek(ctx, now);
    case "behind":
      return answerBehind(ctx, now);
    case "studyFor":
      return answerStudyFor(question, ctx, now);
    default: {
      // An unlabelled question that names a real item is still a question about
      // that item -- answer it rather than falling back to a menu.
      const hit = findAssessment(question, ctx.courses, ctx.assessments, now);
      if (hit) return describeAssessment(hit, ctx, now);
      return answerOverview(ctx, now);
    }
  }
}

function answerHeaviest(ctx: ChatContext, now: Date): string {
  const today = localISODate(now);
  const week = heaviestWeek(ctx.plan.weeks);
  if (!week) return "I don't have any dated work yet, so there's no heaviest week to point at. Upload a syllabus and I'll build the map.";

  const items = week.assessmentIds
    .map((id) => ctx.assessments.find((a) => a.id === id))
    .filter((a): a is Assessment => Boolean(a));
  const label = intensityWord(week.intensity);
  const lines = [
    `Your heaviest stretch is the week of ${friendlyDate(week.weekStart, today)} (${weekRelative(today, week.weekStart)}): about ${week.estimatedHours}h, which I'd call ${label}.`,
  ];
  if (items.length) {
    lines.push("Here's what lands:");
    for (const a of items) {
      const due = a.dueDate as string;
      lines.push(
        `  - ${courseCode(ctx, a)} ${a.title} -- ${a.kind} ${whenWord(a)} ${weekdayThe(due, week.weekStart)}, about ${estimatedHoursFor(a)}h`,
      );
    }
  }
  if (week.warning) lines.push(week.warning + ".");
  const lead = ctx.plan.studyBlocks.filter(
    (b) => b.start.slice(0, 10) < week.weekStart && week.assessmentIds.includes(b.assessmentId),
  );
  if (lead.length) {
    lines.push(
      `I've already pulled ${countWord(lead.length)} study session${lead.length === 1 ? "" : "s"} for that week's work into earlier weeks, which is the only reason it's survivable.`,
    );
  }
  return lines.join("\n");
}

function answerDueThisWeek(ctx: ChatContext, now: Date): string {
  const today = localISODate(now);
  const start = mondayOf(today);
  const end = addDays(start, 6);
  const due = ctx.assessments
    .filter((a) => a.dueDate && a.dueDate >= start && a.dueDate <= end)
    .sort((a, b) => (a.dueDate as string).localeCompare(b.dueDate as string));

  if (due.length === 0) {
    const next = ctx.assessments
      .filter((a) => a.dueDate && a.dueDate > end)
      .sort((a, b) => (a.dueDate as string).localeCompare(b.dueDate as string))
      .slice(0, 3);
    if (next.length === 0) return "Nothing's due this week, and I don't have anything dated after it either.";
    const lines = ["Nothing's due this week. Next up:"];
    for (const a of next) {
      const d = a.dueDate as string;
      lines.push(`  - ${courseCode(ctx, a)} ${a.title} -- ${friendlyDate(d, today)}, ${relativeDay(today, d)}`);
    }
    return lines.join("\n");
  }

  const hours = Math.round(due.reduce((s, a) => s + estimatedHoursFor(a), 0) * 4) / 4;
  const lines = [
    `You've got ${countWord(due.length)} thing${due.length === 1 ? "" : "s"} due this week -- ${dateRangePhrase(start, end, today)} -- and about ${hours}h of work behind ${due.length === 1 ? "it" : "them"}:`,
  ];
  for (const a of due) {
    const d = a.dueDate as string;
    const at = atRange(a);
    const rel = relativeDay(today, d);
    const when = daysBetween(today, d) < 0 ? "already passed" : rel;
    lines.push(
      `  - ${courseCode(ctx, a)} ${a.title} -- ${a.kind}${a.weightPercent !== null ? ` worth ${a.weightPercent}%` : ""}, ${whenWord(a)} ${weekdayThe(d, start)}${at ? ` at ${at}` : ""} (${when})`,
    );
  }
  const todaysBlocks = ctx.plan.studyBlocks.filter((b) => b.start.slice(0, 10) === today);
  if (todaysBlocks.length) {
    lines.push(
      `Today you're down for ${listPhrase(todaysBlocks.map((b) => `${humanizeClockTimes(b.title)} at ${clock(b.start.slice(11, 16))}`))}.`,
    );
  }
  return lines.join("\n");
}

function answerBehind(ctx: ChatContext, now: Date): string {
  const today = localISODate(now);
  const nowIso = `${today}T${pad2(now.getHours())}:${pad2(now.getMinutes())}:00`;

  // "Behind" has two honest meanings: deadlines that have passed, and prep the
  // plan said to do that the clock has now overtaken.
  const passed = ctx.assessments
    .filter((a) => a.dueDate && a.dueDate < today)
    .sort((a, b) => (b.dueDate as string).localeCompare(a.dueDate as string))
    .slice(0, 5);

  const missedByAssessment = new Map<string, StudyBlock[]>();
  for (const b of ctx.plan.studyBlocks) {
    if (b.end >= nowIso) continue;
    const a = ctx.assessments.find((x) => x.id === b.assessmentId);
    if (!a || !a.dueDate || a.dueDate < today) continue; // only prep for live work
    const list = missedByAssessment.get(b.assessmentId) ?? [];
    list.push(b);
    missedByAssessment.set(b.assessmentId, list);
  }

  const lines: string[] = [];
  if (missedByAssessment.size === 0 && passed.length === 0) {
    const nextBlock = ctx.plan.studyBlocks.find((b) => b.start >= nowIso);
    lines.push("You're not behind on anything -- no past deadlines, no study sessions you've blown past.");
    if (nextBlock) {
      lines.push(
        `Next on the plan is ${humanizeClockTimes(nextBlock.title)}, ${whenPhrase(today, nextBlock.start)}.`,
      );
    }
    return lines.join("\n");
  }

  if (missedByAssessment.size > 0) {
    const missedTotal = [...missedByAssessment.values()].reduce((s, b) => s + b.length, 0);
    lines.push(
      `You've walked past ${countWord(missedTotal)} study session${missedTotal === 1 ? "" : "s"} the plan had for you. Here's what that costs:`,
    );
    for (const [id, blocks] of missedByAssessment) {
      const a = ctx.assessments.find((x) => x.id === id);
      if (!a) continue;
      const dueDate = a.dueDate as string;
      lines.push(
        `  - ${courseCode(ctx, a)} ${a.title}: ${countWord(blocks.length)} missed session${blocks.length === 1 ? "" : "s"}, and it's ${whenWord(a)} ${friendlyDate(dueDate, today)} -- ${relativeDay(today, dueDate)}.`,
      );
    }
    lines.push("Those hours don't disappear -- they get squeezed into the days you have left.");
  }
  if (passed.length > 0) {
    // Lead with the state of things when there were no missed sessions to
    // report -- opening a reply with a bare list header is how a report reads,
    // not how an answer does.
    if (missedByAssessment.size === 0) {
      lines.push(
        `Your study sessions are all on track, but ${countWord(passed.length)} deadline${passed.length === 1 ? " has" : "s have"} gone by. Mark them off if they're done:`,
      );
    } else {
      lines.push("Deadlines already behind you (mark them off if they're done):");
    }
    for (const a of passed) {
      const d = a.dueDate as string;
      lines.push(`  - ${courseCode(ctx, a)} ${a.title} -- was ${whenWord(a)} ${friendlyDate(d, today)}, ${relativeDay(today, d)}`);
    }
  }
  return lines.join("\n");
}

function answerStudyFor(question: string, ctx: ChatContext, now: Date): string {
  const matches = rankAssessments(question, ctx.courses, ctx.assessments, now);
  const hit = matches[0]?.assessment ?? null;
  if (hit) {
    const note = ambiguityNote(matches, ctx.courses, hit);
    const body = describeAssessment(hit, ctx, now);
    return note ? `${note}\n${body}` : body;
  }
  {
    const upcoming = ctx.assessments
      .filter((a) => a.dueDate && a.dueDate >= localISODate(now))
      .sort((a, b) => (a.dueDate as string).localeCompare(b.dueDate as string))
      .slice(0, 4);
    const lines = ["I couldn't tell which one you meant. Here's what's closest on the calendar:"];
    for (const a of upcoming) {
      const d = a.dueDate as string;
      lines.push(`  - ${courseCode(ctx, a)} ${a.title} -- ${whenWord(a)} ${friendlyDate(d, localISODate(now))}, ${relativeDay(localISODate(now), d)}`);
    }
    lines.push("Name one of those and I'll give you the schedule I built for it.");
    return lines.join("\n");
  }
}

/**
 * The answer to "when should I start studying for X".
 *
 * Ordered the way the student needs it, not the way the data is shaped: the
 * planner already chose a start day, so that day is the first thing said. The
 * old version opened with the item's metadata and buried the recommendation
 * under the hour-estimate derivation, which is how an answer ends up sounding
 * like "as soon as possible" even when a real date was sitting right there.
 */
function describeAssessment(a: Assessment, ctx: ChatContext, now: Date): string {
  const today = localISODate(now);
  const code = courseCode(ctx, a);
  const est = estimateAssessmentHours(a);
  const blocks = ctx.plan.studyBlocks.filter((b) => b.assessmentId === a.id);
  const name = `${code} ${a.title}`.trim();

  if (!a.dueDate) {
    return `${name} is in your plan, but the syllabus never gave a date I could pin down, so I can't schedule around it. Add the date from the syllabus or your LMS and I'll build the study ladder right away.`;
  }

  const at = atPhrase(a);
  const dueWhen = `${friendlyDate(a.dueDate, today)}${at ? ` at ${at}` : ""}`;
  const verb = whenWord(a);
  const dueRel = relativeDay(today, a.dueDate);
  const worth = a.weightPercent !== null ? `, worth ${a.weightPercent}% of your grade` : "";

  if (blocks.length === 0) {
    const past = daysBetween(today, a.dueDate) < 0;
    return past
      ? `${name} was ${verb} ${dueWhen}, ${dueRel}, so there's nothing left to schedule for it.`
      : `${name} is ${verb} ${dueWhen} -- ${dueRel}${worth}. I haven't got any sessions on the calendar for it: there was no free window left ${isSitting(a) ? "beforehand" : "before the deadline"}, so grab whatever time you can and budget about ${est.hours}h.`;
  }

  const startDay = blocks[0].start.slice(0, 10);
  const untilStart = daysBetween(today, startDay);
  const lines: string[] = [];

  lines.push(
    untilStart <= 0
      ? `Start today -- your first session is at ${clock(blocks[0].start.slice(11, 16))}.`
      : `Start ${friendlyDate(startDay, today)} -- that's ${relativeDay(today, startDay)}.`,
  );

  lines.push(
    `I've put ${countWord(blocks.length)} session${blocks.length === 1 ? "" : "s"} on your plan for ${name}:`,
  );
  for (const b of blocks) {
    const day = b.start.slice(0, 10);
    // The block title repeats the course and item, which the lead sentence just
    // said. Four rows of "MATH 221 Midterm Exam 1 -- Review 3/4" is a database
    // dump; "Review 3/4" is what a person would have written.
    lines.push(`  - ${shortDayDate(day)}, ${blockTimePhrase(b)} -- ${sessionLabel(b.title, name)}`);
  }

  lines.push(
    `That's about ${est.hours}h in total, and it's ${verb} ${dueWhen} -- ${dueRel}${worth}.`,
  );
  // The planner's own rationale is the most persuasive sentence we have, but it
  // was written for a UI card, so its clock times get the same 12-hour pass.
  lines.push(humanizeClockTimes(blocks[0].rationale));
  return lines.join("\n");
}

function answerOverview(ctx: ChatContext, now: Date): string {
  const today = localISODate(now);
  const upcoming = ctx.assessments
    .filter((a) => a.dueDate && a.dueDate >= today)
    .sort((a, b) => (a.dueDate as string).localeCompare(b.dueDate as string))
    .slice(0, 3);
  const worst = heaviestWeek(ctx.plan.weeks);

  const lines: string[] = [];
  if (upcoming.length) {
    lines.push("Here's where you stand. Next up:");
    for (const a of upcoming) {
      const d = a.dueDate as string;
      const at = atRange(a);
      lines.push(`  - ${courseCode(ctx, a)} ${a.title} -- ${friendlyDate(d, today)}${at ? ` at ${at}` : ""}, ${relativeDay(today, d)}`);
    }
  } else {
    lines.push("You've got nothing dated ahead of you right now.");
  }
  if (worst) {
    lines.push(
      `Your heaviest week starts ${friendlyDate(worst.weekStart, today)} -- ${relativeDay(today, worst.weekStart)}, about ${worst.estimatedHours}h.`,
    );
  }
  const next = ctx.plan.studyBlocks.find((b) => b.start.slice(0, 10) >= today);
  if (next) {
    lines.push(`Your next study session is ${whenPhrase(today, next.start)} -- ${humanizeClockTimes(next.title)}.`);
  }
  lines.push("Ask me when to start studying for something, what's due this week, which week is your worst, or what you're behind on.");
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

function courseCode(ctx: ChatContext, a: Assessment): string {
  return ctx.courses.find((c) => c.id === a.courseId)?.code ?? "";
}

/*
 * An exam is not handed in. It starts, you sit it, it ends -- so it is ON a day
 * at a time, while an assignment is DUE at one. Saying "your final is due at
 * 10:15" is not just clumsy: it is the sentence that made a student read their
 * exam as a cutoff and turn up when it was over. The three helpers below are the
 * only place that distinction becomes words, on both the model path (which
 * echoes the register of its context) and the local one.
 */

/** "on" for a sitting, "due" for a deadline. Reads after "is", "was" or "it's". */
function whenWord(a: Assessment): string {
  return isSitting(a) ? "on" : "due";
}

/**
 * The clock half of when an item happens, for prose: "10:15 AM (until 12:15 PM)"
 * for a sitting with a stated end, "10:15 AM" otherwise. Null when the syllabus
 * gave no time at all.
 */
function atPhrase(a: Assessment): string | null {
  const start = friendlyTime(a.dueTime);
  if (!start) return null;
  const end = isSitting(a) ? friendlyTime(a.endTime) : null;
  return end ? `${start} (until ${end})` : start;
}

/** The same information compressed for a list row: "10:15 AM–12:15 PM". */
function atRange(a: Assessment): string | null {
  const start = friendlyTime(a.dueTime);
  if (!start) return null;
  const end = isSitting(a) ? friendlyTime(a.endTime) : null;
  return end ? `${start}–${end}` : start;
}

function intensityWord(i: WeekLoad["intensity"]): string {
  return (["calm", "normal", "busy", "a crunch week"] as const)[i];
}

/** Same scale as `intensityWord`, but as a tag for a context line. */
const INTENSITY_LABELS = ["calm", "normal", "busy", "crunch"] as const;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function localISODate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/* -------------------------------------------------------------------------- */
/* Saying dates and times the way people say them                              */
/* -------------------------------------------------------------------------- */

/*
 * Everything below turns the storage format into speech. Dates in this app are
 * floating local values -- the syllabus's own wall clock -- so there is no zone
 * math to do here, only wording. `parseISODate` anchors at UTC midnight, and
 * every formatter below is pinned to UTC for exactly that reason: the goal is
 * to read the same digits back, never to convert them.
 */

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT_DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_FORMAT = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" });

/** Small numbers read better as words in prose; past twelve, digits win. */
const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven",
  "eight", "nine", "ten", "eleven", "twelve",
];

function countWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

/**
 * "1st", "2nd", "3rd", "11th", "21st".
 *
 * The teens are the whole reason this is a function and not `n + "th"`: 11, 12
 * and 13 take "th" even though their last digit says otherwise, and getting
 * "the 21th" in front of a user is the kind of detail that makes the rest of
 * the answer feel machine-written.
 */
export function ordinal(n: number): string {
  const teens = Math.abs(n) % 100;
  if (teens >= 11 && teens <= 13) return `${n}th`;
  switch (Math.abs(n) % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function weekdayName(iso: string): string {
  return DAY_NAMES[dayOfWeek(iso)];
}

function dayNumber(iso: string): number {
  return parseISODate(iso).getUTCDate();
}

function monthName(iso: string): string {
  return MONTH_FORMAT.format(parseISODate(iso));
}

/**
 * "Tuesday, October 6th" -- the form a person says out loud.
 *
 * The year appears only when it differs from today's, so a spring deadline
 * cannot be mistaken for one that already went by, and an ordinary in-term date
 * is not cluttered with a number nobody says.
 */
export function friendlyDate(iso: string, today?: string): string {
  const base = `${weekdayName(iso)}, ${monthName(iso)} ${ordinal(dayNumber(iso))}`;
  const year = iso.slice(0, 4);
  return today && year !== today.slice(0, 4) ? `${base}, ${year}` : base;
}

/** "Tue, Oct 6" -- for list rows, where the full form would be noise. */
function shortDayDate(iso: string): string {
  return `${SHORT_DAY_NAMES[dayOfWeek(iso)]}, ${formatShortDate(iso)}`;
}

/**
 * "Tuesday the 13th" -- how you refer to a day once the month is established
 * by the sentence around it. Falls back to the full form across a month
 * boundary, where dropping the month would be genuinely ambiguous.
 */
function weekdayThe(iso: string, contextIso: string): string {
  if (iso.slice(0, 7) !== contextIso.slice(0, 7)) return friendlyDate(iso);
  return `${weekdayName(iso)} the ${ordinal(dayNumber(iso))}`;
}

/** "Monday, October 12th through Sunday the 18th". */
function dateRangePhrase(startIso: string, endIso: string, today?: string): string {
  return `${friendlyDate(startIso, today)} through ${weekdayThe(endIso, startIso)}`;
}

/**
 * "12:30 PM", "1 PM", "noon", "midnight".
 *
 * The trailing ":00" goes: nobody says "one o'clock zero zero". Noon and
 * midnight get their names because "12 PM" makes readers stop and check.
 */
export function friendlyTime(hhmm: string | null): string | null {
  const mins = minutesOfDay(hhmm);
  if (mins === null) return null;
  const h24 = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  if (m === 0 && h24 === 0) return "midnight";
  if (m === 0 && h24 === 12) return "noon";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const meridiem = h24 < 12 ? "AM" : "PM";
  return m === 0 ? `${h12} ${meridiem}` : `${h12}:${pad2(m)} ${meridiem}`;
}

/** Clock time from planner-produced "HH:MM", which is always well-formed. */
function clock(hhmm: string): string {
  return friendlyTime(hhmm) ?? hhmm;
}

/**
 * "1 PM to 2:30 PM".
 *
 * Speech would drop the first AM/PM ("1 to 2:30 PM"), but this string is also
 * what the model reads, and a bare "3:50" in its context is exactly the token
 * it will echo back as a 24-hour time. Every clock time that leaves this file
 * carries its meridiem.
 */
function timeRangePhrase(startHHMM: string, endHHMM: string): string {
  const start = friendlyTime(startHHMM);
  const end = friendlyTime(endHHMM);
  if (!start || !end) return "";
  return `${start} to ${end}`;
}

/** "1 PM to 2:30 PM (1.5h)" for one study block. */
function blockTimePhrase(b: StudyBlock): string {
  const start = b.start.slice(11, 16);
  const end = b.end.slice(11, 16);
  const startMins = minutesOfDay(start);
  const endMins = minutesOfDay(end);
  const range = timeRangePhrase(start, end);
  if (startMins === null || endMins === null) return range;
  const hours = Math.round(((endMins - startMins) / 60) * 4) / 4;
  return `${range} (${hours}h)`;
}

/**
 * How far off a day is, in words: "today", "tomorrow", "in three days",
 * "two weeks out", "almost three weeks out".
 *
 * Past a week, days stop being meaningful to a student -- "in 17 days" is a
 * number you have to convert in your head, while "just over two weeks out" is
 * already the answer. Nothing here can produce "in 0 days".
 */
export function relativeDay(fromIso: string, toIso: string): string {
  const delta = daysBetween(fromIso, toIso);
  if (delta === 0) return "today";
  if (delta === 1) return "tomorrow";
  if (delta === -1) return "yesterday";

  const ahead = delta > 0;
  const days = Math.abs(delta);
  const tail = ahead ? "out" : "ago";
  if (days < 7) return ahead ? `in ${countWord(days)} days` : `${countWord(days)} days ago`;

  const weeks = Math.floor(days / 7);
  const spare = days % 7;
  const weekPhrase = (n: number) => (n === 1 ? "a week" : `${countWord(n)} weeks`);
  if (spare === 0) return `${weekPhrase(weeks)} ${tail}`;
  // Round to the nearest week the way a person does: a couple of days over is
  // "just over", most of the way to the next week is "almost".
  if (spare <= 3) return `just over ${weekPhrase(weeks)} ${tail}`;
  return `almost ${weekPhrase(weeks + 1)} ${tail}`;
}

/**
 * When a study block happens, said once: "today at 3:50 PM", "tomorrow at
 * 1 PM", "Friday, September 25th at 1 PM -- in three days". Repeating the
 * weekday after "today" is the tell of generated copy.
 */
function whenPhrase(today: string, startIso: string): string {
  const day = startIso.slice(0, 10);
  const at = clock(startIso.slice(11, 16));
  const rel = relativeDay(today, day);
  if (rel === "today" || rel === "tomorrow" || rel === "yesterday") return `${rel} at ${at}`;
  return `${friendlyDate(day, today)} at ${at} -- ${rel}`;
}

/**
 * How far off a whole week is. A week that contains today is "this week", not
 * "yesterday" -- which is what the day-level phrasing produces for a Monday
 * week-start read on a Tuesday, and it reads as a bug.
 */
function weekRelative(today: string, weekStart: string): string {
  const delta = daysBetween(mondayOf(today), weekStart);
  if (delta === 0) return "this week";
  if (delta === 7) return "next week";
  if (delta === -7) return "last week";
  return relativeDay(today, weekStart);
}

/** A study block's title with the item name it repeats stripped off the front. */
function sessionLabel(title: string, name: string): string {
  const clean = humanizeClockTimes(title);
  if (clean === name) return "study session";
  const prefix = `${name} -- `;
  return clean.startsWith(prefix) ? clean.slice(prefix.length) : clean;
}

/** "Mon/Wed/Fri" for a class that meets those days. */
function meetingDays(days: number[]): string {
  return days.map((d) => SHORT_DAY_NAMES[d] ?? String(d)).join("/");
}

/** "a, b and c" -- no Oxford comma, because that is how this app writes. */
function listPhrase(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Rewrite 24-hour clock times inside copy we did not write.
 *
 * Block titles and rationales come from the planner, which formats for a UI
 * card and can say things like "no free window before 18:00". Chat is a spoken
 * register; this file promises no 24-hour times reach the student, so borrowed
 * prose gets the same pass. Times already carrying AM/PM are left alone.
 */
function humanizeClockTimes(text: string): string {
  return text.replace(/\b(\d{1,2}):(\d{2})\b(\s*(?:AM|PM|am|pm))?/g, (match, h, m, meridiem) => {
    if (meridiem) return match;
    return friendlyTime(`${h}:${m}`) ?? match;
  });
}
