/**
 * Upload bytes -> plain text.
 *
 * This is the only place in the pipeline that touches a file format. Everything
 * downstream works on a string, so a future .docx or OCR path only has to land
 * here. Errors thrown from this module are shown verbatim to the user, so they
 * are written as advice ("try a text PDF or paste it") rather than as
 * diagnostics -- an unreadable upload is the one failure the user can actually
 * fix themselves.
 *
 * Server-only: it reaches into Node's module system and must never be bundled
 * for the browser.
 */

import pdfParse from "pdf-parse/lib/pdf-parse.js";

/** The slice of pdf-parse's result we actually consume. */
interface PdfParseResult {
  text: string;
  numpages: number;
}

/**
 * A PDF with a text layer but essentially no words is a scan. The threshold is
 * deliberately low: a legitimate one-page syllabus fragment still clears it,
 * while a scanned page yielding only stray ligature noise does not.
 */
const MIN_MEANINGFUL_CHARS = 40;

/**
 * pdf-parse@1's package entry (index.js) checks `module.parent` and, when it is
 * falsy, synchronously reads `./test/data/05-versions-space.pdf` off disk --
 * which throws in any bundled or serverless deployment. `lib/pdf-parse.js` is
 * the same parser with none of that, so we import it directly.
 *
 * This is a plain static import on purpose. `pdf-parse` is listed in
 * `serverExternalPackages`, so Next leaves it as a runtime require and Node
 * resolves it normally. An earlier version reached for `createRequire` to dodge
 * the missing subpath types; webpack cannot statically analyse that call, and
 * the production build silently got a require that could not resolve anything
 * -- every PDF upload failed under `next start` while dev worked fine. The
 * types now come from pdf-parse.d.ts instead.
 */

/** pdf.js signals a locked document by exception name, not by error code. */
function looksEncrypted(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = String((err as { name?: unknown }).name ?? "");
  const message = String((err as { message?: unknown }).message ?? "");
  return name === "PasswordException" || /password|encrypt/i.test(message);
}

/** True when the buffer starts with a PDF header, allowing for junk bytes some exporters prepend. */
function hasPdfHeader(buf: Buffer): boolean {
  return buf.subarray(0, 1024).includes("%PDF-");
}

/**
 * Collapses the layout artifacts pdf-parse leaves behind.
 *
 * We keep line structure -- the fallback parser reads schedules line by line,
 * and the AI extractor quotes lines back as `sourceText` -- but flatten the
 * runs of blank lines and trailing spaces that come from two-column layouts.
 */
/**
 * How many lines must share the exact maximum width before we believe the
 * document was hard-wrapped. Prose that happens to reach the widest column once
 * or twice is normal; a dozen lines stopping on the same column is a renderer.
 */
const MIN_HARD_WRAPPED_LINES = 4;

/**
 * Rejoins words that a fixed-width text renderer split across two lines.
 *
 * Printing a syllabus to PDF (cupsfilter, lpr, most "save as PDF" paths) wraps
 * at a fixed column and cuts mid-word rather than at a space, so a schedule row
 * arrives as:
 *
 *     "Week 7  | Oct 5 - Oct 9 | Lagrange multipliers (14.7-14.8) | Mid"
 *     "term Exam 1, Wed, Oct 7"
 *
 * Left alone the continuation reads as its own graded item called "term Exam
 * 1": a duplicate, with a mangled title, whose kind gets inferred from whatever
 * words survived the cut. Both consumers of this text -- the fallback parser
 * and the prompt we send the model -- are better off never seeing the break, so
 * it is repaired here, where the artifact is introduced.
 *
 * Two conditions must hold before we touch anything:
 *   - the document really is hard-wrapped, i.e. several lines stop on exactly
 *     the same column; and
 *   - the break is mid-word: the previous line ends on a word character and the
 *     continuation STARTS LOWERCASE. A continuation beginning with a capital is
 *     a new sentence or table cell that merely happened to land at the wrap
 *     column, so it stays on its own line.
 *
 * A .txt syllabus wrapped by a human at word boundaries fails the first test --
 * its longest line is unique -- and passes through untouched.
 */
function unwrapHardBreaks(text: string): string {
  const lines = text.split("\n");
  const wrapWidth = lines.reduce((max, line) => Math.max(max, line.length), 0);
  if (wrapWidth < 40 || wrapWidth > 200) return text;
  if (lines.filter((line) => line.length === wrapWidth).length < MIN_HARD_WRAPPED_LINES) return text;

  const out: string[] = [];
  let previousWasAtWrapWidth = false;
  for (const line of lines) {
    const previous = out[out.length - 1];
    const isContinuation =
      previousWasAtWrapWidth &&
      previous !== undefined &&
      /[A-Za-z0-9]$/.test(previous) &&
      /^[a-z0-9]/.test(line);

    if (isContinuation) out[out.length - 1] = previous + line;
    else out.push(line);

    // Measured on the SOURCE line, so a word split across three lines still
    // reassembles even though the accumulated line now exceeds the wrap width.
    previousWasAtWrapWidth = line.length === wrapWidth;
  }
  return out.join("\n");
}

function tidy(text: string): string {
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    // Soft hyphens and the hyphen-newline pairs PDFs use to break words.
    .replace(/­/g, "")
    // Trailing padding must go before widths are measured, or every line in a
    // space-padded render looks like it reached the wrap column.
    .replace(/[ \t]+\n/g, "\n");

  return unwrapHardBreaks(normalized)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extracts plain text from an uploaded syllabus.
 *
 * `.txt` uploads skip the PDF path entirely -- they are what demo mode and the
 * fixture use, and decoding them as UTF-8 is both cheaper and lossless.
 *
 * @throws Error with a message written for the end user.
 */
export async function extractText(buf: Buffer, filename: string): Promise<string> {
  if (!buf || buf.length === 0) {
    throw new Error("That file came through empty. Please re-upload the syllabus.");
  }

  const name = (filename ?? "").toLowerCase();

  if (name.endsWith(".txt") || name.endsWith(".text") || name.endsWith(".md")) {
    const text = tidy(buf.toString("utf8"));
    if (text.length < MIN_MEANINGFUL_CHARS) {
      throw new Error("That text file looks empty. Please paste or upload the full syllabus.");
    }
    return text;
  }

  if (!hasPdfHeader(buf)) {
    // A .doc/.docx/.pages upload lands here, and so does a PDF that got
    // truncated in transit. Naming both possibilities saves a support round-trip.
    throw new Error(
      "That file doesn't look like a PDF. Upload a PDF or a .txt file, or paste the syllabus text.",
    );
  }

  let result: PdfParseResult;
  try {
    result = await pdfParse(buf);
  } catch (err) {
    // The user-facing messages below are deliberately vague; keep the real
    // cause in the server log so a broken dependency is diagnosable.
    console.error("[parse/pdf] pdf-parse failed:", err);
    if (looksEncrypted(err)) {
      throw new Error(
        "This PDF is password-protected, so we can't read it. Remove the password (or print it to a new PDF) and try again.",
      );
    }
    throw new Error(
      "We couldn't read that PDF -- it may be damaged. Try re-exporting it, or paste the syllabus text instead.",
    );
  }

  const text = tidy(result.text ?? "");
  if (text.replace(/\s/g, "").length < MIN_MEANINGFUL_CHARS) {
    throw new Error(
      "This PDF looks scanned -- no text layer found. Try a text PDF or paste the syllabus.",
    );
  }

  return text;
}
