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
  const parsed = capWhenTentative(
    reconcileNoClass(
      dropMeetingsWithUnstatedTimes(
        warnWhenWeeksHaveNoAnchor(mergePlaceholdersPerRow(collapseInventedSeries(await parseFromText(text, opts)))),
        text,
      ),
    ),
    text,
  );
  // Decided from the document, once, for every extraction path -- see the
  // field's own comment for why the grading rows cannot be trusted with this.
  const rankBasedExamWeights = isRankBasedExamWeighting(text);
  return { ...relabelRankRows(parsed, rankBasedExamWeights, text), rankBasedExamWeights };
}

/**
 * The rank rows as the prose states them: "the highest score will receive
 * 45% of the weight, the second highest 25%, ... and the lowest 5%". Read from
 * the same two-sentence window the detector uses, so a drop policy can never
 * supply a row. Empty unless at least two ranks carry a percentage.
 */
export function rankRowsFromText(text: string): { category: string; weightPercent: number }[] {
  const sentences = text.split(/(?<=[.!?\n])\s+/);
  for (let i = 0; i < sentences.length; i++) {
    const window = `${sentences[i - 1] ?? ""} ${sentences[i]}`;
    if (!/\b(?:exams?|tests?|midterms?)\b/i.test(window) || /\bdrop/i.test(window)) continue;
    const found: { category: string; weightPercent: number }[] = [];
    const re = /\b(highest|second[\s-]?highest|third[\s-]?highest|fourth[\s-]?highest|lowest)\b[^.%\d]{0,60}?(\d{1,3})\s*%/gi;
    for (const m of sentences[i].matchAll(re)) {
      const rank = m[1].toLowerCase().replace(/[\s-]+/g, " ");
      found.push({ category: `Exam with ${rank} grade`, weightPercent: Number(m[2]) });
    }
    if (found.length >= 2) return found;
  }
  return [];
}

/**
 * Rank-based exam weighting, judged one sentence at a time: the sentence must
 * name an exam, test or midterm AND a rank word, and must not be a drop policy.
 * "Your lowest quiz grade is dropped" has "lowest" and "grade" and says nothing
 * about how exams are weighted; a document-wide regex fired on it.
 */
export function isRankBasedExamWeighting(text: string): boolean {
  // Two consecutive sentences, because the exam and the rank are routinely a
  // sentence apart: "...four exams that determine 100% of the grade. The
  // highest score will receive 45%." Judged one sentence at a time, that real
  // syllabus stopped being detected -- the unit test caught it before it
  // shipped. The drop-policy exclusion applies to the same window.
  const sentences = text.split(/(?<=[.!?\n])\s+/);
  return sentences.some((sentence, i) => {
    const window = `${sentences[i - 1] ?? ""} ${sentence}`;
    return (
      /\b(?:exams?|tests?|midterms?)\b/i.test(window) &&
      /\b(?:highest|lowest|second[\s-]?highest|third[\s-]?highest)\b/i.test(sentence) &&
      !/\bdrop/i.test(window)
    );
  });
}

/**
 * Every time the document states, as HH:MM, in both the 12-hour and 24-hour
 * reading of any bare number so a real "3:25 - 4:50 p.m." can never be
 * rejected. Only a time whose digits appear nowhere at all is caught -- which
 * is exactly the fabricated one, since an invented time has no source.
 */
function statedTimes(text: string): Set<string> {
  const out = new Set<string>();
  const re = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/gi;
  for (const m of text.matchAll(re)) {
    const h = Number(m[1]);
    const mm = m[2] ?? "00";
    if (h > 23 || Number(mm) > 59) continue;
    const pm = m[3] ? /p/i.test(m[3]) : null;
    const add = (hour: number) => out.add(`${String(hour).padStart(2, "0")}:${mm}`);
    if (pm === true) add(h === 12 ? 12 : h + 12);
    else if (pm === false) add(h === 12 ? 0 : h);
    else {
      add(h);
      if (h < 12) add(h + 12);
    }
  }
  return out;
}

/**
 * A meeting whose start or end time the document never states is dropped.
 *
 * The schema requires a time on every meeting, so a class the document gives
 * days for but no time can only be invented or omitted, and the model invented:
 * a Tuesday/Friday lecture at 10:00-11:15, the 10:00 lifted from the office
 * hours line and the 75 minutes from nowhere, became twenty-six calendar events
 * colliding with the real office hours on the same days. Omission is the honest
 * answer, said out loud, with what to do about it.
 */
