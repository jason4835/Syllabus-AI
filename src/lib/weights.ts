import type { Assessment, GradeWeight, ParsedSyllabus } from "@/lib/types";

/**
 * Joins a syllabus's grading table onto its individual assessments.
 *
 * Syllabi state weights once, as a category table ("Problem Sets -- 24%,
 * Final Exam -- 22%"), while due dates live in a separate schedule. Extraction
 * faithfully reproduces that split, which leaves every assessment with a null
 * weight -- and a null weight makes the workload model treat a 22% final like a
 * 3% quiz. Re-joining the two here is what gives the heatmap its teeth.
 *
 * A category covering several items ("Problem Sets" over seven of them) has its
 * weight divided among them, because that is what the category means.
 *
 * How many is "them" is the trap. Dividing by the items we FOUND makes the
 * parser's own blind spots inflate the survivors: a "Problem Sets (10) — 30%"
 * category with one dated set gave that set 30% of the course, ten times its
 * real 3%, and the workload model then planned the semester around it. So when
 * the syllabus states the size of the category, that number wins over ours.
 */

/** Words that carry no signal when matching a category to a title. */
const STOPWORDS = new Set([
  "and", "or", "the", "a", "an", "of", "in", "on", "for", "to", "your", "all",
  "total", "each", "other", "misc", "miscellaneous",
]);

/** Category words that corroborate an assessment's `kind`. */
const KIND_WORDS: Record<Assessment["kind"], string[]> = {
  exam: ["exam", "exams", "midterm", "midterms", "final", "finals", "test", "tests"],
  quiz: ["quiz", "quizzes"],
  project: ["project", "projects"],
  assignment: ["assignment", "assignments", "homework", "problem", "problems", "set", "sets", "pset", "psets"],
  reading: ["reading", "readings", "response", "responses"],
  lab: ["lab", "labs", "laboratory"],
  presentation: ["presentation", "presentations", "talk", "talks"],
  other: [],
};

