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
 */

import type {
  Assessment,
  AssessmentKind,
  Course,
  SemesterPlan,
  StudyBlock,
  WeekLoad,
} from "@/lib/types";
import {
  addDays,
  daysBetween,
  estimateAssessmentHours,
  estimatedHoursFor,
  formatShortDate,
  heaviestWeek,
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

const SYSTEM_PROMPT = [
  "You are the study coach inside Syllabus AI. You answer questions about one student's semester.",
  "",
  "Rules you must follow:",
  "- Every date, deadline, weight and hour figure you state must come from the PLAN DATA below. Never infer or invent one.",
  "- If the data does not contain the answer, say plainly that it is not in the syllabi you have, and suggest what the student could check. Do not guess.",
  "- Refer to items by the course code and the exact title given in the data.",
  "- Be concrete and short: a few sentences, or a short list. No preamble, no disclaimers about being an AI.",
  "- When the student asks what to do, cite the scheduled study blocks by day rather than inventing new ones.",
  "- Hour figures are the planner's estimates, not facts from the syllabus. Say 'about' or '~' when quoting them.",
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
 */
export function buildPlanContext(ctx: ChatContext, now: Date = new Date()): string {
  const { courses, assessments, plan } = ctx;
  const todayIso = localISODate(now);
  const courseById = new Map(courses.map((c) => [c.id, c]));
  const lines: string[] = [];

  lines.push("PLAN DATA");
  lines.push(`TODAY: ${todayIso} (${weekdayName(todayIso)}), current week starts ${mondayOf(todayIso)}`);

  lines.push("", "COURSES");
  for (const c of courses) {
    const meets = (c.meetingTimes ?? [])
      .map((m) => `${(m.daysOfWeek ?? []).map(shortDay).join("")} ${m.startTime}-${m.endTime}`)
      .join("; ");
    const term = c.startDate && c.endDate ? ` | term ${c.startDate}..${c.endDate}` : "";
    lines.push(`- ${c.code} ${c.title}${meets ? ` | meets ${meets}` : ""}${term}`);
  }

  const dated = assessments
    .filter((a): a is Assessment & { dueDate: string } => Boolean(a.dueDate))
    .slice()
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  lines.push("", "ASSESSMENTS (id | course | title | kind | weight | due | planner hour estimate)");
  for (const a of dated) {
    const code = courseById.get(a.courseId)?.code ?? "?";
    const weight = a.weightPercent === null ? "weight n/a" : `${a.weightPercent}%`;
    const time = a.dueTime ? ` ${a.dueTime}` : "";
    const past = a.dueDate < todayIso ? " [past]" : "";
    lines.push(
      `- ${a.id} | ${code} | ${a.title} | ${a.kind} | ${weight} | due ${a.dueDate}${time}${past} | ~${estimatedHoursFor(a)}h`,
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

  lines.push("", "WEEKS (number | monday | estimated hours | intensity 0-3 | warning)");
  for (const w of plan.weeks) {
    if (w.assessmentIds.length === 0 && w.estimatedHours === 0) continue; // empty weeks say nothing
    lines.push(
      `- W${w.weekNumber} | ${w.weekStart} | ~${w.estimatedHours}h | ${w.intensity} | ${w.warning ?? "-"}`,
    );
  }

  // Only the near-term blocks: the student is asking about now, and the full
  // term's worth of blocks is mostly noise in a prompt.
  const horizon = addDays(todayIso, 21);
  const upcoming = plan.studyBlocks
    .filter((b) => b.start.slice(0, 10) >= todayIso && b.start.slice(0, 10) <= horizon)
    .slice(0, 40);
  lines.push("", "SCHEDULED STUDY BLOCKS (next 3 weeks)");
  if (upcoming.length === 0) lines.push("- none scheduled in this window");
  for (const b of upcoming) {
    lines.push(`- ${b.start.slice(0, 10)} ${b.start.slice(11, 16)}-${b.end.slice(11, 16)} | ${b.title}`);
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
      return answerHeaviest(ctx);
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

function answerHeaviest(ctx: ChatContext): string {
  const week = heaviestWeek(ctx.plan.weeks);
  if (!week) return "I don't have any dated work yet, so there's no heaviest week to point at. Upload a syllabus and I'll build the map.";

  const items = week.assessmentIds
    .map((id) => ctx.assessments.find((a) => a.id === id))
    .filter((a): a is Assessment => Boolean(a));
  const label = intensityWord(week.intensity);
  const lines = [
    `Week ${week.weekNumber} (${formatShortDate(week.weekStart)}-${formatShortDate(addDays(week.weekStart, 6))}) is your heaviest: about ${week.estimatedHours}h of work, which I'd call ${label}.`,
  ];
  if (items.length) {
    lines.push("What lands that week:");
    for (const a of items) lines.push(`  - ${courseCode(ctx, a)} ${a.title} (${a.kind}, due ${formatShortDate(a.dueDate as string)}) -- ~${estimatedHoursFor(a)}h`);
  }
  if (week.warning) lines.push(week.warning + ".");
  const lead = ctx.plan.studyBlocks.filter(
    (b) => b.start.slice(0, 10) < week.weekStart && week.assessmentIds.includes(b.assessmentId),
  );
  if (lead.length) {
    lines.push(
      `I've already pushed ${lead.length} study session${lead.length === 1 ? "" : "s"} for that week's work into earlier weeks, which is the only reason it's survivable.`,
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
    if (next.length === 0) return "Nothing is due this week, and I don't have anything dated after it either.";
    const lines = ["Nothing is due this week. Next up:"];
    for (const a of next) {
      lines.push(`  - ${courseCode(ctx, a)} ${a.title} -- ${formatShortDate(a.dueDate as string)} (${daysBetween(today, a.dueDate as string)} days out)`);
    }
    return lines.join("\n");
  }

  const hours = due.reduce((s, a) => s + estimatedHoursFor(a), 0);
  const lines = [
    `${due.length} thing${due.length === 1 ? "" : "s"} due this week (${formatShortDate(start)}-${formatShortDate(end)}), about ${Math.round(hours * 4) / 4}h of work:`,
  ];
  for (const a of due) {
    const d = daysBetween(today, a.dueDate as string);
    const when = d < 0 ? "already passed" : d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`;
    lines.push(
      `  - ${courseCode(ctx, a)} ${a.title} (${a.kind}${a.weightPercent !== null ? `, ${a.weightPercent}%` : ""}) -- due ${formatShortDate(a.dueDate as string)}, ${when}`,
    );
  }
  const todaysBlocks = ctx.plan.studyBlocks.filter((b) => b.start.slice(0, 10) === today);
  if (todaysBlocks.length) {
    lines.push(`Today's plan: ${todaysBlocks.map((b) => `${b.start.slice(11, 16)} ${b.title}`).join(", ")}.`);
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
    lines.push("Nothing has slipped -- no past deadlines and no study sessions behind you.");
    if (nextBlock) {
      lines.push(`Next on the plan: ${nextBlock.title} on ${formatShortDate(nextBlock.start.slice(0, 10))} at ${nextBlock.start.slice(11, 16)}.`);
    }
    return lines.join("\n");
  }

  if (missedByAssessment.size > 0) {
    lines.push("Study sessions the plan scheduled that have already gone by:");
    for (const [id, blocks] of missedByAssessment) {
      const a = ctx.assessments.find((x) => x.id === id);
      if (!a) continue;
      const d = daysBetween(today, a.dueDate as string);
      lines.push(
        `  - ${courseCode(ctx, a)} ${a.title}: ${blocks.length} missed session${blocks.length === 1 ? "" : "s"}, and it's due in ${d} day${d === 1 ? "" : "s"} (${formatShortDate(a.dueDate as string)}).`,
      );
    }
    lines.push("Those hours don't disappear -- they get compressed into the days that are left.");
  }
  if (passed.length > 0) {
    lines.push("Deadlines already behind you (mark them off if they're done):");
    for (const a of passed) {
      lines.push(`  - ${courseCode(ctx, a)} ${a.title} -- was due ${formatShortDate(a.dueDate as string)}`);
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
    const lines = ["I couldn't tell which item you meant. Here's what's closest on the calendar:"];
    for (const a of upcoming) {
      lines.push(`  - ${courseCode(ctx, a)} ${a.title} -- due ${formatShortDate(a.dueDate as string)}`);
    }
    lines.push("Name one of those and I'll give you the schedule I built for it.");
    return lines.join("\n");
  }
}

function describeAssessment(a: Assessment, ctx: ChatContext, now: Date): string {
  const today = localISODate(now);
  const code = courseCode(ctx, a);
  const est = estimateAssessmentHours(a);
  const blocks = ctx.plan.studyBlocks.filter((b) => b.assessmentId === a.id);

  if (!a.dueDate) {
    return `${code} ${a.title} is in your plan but the syllabus never gave a resolvable date, so I can't schedule it. Check the syllabus or your LMS and add the date -- I'll build the study ladder as soon as it has one.`;
  }

  const d = daysBetween(today, a.dueDate);
  const when =
    d < 0 ? `was due ${formatShortDate(a.dueDate)}` : d === 0 ? "is due today" : `is due ${formatShortDate(a.dueDate)}, ${d} day${d === 1 ? "" : "s"} out`;

  const lines = [
    `${code} ${a.title} (${a.kind}${a.weightPercent !== null ? `, worth ${a.weightPercent}%` : ""}) ${when}. I budgeted about ${est.hours}h: ${est.explanation}`,
  ];

  if (blocks.length === 0) {
    lines.push("I haven't got any study sessions on the calendar for it -- either the date has passed or there was no free window left before it.");
    return lines.join("\n");
  }

  const first = blocks[0];
  const startDay = first.start.slice(0, 10);
  const untilStart = daysBetween(today, startDay);
  lines.push(
    untilStart <= 0
      ? `Start now -- the first session is ${formatShortDate(startDay)}.`
      : `Start ${formatShortDate(startDay)} (${untilStart} day${untilStart === 1 ? "" : "s"} from now). Earlier is fine; later is where this gets expensive.`,
  );
  lines.push(`${blocks.length} session${blocks.length === 1 ? "" : "s"} on the plan:`);
  for (const b of blocks) {
    lines.push(`  - ${formatShortDate(b.start.slice(0, 10))} ${b.start.slice(11, 16)}-${b.end.slice(11, 16)} -- ${b.title}`);
  }
  lines.push(blocks[0].rationale);
  return lines.join("\n");
}

function answerOverview(ctx: ChatContext, now: Date): string {
  const today = localISODate(now);
  const upcoming = ctx.assessments
    .filter((a) => a.dueDate && a.dueDate >= today)
    .sort((a, b) => (a.dueDate as string).localeCompare(b.dueDate as string))
    .slice(0, 3);
  const worst = heaviestWeek(ctx.plan.weeks);

  const lines = ["Here's where you stand:"];
  if (upcoming.length) {
    lines.push("Next up:");
    for (const a of upcoming) {
      lines.push(`  - ${courseCode(ctx, a)} ${a.title} -- ${formatShortDate(a.dueDate as string)} (${daysBetween(today, a.dueDate as string)} days out)`);
    }
  } else {
    lines.push("Nothing dated ahead of you right now.");
  }
  if (worst) {
    lines.push(`Heaviest week ahead: week ${worst.weekNumber} starting ${formatShortDate(worst.weekStart)}, about ${worst.estimatedHours}h.`);
  }
  const next = ctx.plan.studyBlocks.find((b) => b.start.slice(0, 10) >= today);
  if (next) lines.push(`Next study session: ${formatShortDate(next.start.slice(0, 10))} at ${next.start.slice(11, 16)} -- ${next.title}.`);
  lines.push("Ask me when to start studying for something, what's due this week, what your heaviest week is, or what you're behind on.");
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

function courseCode(ctx: ChatContext, a: Assessment): string {
  return ctx.courses.find((c) => c.id === a.courseId)?.code ?? "";
}

function intensityWord(i: WeekLoad["intensity"]): string {
  return (["calm", "normal", "busy", "a crunch week"] as const)[i];
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function localISODate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT_DAYS = ["Su", "M", "Tu", "W", "Th", "F", "Sa"];

function weekdayName(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return DAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function shortDay(n: number): string {
  return SHORT_DAYS[n] ?? String(n);
}
