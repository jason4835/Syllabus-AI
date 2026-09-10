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
  if (shared.length === 0) return 0;

  // "Problem Sets" -> "Problem Set 4": the category names the whole series.
  const stem = singularStem(category);
  let s = stem && title.startsWith(stem) ? 50 : shared.length * 10;

  // A category naming the item's kind ("Modeling Project" for a project)
  // outranks one that merely shares a word ("Final Exam" vs "Project final
  // report", which collide on "final").
  const kindWords = KIND_WORDS[a.kind];
  if (catTokens.some((t) => kindWords.includes(t))) s += 25;

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
): T[] {
  if (gradeWeights.length === 0 || assessments.length === 0) return assessments;

  // Which assessments picked which category.
  const claimed = new Map<number, number[]>();

  assessments.forEach((a, index) => {
    // An extractor that already found a per-item weight knows better than we do.
    if (a.weightPercent !== null) return;

    let bestScore = 0;
    let bestCategory = -1;
    gradeWeights.forEach((w, wi) => {
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

  const out = assessments.map((a) => ({ ...a }));
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
  const assessments = applyGradeWeights(parsed.assessments, parsed.course.gradeWeights, warnings);
  return { ...parsed, assessments, warnings };
}
