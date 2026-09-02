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
 * Assigns each assessment to its single best-matching category, then splits
 * every category's weight across the assessments that chose it.
 */
export function applyGradeWeights<T extends { title: string; kind: Assessment["kind"]; weightPercent: number | null }>(
  assessments: T[],
  gradeWeights: GradeWeight[],
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
    const weight = gradeWeights[categoryIndex]?.weightPercent;
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) continue;
    const share = weight / indices.length;
    // Two decimals: 24% over seven problem sets is 3.43 each, and a stored
    // 3.4285714... reads like false precision everywhere it is displayed.
    const rounded = Math.round(share * 100) / 100;
    for (const i of indices) out[i].weightPercent = rounded;
  }
  return out;
}

/** Applies the join to a freshly parsed syllabus, before it is persisted. */
export function attachWeights(parsed: ParsedSyllabus): ParsedSyllabus {
  return {
    ...parsed,
    assessments: applyGradeWeights(parsed.assessments, parsed.course.gradeWeights),
  };
}
