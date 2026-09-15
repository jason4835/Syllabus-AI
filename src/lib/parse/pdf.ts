/**
 * Upload bytes -> plain text.
 *
 * This is the only place in the pipeline that touches a file format. Everything
 * downstream works on a string, so all three formats we accept -- PDF, Word
 * .docx, plain text -- are decided here, and a future OCR path lands here too.
 * Errors thrown from this module are shown verbatim to the user, so they are
 * written as advice ("try a text PDF or paste it") rather than as diagnostics --
 * an unreadable upload is the one failure the user can actually fix themselves.
 *
 * Server-only: it reaches into Node's module system and must never be bundled
 * for the browser.
 */

import { convertToHtml } from "mammoth";
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

/** See the check in `extractText` for why a ceiling exists at all. */
const MAX_PAGES = 60;

/**
 * The .docx analogue of `MAX_PAGES`, in the only unit we have.
 *
 * A Word file has no page count until something lays it out, and mammoth never
 * lays anything out, so the ceiling is on the text itself. 300k characters is
 * the same order of magnitude as a 60-page PDF and two and a half times
 * `MAX_CHARS_PER_CALL` in extract.ts -- anything this long would be chunked and
 * then truncated before the model ever saw the end of it, so accepting it would
 * buy the most expensive request the app can serve and still lose most of the
 * document. The bundled fixtures sit under 10k.
 */
const MAX_DOCX_CHARS = 300_000;

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
 * A .docx is a ZIP archive, and a ZIP announces itself in its first four bytes.
 *
 * No junk-byte tolerance here, unlike `hasPdfHeader`: a local file header has to
 * sit at offset zero for any unzipper to open the archive at all, so bytes in
 * front of it mean the file is broken however forgiving we are.
 */
