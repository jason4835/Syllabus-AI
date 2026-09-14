/**
 * Public entry point for syllabus parsing.
 *
 * Upload bytes in, `ParsedSyllabus` out. The contract callers depend on:
 *
 *   - It throws ONLY when the input is unreadable (empty, not a PDF, encrypted,
 *     scanned with no text layer). Those errors carry end-user wording.
 *   - A syllabus that is merely messy -- no weights, no dates, an unfamiliar
 *     layout -- always returns a valid `ParsedSyllabus` with warnings. The
 *     upload flow has a review screen; it does not have a "sorry" screen.
 *   - A failing OpenAI call is never fatal. We fall back to the deterministic
 *     parser and say so in the warnings, because degraded output the student
 *     can fix beats an error they cannot.
 *
 * Server-only.
 */

import type { ParsedSyllabus } from "../types";
import { extractWithAi, isConfigured } from "./extract";
import { fallbackParse } from "./fallback";
import { extractText } from "./pdf";

/**
 * Whether an upload will be parsed by the model or by the heuristic parser.
 *
 * `/api/config` reports this to the UI so demo mode can be labelled honestly
 * instead of letting the user assume they got AI extraction.
 */
export function isAiParsingAvailable(): boolean {
  return isConfigured();
}

/** Short, non-leaky description of why the AI path bailed, for the warning list. */
function describeFailure(err: unknown): string {
  if (err instanceof Error && err.message.trim().length > 0) {
    return err.message.replace(/\s+/g, " ").trim().slice(0, 220);
  }
  return "the AI extractor failed";
}

/**
 * Parses an uploaded syllabus (PDF or .txt) into the shared domain shape.
 *
 * @param buf Raw file bytes.
 * @param filename Original filename -- the `.txt` suffix selects the plain-text path.
 * @throws Error with user-facing wording when the file itself cannot be read.
 */
export interface ParseOptions {
  /**
   * Skip the model and use pattern matching, even when a key is configured.
   *
   * For input whose parse is not worth paying for. The sample semester is the
   * only caller: its three fixtures never change, so a model call would buy an
   * identical result every time at full price -- and because a fresh sandbox is
   * created for every visitor, that price was being paid per visitor.
   */
  offline?: boolean;
}

export async function parseSyllabus(
  buf: Buffer,
  filename: string,
  opts: ParseOptions = {},
): Promise<ParsedSyllabus> {
  // Unreadable input is the one failure the user can act on, so it stays fatal.
  const text = await extractText(buf, filename);
  const parsed = collapseInventedSeries(await parseFromText(text, opts));
  // Decided from the document, once, for every extraction path -- see the
  // field's own comment for why the grading rows cannot be trusted with this.
  const rankBasedExamWeights = RANK_BASED_EXAMS.test(text);
  return { ...relabelRankRows(parsed, rankBasedExamWeights), rankBasedExamWeights };
}

/**
 * "Exam 1 5%, Exam 2 25%, Exam 3 25%, Exam 4 45%" from a syllabus that says
 * the highest score counts 45% and the lowest 5%. The percentages are the
 * document's own; only the labels are wrong, and they are wrong in a way that
 * tells a student their first exam barely matters. When the document says rank
 * and the rows say exam numbers, the rows are relabelled by rank -- highest
 * first -- with the numbers untouched and a warning saying so. Rows already
 * worded by rank are left alone; so is everything when the document does not
 * say rank at all.
 */
