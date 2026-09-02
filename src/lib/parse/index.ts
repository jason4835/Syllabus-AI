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
export async function parseSyllabus(buf: Buffer, filename: string): Promise<ParsedSyllabus> {
  // Unreadable input is the one failure the user can act on, so it stays fatal.
  const text = await extractText(buf, filename);

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