export function dropMeetingsWithUnstatedTimes(parsed: ParsedSyllabus, text: string): ParsedSyllabus {
  // Only the START is checked. A recitation table that lists "8:00 Fri" states
  // a real meeting whose end the model infers, and requiring the inferred end
  // to appear in the text threw six of nine real recitations away. A start
  // that appears nowhere is the fabrication; an end that appears nowhere is a
  // duration guess, which is a known and tolerable thing.
  //
  // And where the start appears matters. Told not to invent a time, the model
  // relabelled the office hours as the lecture instead -- four "lectures" in
  // the professor's office. So a start that is stated ONLY on lines about
  // office hours does not support a class; it supports office hours.
  const seen = new Map<string, { anywhere: boolean; outsideOfficeHours: boolean }>();
  for (const line of text.split(/\r?\n/)) {
    const officeHours = /office\s*hours|student\s*hours|\bOH\b/i.test(line);
    for (const t of statedTimes(line)) {
      const rec = seen.get(t) ?? { anywhere: false, outsideOfficeHours: false };
      rec.anywhere = true;
      if (!officeHours) rec.outsideOfficeHours = true;
      seen.set(t, rec);
    }
  }
  const keep: typeof parsed.course.meetingTimes = [];
  const warnings = [...parsed.warnings];
  const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  for (const m of parsed.course.meetingTimes) {
    const rec = seen.get(m.startTime);
    const supported = rec?.anywhere === true && (m.kind === "office_hours" || rec.outsideOfficeHours);
    if (supported) {
      keep.push(m);
      continue;
    }
    const days = m.daysOfWeek.map((d) => DAY[d] ?? "?").join("/");
    warnings.push(
      rec?.anywhere
        ? `A ${m.kind.replace("_", " ")} on ${days} at ${m.startTime} was left off: that time appears in the syllabus only as office hours, and the class time itself is not stated. Add the class time on the course card.`
        : `A ${m.kind.replace("_", " ")} on ${days} was left off: the syllabus names the days but not a time this app could find in it (${m.startTime} appears nowhere in the document). Add the meeting time on the course card.`,
    );
  }
  if (keep.length === parsed.course.meetingTimes.length) return parsed;
  return { ...parsed, course: { ...parsed.course, meetingTimes: keep }, warnings };
}

/**
 * Two undated placeholders for one grading category are one category.
 *
 * "Quizzes" and "Weekly Quizes", both undated, both pointing at the one
 * "Quizzes 12%" row, each carrying half its weight: the extractor described a
 * category twice. The rule that keeps six "End of Week N" homeworks apart is
 * right -- those are anchored -- so the line is drawn there: an undated item
 * with no week or date anchor in its evidence is a placeholder, and
 * placeholders that map to the same grading row merge into that row's name.
 * Exams are never touched, and neither is anything anchored.
 */
export function mergePlaceholdersPerRow(parsed: ParsedSyllabus): ParsedSyllabus {
  const anchored = (a: { sourceText: string | null; notes: string | null }) =>
    /\bweek\s*\d|end of (?:the )?week|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d|\d{1,2}\/\d{1,2}|\b\d{1,2}(?:st|nd|rd|th)\b/i.test(
      `${a.sourceText ?? ""} ${a.notes ?? ""}`,
    );
  const norm = (v: string) => v.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const rows = parsed.course.gradeWeights.map((w) => norm(w.category));
  const rowFor = (title: string): number => {
    const t = norm(title);
    const words = t.split(" ").filter((x) => x.length >= 4);
    return rows.findIndex((r) => r === t || t.startsWith(r) || r.startsWith(t) || words.some((x) => r.includes(x.replace(/e?s$/, ""))));
  };
  const groups = new Map<number, number[]>();
  parsed.assessments.forEach((a, i) => {
    if (a.dueDate !== null || a.kind === "exam" || anchored(a)) return;
    const r = rowFor(a.title);
    if (r < 0) return;
    groups.set(r, [...(groups.get(r) ?? []), i]);
  });
  const drop = new Set<number>();
  const assessments = parsed.assessments.map((a) => ({ ...a }));
  const warnings = [...parsed.warnings];
  for (const [r, indices] of groups) {
    if (indices.length < 2) continue;
    const first = assessments[indices[0]];
    const title = parsed.course.gradeWeights[r].category.replace(/\s*\([^)]*\)\s*/g, " ").trim();
    const merged = indices.map((i) => assessments[i].title);
    first.title = title;
    first.weightPercent = null;
    first.notes = [...new Set(indices.map((i) => assessments[i].notes).filter(Boolean))].join(" ") || first.notes;
    for (const i of indices.slice(1)) drop.add(i);
    warnings.push(`${merged.map((m) => `"${m}"`).join(" and ")} describe the same graded category with no dates, so they are shown as one entry, "${title}".`);
  }
  if (drop.size === 0) return parsed;
  return { ...parsed, assessments: assessments.filter((_, i) => !drop.has(i)), warnings };
}