function normalize(s: string): string {
  return s
    .toLowerCase()
    // Drop parenthetical counts like "Problem Sets (7)" -- they describe the
    // category's size, not its name.
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  return normalize(s)
    .split(" ")
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/**
 * A grading row that assigns weight by score, not by item. "Exam with highest
 * grade 35%" is not a category any single exam belongs to until the grades are
 * in, so it can never be joined onto one -- doing so handed the final 35% in
 * one real syllabus and rewrote another's four exams as 45/25/25/5.
 */
const RANK_BASED_ROW = /\b(highest|second[\s-]?highest|third[\s-]?highest|lowest)\b/i;

/** "problem sets" -> "problem set", so it prefixes "problem set 3". */
function singularStem(s: string): string {
  const n = normalize(s);
  return n.endsWith("s") && !n.endsWith("ss") ? n.slice(0, -1) : n;
}

/**
 * How well a grading category describes an assessment. Higher wins; 0 means
 * "unrelated", which leaves the assessment unweighted rather than guessing.
 */
function score(category: string, a: Assessment): number {
  const cat = normalize(category);
  const title = normalize(a.title);
  if (!cat || !title) return 0;

  if (cat === title) return 100;

  const catTokens = tokens(category);
  const titleTokens = new Set(tokens(a.title));
  const shared = catTokens.filter((t) => titleTokens.has(t));
  // A bare number is not a shared word. "Quiz 1" and "Exam 1" have "1" in
  // common and nothing else, and that once joined a 12% quiz to a 25% exam
  // row. A number still counts when it rides alongside a real word -- "Exam 2"
  // against "Midterm Exam 2" -- which is what tells two exam rows apart.
  const meaningful = shared.some((t) => !/^\d+$/.test(t)) ? shared.length : 0;

  // A category naming the item's kind ("Quizzes" for a quiz, "Modeling
  // Project" for a project) is a match on its own, before any shared word:
  // "Quizzes" and "Quiz 1" share no token, because no stemmer here turns
  // "quizzes" into "quiz", and that left every quiz unweighted or worse.
  const kindWords = KIND_WORDS[a.kind];
  const namesKind = catTokens.some((t) => kindWords.includes(t));
  if (meaningful === 0 && !namesKind) return 0;

  // "Problem Sets" -> "Problem Set 4": the category names the whole series.
  const stem = singularStem(category);
  let s = stem && title.startsWith(stem) ? 50 : meaningful * 10;

  // ...and it outranks one that merely shares a word ("Final Exam" vs
  // "Project final report", which collide on "final").
  if (namesKind) s += 25;

  return s;
}

/**
 * How many items a category says it holds -- the "(10)" in "Problem Sets (10)".
 *
 * `normalize` deliberately strips it when MATCHING (it is not part of the
 * category's name), which is exactly why it has to be read here before the
 * split: it is the only statement of the category's real size we get.
 */
function statedItemCount(category: string): number | null {
  const m = /\((\d{1,3})\)/.exec(category);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 1 && n <= 200 ? n : null;
}

/**
 * Assigns each assessment to its single best-matching category, then splits
 * every category's weight across the assessments that chose it -- or across the
 * count the syllabus stated, when that is larger.
 *
 * `warnings` is optional and appended to: a split we had to correct is a fact
 * about the parse that the student should see.
 */
export function applyGradeWeights<T extends { title: string; kind: Assessment["kind"]; weightPercent: number | null }>(
  assessments: T[],
  gradeWeights: GradeWeight[],
  warnings?: string[],
  opts: { rankBasedExams?: boolean } = {},
): T[] {
  if (assessments.length === 0) return assessments;

  // Rank-based from the document itself, or from a row worded that way. Either
  // means no exam has a fixed weight, and this function is the last thing to
  // write one -- so it is where that has to be guaranteed, not merely asked for.
  const rowsSayRank = gradeWeights.some((w) => RANK_BASED_ROW.test(w.category));
  const rankBased = opts.rankBasedExams === true || rowsSayRank;
  // "Three tests, the highest counts most" beside "Final Exam 15%": the rank
  // rule governs the tests, and the final keeps the number written for it. An
  // exam whose own title is a non-rank grading row is outside the rank scheme.
  const ownRow = (a: { title: string }) =>
    gradeWeights.some((w) => !RANK_BASED_ROW.test(w.category) && normalize(w.category) === normalize(a.title));
  if (rankBased && warnings && assessments.some((a) => a.kind === "exam")) {
    // When the rows are worded by rank they are the reference. When the
    // document says rank but the rows came back as "Exam 1 5%", the rows are
    // the thing to distrust, and the warning must not send the student to them.
    const message = rowsSayRank
      ? "Some exams are weighted by rank (the highest score counts most), so those have no fixed percentage until grades exist and were left blank; an exam with its own row in the grading table keeps its stated weight."
      : "This syllabus weights some exams by rank (the highest score counts most), so those have no fixed percentage until grades exist and were left blank; an exam with its own row in the grading table keeps its stated weight. Rank-weighted rows are by rank of score, not by exam number -- check the syllabus for the exact rule.";
    if (!warnings.includes(message)) warnings.push(message);
  }
  if (gradeWeights.length === 0 && !rankBased) return assessments;

  // Which assessments picked which category.
  const claimed = new Map<number, number[]>();

  assessments.forEach((a, index) => {
    // An extractor that already found a per-item weight knows better than we do.
    if (a.weightPercent !== null) return;
    if (rankBased && a.kind === "exam" && !ownRow(a)) return;

    let bestScore = 0;
    let bestCategory = -1;
    gradeWeights.forEach((w, wi) => {
      if (RANK_BASED_ROW.test(w.category)) return; // never split a rank row across items
      const s = score(w.category, a as unknown as Assessment);
      if (s > bestScore) {
        bestScore = s;
        bestCategory = wi;
      }
    });
    if (bestCategory < 0) return;

    const list = claimed.get(bestCategory);
    if (list) list.push(index);
    else claimed.set(bestCategory, [index]);
  });

  const out = assessments.map((a) =>
    // Whatever the extractor put there: a rank-weighted exam has no number.
    rankBased && a.kind === "exam" && !ownRow(a) ? { ...a, weightPercent: null } : { ...a },
  );
  for (const [categoryIndex, indices] of claimed) {
    const category = gradeWeights[categoryIndex];
    const weight = category?.weightPercent;
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) continue;

    // The syllabus's own count wins when it is bigger than what we matched:
    // the missing items exist whether or not we found their due dates, and
    // handing their weight to the ones we did find is a fabricated number.
    const stated = statedItemCount(category.category);
    const divisor = stated !== null && stated > indices.length ? stated : indices.length;
    const share = weight / divisor;
    // Two decimals: 24% over seven problem sets is 3.43 each, and a stored
    // 3.4285714... reads like false precision everywhere it is displayed.
    const rounded = Math.round(share * 100) / 100;
    for (const i of indices) out[i].weightPercent = rounded;

    if (divisor !== indices.length && warnings) {
      const message = `"${category.category}" is worth ${weight}% across ${divisor} items, but only ${indices.length} of them ${
        indices.length === 1 ? "was" : "were"
      } found in the schedule. Each found item was weighted at ${rounded}%, not ${
        Math.round((weight / indices.length) * 100) / 100
      }% — the rest of that category is missing from your course.`;
      if (!warnings.includes(message)) warnings.push(message);
    }
  }
  return out;
}

/** Applies the join to a freshly parsed syllabus, before it is persisted. */
export function attachWeights(parsed: ParsedSyllabus): ParsedSyllabus {
  const warnings = [...parsed.warnings];
  const assessments = applyGradeWeights(parsed.assessments, parsed.course.gradeWeights, warnings, {
    rankBasedExams: parsed.rankBasedExamWeights === true,
  });
  return { ...parsed, assessments, warnings };
}