export function relabelRankRows(parsed: ParsedSyllabus, rankBased: boolean): ParsedSyllabus {
  if (!rankBased) return parsed;
  const rows = parsed.course.gradeWeights;
  if (rows.some((w) => /\b(highest|lowest)\b/i.test(w.category))) return parsed;
  const numbered = rows
    .map((w, i) => (/^(?:exam|test|midterm)s?\s*#?\d{1,2}$/i.test(w.category.trim()) ? i : -1))
    .filter((i) => i >= 0);
  if (numbered.length < 2) return parsed;

  const byWeight = numbered.slice().sort((a, b) => rows[b].weightPercent - rows[a].weightPercent);
  const ordinal = ["highest", "second highest", "third highest", "fourth highest", "fifth highest", "sixth highest"];
  const label = (rank: number) =>
    rank === byWeight.length - 1 ? "Exam with lowest grade" : `Exam with ${ordinal[rank] ?? `${rank + 1}th highest`} grade`;
  const gradeWeights = rows.map((w, i) => {
    const rank = byWeight.indexOf(i);
    return rank < 0 ? w : { ...w, category: label(rank) };
  });
  return {
    ...parsed,
    course: { ...parsed.course, gradeWeights },
    warnings: [
      ...parsed.warnings,
      "The grading table listed exam percentages by exam number, but this syllabus assigns them by rank of score (the highest score counts most). The rows have been relabelled by rank; the percentages are unchanged.",
    ],
  };
}

/**
 * "Quiz 1" through "Quiz 10", none of them dated, from a syllabus that says
 * "weekly quizzes" and never says how many. The number is the invention: the
 * document supports one undated fact -- there are quizzes -- and the extractor
 * turned it into ten. It did that in one run out of three on the same file,
 * after being told in two different places not to, so this is enforced here
 * rather than asked for again.
 *
 * Only undated items are touched. A dated series is the extractor doing its
 * job; a lone undated "Exam 1 (TBD)" is a real item with a real number. Two or
 * more undated titles that differ only by a trailing number are the pattern.
 */
export function collapseInventedSeries(parsed: ParsedSyllabus): ParsedSyllabus {
  const stemOf = (title: string) => title.replace(/\s*(?:#|no\.?\s*)?\d{1,3}\s*$/i, "").trim();
  const groups = new Map<string, number[]>();
  parsed.assessments.forEach((a, i) => {
    if (a.dueDate !== null) return;
    const stem = stemOf(a.title);
    if (!stem || stem === a.title.trim()) return;
    const key = `${a.kind}|${stem.toLowerCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });

  const drop = new Set<number>();
  const warnings = [...parsed.warnings];
  const assessments = parsed.assessments.map((a) => ({ ...a }));
  // A lone retitle drops nothing, so "nothing dropped" is not "nothing changed".
  let changed = false;
  for (const indices of groups.values()) {
    const first = assessments[indices[0]];
    if (indices.length < 2) {
      // One undated "Quiz 1" is the same invention at n=1, but only when the
      // grading table names the series ("Quizzes") and nothing dated shares
      // the stem -- a dated "Quiz 2" would make "Quiz 1" a real first quiz.
      // Exams are exempt: "Exam 1 (TBD)" is a specific exam by convention.
      const stem = stemOf(first.title);
      const siblings = parsed.assessments.some((a) => a !== parsed.assessments[indices[0]] && stemOf(a.title).toLowerCase() === stem.toLowerCase());
      const row = first.kind !== "exam" && !siblings
        ? parsed.course.gradeWeights.find((w) => {
            const c = w.category.toLowerCase().replace(/\([^)]*\)/g, "").trim();
            return c.startsWith(stem.toLowerCase()) && c !== stem.toLowerCase() && !/\d\s*$/.test(c);
          })
        : undefined;
      if (!row) continue;
      const title = row.category.replace(/\s*\([^)]*\)\s*/g, " ").trim();
      warnings.push(`"${first.title}" has no date and the syllabus lists no individual ${stem.toLowerCase()}s, so it is shown as the category "${title}".`);
      first.title = title;
      first.weightPercent = null;
      changed = true;
      continue;
    }
    const stem = stemOf(first.title);
    // Name it the way the grading table does when a row plainly names this
    // series ("Quizzes" for "Quiz", "Problem Sets" for "Problem Set"); else a
    // plain plural, which is still a category and no longer a count.
    const row = parsed.course.gradeWeights.find((w) =>
      w.category.toLowerCase().replace(/\([^)]*\)/g, "").trim().startsWith(stem.toLowerCase()),
    );
    const title = row ? row.category.replace(/\s*\([^)]*\)\s*/g, " ").trim() : /(s|x|z|ch|sh)$/i.test(stem) ? `${stem}es` : `${stem}s`;
    first.title = title;
    // The join assigns the category's weight to the one item that stands for it.
    first.weightPercent = null;
    first.confidence = Math.min(...indices.map((i) => assessments[i].confidence));
    for (const i of indices.slice(1)) drop.add(i);
    changed = true;
    warnings.push(
      `${indices.length} undated "${stem}" items were listed but the syllabus gives no dates and no count, so they are shown as one entry, "${title}", until the dates are known.`,
    );
  }
  if (!changed) return parsed;
  return { ...parsed, assessments: assessments.filter((_, i) => !drop.has(i)), warnings };
}

/**
 * "Exam with the highest grade", "the highest score will receive 45%", "your
 * lowest exam is dropped": exam weight assigned by rank rather than by exam.
 * Either order, within one sentence, so "the highest grade in last year's
 * class" three paragraphs from any exam does not trip it.
 */
const RANK_BASED_EXAMS =
  /\b(?:exams?|tests?|midterms?)\b[^.\n]{0,80}\b(?:highest|lowest)\b|\b(?:highest|lowest)\b[^.\n]{0,80}\b(?:exams?|tests?|scores?|grades?)\b/i;

async function parseFromText(text: string, opts: ParseOptions): Promise<ParsedSyllabus> {

  if (opts.offline) {
    return fallbackParse(text, { reason: "pattern matching (the model was not asked)" });
  }

  if (!isConfigured()) {
    return fallbackParse(text, {
      reason: "demo mode -- no OpenAI API key is configured",
    });
  }

  try {
    const result = await extractWithAi(text);

    // A model that returns a course but no graded items has effectively failed,
    // even though it succeeded. The heuristic pass usually finds the schedule
    // table it skipped, so prefer that rather than handing back an empty term.
    if (result.assessments.length === 0) {
      const heuristic = fallbackParse(text, {
        reason: "the AI extractor returned no assignments, so pattern matching was used instead",
      });
      if (heuristic.assessments.length > 0) {
        return {
          ...heuristic,
          // The AI's read of the course header and policies is still the better
          // one; only the schedule is being replaced.
          course: {
            ...result.course,
            gradeWeights:
              result.course.gradeWeights.length > 0
                ? result.course.gradeWeights
                : heuristic.course.gradeWeights,
            policies:
              result.course.policies.length > 0 ? result.course.policies : heuristic.course.policies,
          },
          warnings: [...result.warnings, ...heuristic.warnings],
        };
      }
      return result;
    }

    return result;
  } catch (err) {
    return fallbackParse(text, { reason: describeFailure(err) });
  }
}