/**
 * Two things a no-class period must never do: run past the end of the term,
 * and cover the day of a dated exam. One parse asserted "Final Exam Dec 14"
 * and "no class Dec 14" together, with the period ending a day after endDate.
 * A period that starts on an exam's day starts the day after instead; one
 * that ends on it ends the day before; one left with nothing in it goes.
 */
export function reconcileNoClass(parsed: ParsedSyllabus): ParsedSyllabus {
  const examDays = new Set(parsed.assessments.filter((a) => a.kind === "exam" && a.dueDate).map((a) => a.dueDate as string));
  const endDate = parsed.course.endDate;
  const shift = (iso: string, days: number) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  let changed = false;
  const noClass = [];
  for (const period of parsed.course.noClass ?? []) {
    let { start, end } = period;
    if (endDate && end > endDate) { end = endDate; changed = true; }
    while (start <= end && examDays.has(start)) { start = shift(start, 1); changed = true; }
    while (end >= start && examDays.has(end)) { end = shift(end, -1); changed = true; }
    if (start > end) { changed = true; continue; }
    noClass.push({ ...period, start, end });
  }
  return changed ? { ...parsed, course: { ...parsed.course, noClass } } : parsed;
}

/**
 * A document that calls its own schedule tentative has told the student its
 * dates may move. A 0.95 next to each of them says the opposite. Capped at
 * 0.8 -- still above the review threshold, so nothing is flagged that the
 * document itself did not flag -- with one warning that repeats the document.
 */