function hasZipHeader(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

/**
 * The ZIP header alone proves nothing about Word: .pages, .odt, .epub, .key and
 * a plain zipped folder all begin with the same four bytes. What makes an
 * archive a Word document is the part that holds the body, and ZIP stores entry
 * names as uncompressed bytes in both the local headers and the central
 * directory -- so the name is findable as literal ASCII without unzipping
 * anything, which keeps this as cheap as the PDF header check.
 */
function containsWordDocumentPart(buf: Buffer): boolean {
  return buf.includes("word/document.xml");
}

/**
 * The OLE compound-file signature: what Word 97-2003 wrote, and what a `.doc`
 * still is today. Worth telling apart from "not a Word file at all", because the
 * student does have a Word document open in Word and the fix is one Save As.
 */
function hasLegacyDocHeader(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0;
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
 * The cell separator for a flattened table row.
 *
 * A pipe because that is what the rest of the pipeline already reads: the
 * fallback parser splits a schedule row on pipes and tabs and deliberately not
 * on runs of spaces (see `segments` in fallback.ts), and the AI extractor is
 * shown the same text. Spaces are padding; a pipe is a column boundary.
 */
const CELL_SEPARATOR = " | ";

/**
 * mammoth's HTML writer escapes exactly three characters in text -- `&`, `<`
 * and `>` -- plus `"` inside attributes, which are gone by the time this runs.
 * So decoding is a three-entry table rather than a full entity map. `&amp;` is
 * undone last, or "&amp;lt;" would decode twice and come out as a literal `<`.
 */
function decodeEscapes(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/**
 * One table cell's text, on one line.
 *
 * A cell's own paragraph and `<br>` breaks become spaces rather than newlines:
 * a professor who hard-wraps "Regression output, moving average, / and
 * exponential smoothing" inside one cell has written one field, and letting the
 * break through would turn the row it belongs to into two half-rows.
 */
function cellText(cell: string): string {
  return cell
    .replace(/^<t[dh]\b[^>]*>/i, "")
    .replace(/<\/t[dh]>$/i, "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(?:p|div|li|h[1-6])>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A table's rows, one line each, cells joined by `CELL_SEPARATOR`.
 *
 * Empty cells are kept as empty fields, which is the whole point of doing this
 * by row instead of by cell. BUA 2334's topic grid has a Week 8 row reading
 * "8 | Mid-Term Exam | | " -- two blank columns -- and dropping those blanks
 * would slide the next row's chapter number up into the midterm's row. The
 * header row is kept for the same reason a human keeps it: "End of Week 10"
 * means nothing until something overhead says "Due".
 *
 * A row whose every cell is empty carries nothing at all and is dropped; Word
 * leaves those behind as spacing.
 */
function tableRows(body: string): string {
  const rows = body.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? [];
  return rows
    .map((row) => (row.match(/<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/gi) ?? []).map(cellText))
    .filter((cells) => cells.some((cell) => cell.length > 0))
    .map((cells) => cells.join(CELL_SEPARATOR))
    .join("\n");
}

/**
 * mammoth's HTML -> the flat, line-per-thing text the extractors read.
 *
 * Tables are converted first, because their rows must survive as rows; what is
 * left is ordinary block markup, where every paragraph, heading, list item and
 * `<br>` is a line break. Tags go last so that a `&lt;` decoded from the
 * document's own text can never be mistaken for one.
 *
 * Nested tables -- a table inside a cell -- end the outer table early at the
 * first `</table>`, so the outer row structure past that point degrades to
 * plain lines. Word files that do this are rare, the text is still all there,
 * and the alternative is a real HTML parser for a shape no syllabus uses.
 */
function flattenHtml(html: string): string {
  const withoutImages = html
    // mammoth inlines every embedded picture as a base64 data URI. Nothing
    // downstream can read a picture, and a 15 MB upload's images would
    // otherwise be carried through this pipeline as ~20 MB of useless text.
    .replace(/<img\b[^>]*>/gi, "");

  const withTables = withoutImages.replace(
    /<table\b[^>]*>([\s\S]*?)<\/table>/gi,
    (_full, body: string) => `\n\n${tableRows(body)}\n\n`,
  );

  const withBreaks = withTables
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|h[1-6]|tr)>/gi, "\n");

  // Anchors lose their href, exactly as they do in a PDF: these syllabi write
  // the URL out as the link text, which is what survives.
  return decodeEscapes(withBreaks.replace(/<[^>]*>/g, ""));
}

/**
 * Word .docx -> plain text.
 *
 * Real syllabi arrive as Word documents at least as often as PDFs -- a professor
 * writes one in Word and posts the file they already have -- so refusing them
 * sent students off to find a PDF export of a document that never had one.
 *
 * We convert to HTML and flatten it rather than calling mammoth's
 * `extractRawText`, because raw text emits every table cell as its own
 * paragraph and a syllabus keeps its two most valuable facts in tables. On BUA
 * 2334 that cost the entire grading table -- five rows summing to exactly 100%
 * became ten disconnected lines and the parser found no weights at all -- and
 * turned a homework schedule into 28 lines where the only thing tying "HW 4" to
 * "End of Week 10" was cell order. Row-per-line recovers all five weights.
 *
 * Word's habit of padding a page with empty paragraphs shows up here as runs of
 * blank lines, and `tidy` -- the same one the PDF path uses -- collapses them,
 * so both formats hand the extractors text of the same shape.
 *
 * The three header checks are ordered by how useful the resulting advice is: a
 * legacy .doc gets told about Save As, anything that is not a ZIP gets told it
 * is not a Word file at all, and a ZIP without a Word body (a renamed .pages or
 * .odt) gets told which of its own exports to use instead.
 *
 * @throws Error with a message written for the end user.
 */
async function extractDocx(buf: Buffer): Promise<string> {
  if (hasLegacyDocHeader(buf)) {
    throw new Error(
      "That is an older Word .doc, not a .docx. Open it in Word, use Save As to make a .docx or a PDF, and upload that.",
    );
  }
  if (!hasZipHeader(buf)) {
    throw new Error(
      "That file doesn't look like a Word document. Upload the .docx Word itself saves, or paste the syllabus into a .txt file and upload that.",
    );
  }
  if (!containsWordDocumentPart(buf)) {
    throw new Error(
      "That file is a .docx by name only -- there is no Word document inside it. If it came from Pages or another word processor, export it as a PDF or a .docx and upload that.",
    );
  }

  let raw: string;
  try {
    const result = await convertToHtml({ buffer: buf });
    raw = flattenHtml(result.value ?? "");
  } catch (err) {
    // Same split as the PDF path: vague to the student, specific in the log.
    console.error("[parse/pdf] mammoth failed:", err);
    throw new Error(
      "We couldn’t read that Word file — it may be damaged. Try re-saving it from Word, or copy the text into a .txt file and upload that.",
    );
  }

  // Measured before `tidy`, which is the honest place: the cap exists to keep a
  // course reader out of the model, and a course reader is long before anyone
  // collapses its blank lines.
  if (raw.length > MAX_DOCX_CHARS) {
    throw new Error(
      `That document holds about ${Math.round(raw.length / 1000)}k characters of text, far more than a syllabus. Upload just the syllabus -- if it is part of a larger packet, save those pages on their own.`,
    );
  }

  const text = tidy(raw);
  if (text.replace(/\s/g, "").length < MIN_MEANINGFUL_CHARS) {
    throw new Error(
      "There is no text in that Word file to read — the syllabus may be a picture pasted into the page. If you can select the text in Word, copy it into a .txt file and upload that instead.",
    );
  }
  return text;
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

  if (name.endsWith(".docx")) return extractDocx(buf);

  if (!hasPdfHeader(buf)) {
    // A .doc or .pages upload lands here, so does a Word file someone renamed
    // to .pdf, and so does a PDF that got truncated in transit. Naming the
    // possibilities saves a support round-trip.
    throw new Error(
      "That file doesn't look like a PDF. Upload a PDF or a Word .docx, or paste the syllabus into a .txt file and upload that.",
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
      "We couldn’t read that PDF — it may be damaged. Try re-exporting it, or copy the text into a .txt file and upload that.",
    );
  }

  /**
   * A syllabus is not a book.
   *
   * `numpages` was declared on the result type and never read, so a 15 MB PDF
   * of anything at all went straight to the model and was parsed as four full
   * chunks -- the most expensive request the app can be made to serve, for
   * input nobody was ever going to get a semester out of. The cap is well past
   * any real syllabus (the longest bundled fixture is three pages, and a
   * heavily-appendixed graduate syllabus runs to twenty or thirty), so it costs
   * no honest upload anything, and the message says what to do about it.
   */
  if (result.numpages > MAX_PAGES) {
    throw new Error(
      `That PDF is ${result.numpages} pages. Upload just the syllabus -- if it is part of a larger packet, export those pages on their own.`,
    );
  }

  const text = tidy(result.text ?? "");
  if (text.replace(/\s/g, "").length < MIN_MEANINGFUL_CHARS) {
    throw new Error(
      "This PDF is a scan, so there is no text in it to read. If you can select the text in your PDF reader, copy it into a .txt file and upload that instead.",
    );
  }

  return text;
}