export function capWhenTentative(parsed: ParsedSyllabus, text: string): ParsedSyllabus {
  if (!/\btentative\b/i.test(text)) return parsed;
  const dated = parsed.assessments.filter((a) => a.dueDate && a.confidence > 0.8);
  if (dated.length === 0) return parsed;
  return {
    ...parsed,
    assessments: parsed.assessments.map((a) => (a.dueDate && a.confidence > 0.8 ? { ...a, confidence: 0.8 } : a)),
    warnings: [
      ...parsed.warnings,
      "The syllabus calls its schedule tentative, so these dates may move. Check announcements before relying on any of them.",
    ],
  };
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
export function relabelRankRows(parsed: ParsedSyllabus, rankBased: boolean, text = ""): ParsedSyllabus {
  if (!rankBased) return parsed;
  const rows = parsed.course.gradeWeights;
  if (rows.some((w) => /\b(highest|lowest)\b/i.test(w.category))) return parsed;
  const numbered = rows
    .map((w, i) => (/^(?:exam|test|midterm)s?\s*#?\d{1,2}$/i.test(w.category.trim()) ? i : -1))
    .filter((i) => i >= 0);
  if (numbered.length < 2) {
    // No breakdown in the rows at all -- one run summarised four rank rows
    // into "Exams 100%". The breakdown is in the sentence; take it from there,
    // replacing only a lone summary exam row and keeping every other row.
    const fromText = rankRowsFromText(text);
    if (fromText.length < 2) return parsed;
    const summary = rows.findIndex((w) => /^(?:exams?|tests?|midterms?)$/i.test(w.category.trim()));
    const kept = rows.filter((_, i) => i !== summary);
    return {
      ...parsed,
      course: { ...parsed.course, gradeWeights: [...fromText, ...kept] },
      warnings: [
        ...parsed.warnings,
        "The grading table did not break the exam weights down, but the syllabus assigns them by rank of score; the exam rows were rebuilt from that sentence, with its own percentages.",
      ],
    };
  }

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
    // An exam is a specific thing by convention -- "Exam 1" and "Exam 2" are two
    // sittings whether or not the document dates them. This once merged a
    // course's two midterms into one item called "Exam # 1 and 2".
    if (a.kind === "exam") return;
    const stem = stemOf(a.title);
    if (!stem || stem === a.title.trim()) return;
    const key = `${a.kind}|${stem.toLowerCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });

  // The whole judgement: numbered items are an invention only when nothing but
  // the number tells them apart. Six homework sets with six different "End of
  // Week N" lines are six real deadlines that merely lack a term anchor, and
  // folding them into one destroyed five. Distinct evidence is distinct items.
  const indistinguishable = (indices: number[]) => {
    const norm = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const src = new Set(indices.map((i) => norm(parsed.assessments[i].sourceText)));
    const notes = new Set(indices.map((i) => norm(parsed.assessments[i].notes)));
    return src.size <= 1 && notes.size <= 1;
  };

  const drop = new Set<number>();
  const warnings = [...parsed.warnings];
  const assessments = parsed.assessments.map((a) => ({ ...a }));
  // A lone retitle drops nothing, so "nothing dropped" is not "nothing changed".
  let changed = false;
  for (const indices of groups.values()) {
    const first = assessments[indices[0]];
    if (indices.length >= 2 && !indistinguishable(indices)) continue;
    if (indices.length < 2) {
      // One undated "Quiz 1" is the same invention at n=1, but only when the
      // grading table names the series ("Quizzes") and nothing dated shares
      // the stem -- a dated "Quiz 2" would make "Quiz 1" a real first quiz.
      // Exams are exempt: "Exam 1 (TBD)" is a specific exam by convention.
      const stem = stemOf(first.title);
      const siblings = parsed.assessments.some((a) => a !== parsed.assessments[indices[0]] && stemOf(a.title).toLowerCase() === stem.toLowerCase());
      const title = !siblings ? seriesRowTitle(stem, parsed.course.gradeWeights) : null;
      if (!title) continue;
      warnings.push(`"${first.title}" has no date and the syllabus lists no individual ${stem.toLowerCase()}s, so it is shown as the category "${title}".`);
      first.title = title;
      first.weightPercent = null;
      changed = true;
      continue;
    }
    const stem = stemOf(first.title);
    const title = seriesTitle(stem, parsed.course.gradeWeights);
    first.title = title;
    // The join assigns the category's weight to the one item that stands for it.
    first.weightPercent = null;
    first.confidence = Math.min(...indices.map((i) => assessments[i].confidence));
    for (const i of indices.slice(1)) drop.add(i);
    changed = true;
    warnings.push(
      `${indices.length} undated "${stem}" items were listed with no dates and nothing to tell them apart, so they are shown as one entry, "${title}", until the dates are known.`,
    );
  }
  if (!changed) return parsed;
  return { ...parsed, assessments: assessments.filter((_, i) => !drop.has(i)), warnings };
}

/** "HW" is "Homework"; "PS" is "Problem Set". The grading table rarely abbreviates. */
const STEM_SYNONYMS: Record<string, string> = { hw: "homework", hws: "homework", ps: "problem set", psets: "problem set", pset: "problem set" };

/**
 * The grading row that names this series, or null. A row counts when its name
 * begins with the stem (or the stem's expansion), is longer than it, and does
 * not itself end in a number -- and is not a flattened table cell masquerading
 * as a name: "Exam # 1 and 2" is two exams read as one cell, and was once used
 * as the title of a merged item. A label containing a digit is not a category.
 */
function seriesRowTitle(stem: string, gradeWeights: { category: string }[]): string | null {
  const wants = [stem.toLowerCase(), STEM_SYNONYMS[stem.toLowerCase()] ?? ""].filter(Boolean);
  const row = gradeWeights.find((w) => {
    const c = w.category.toLowerCase().replace(/\([^)]*\)/g, "").trim();
    return wants.some((x) => c.startsWith(x) && c !== x) && !/\d/.test(c);
  });
  return row ? row.category.replace(/\s*\([^)]*\)\s*/g, " ").trim() : null;
}

/** The row's name when there is one; else a plain plural of the expanded stem. */
function seriesTitle(stem: string, gradeWeights: { category: string }[]): string {
  const fromRow = seriesRowTitle(stem, gradeWeights);
  if (fromRow) return fromRow;
  const expanded = STEM_SYNONYMS[stem.toLowerCase()];
  const base = expanded ? expanded.replace(/^./, (c) => c.toUpperCase()) : stem;
  return /(s|x|z|ch|sh)$/i.test(base) ? `${base}es` : `${base}s`;
}

/**
 * A syllabus that places its work by week number and never says when Week 1
 * begins produces a calendar with nothing on it. Without this the student sees
 * an empty term and a set of item-level notes and has no way to know the app
 * is not broken. One sentence at the course level says what is missing and
 * what to do about it.
 */
export function warnWhenWeeksHaveNoAnchor(parsed: ParsedSyllabus): ParsedSyllabus {
  if (parsed.course.startDate) return parsed;
  const weekly = parsed.assessments.filter(
    (a) => a.dueDate === null && /\bweek\s*\d{1,2}\b/i.test(`${a.sourceText ?? ""} ${a.notes ?? ""}`),
  );
  if (weekly.length === 0) return parsed;
  return {
    ...parsed,
    warnings: [
      ...parsed.warnings,
      `${weekly.length} item${weekly.length === 1 ? "" : "s"} are placed by week number ("Week 8") but the syllabus never says when Week 1 begins, so they have no dates. Get the term start date from your instructor or course calendar and add the dates from there.`,
    ],
  };
}


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
