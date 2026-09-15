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

import type { MeetingTime, ParsedSyllabus } from "../types";
import { UNKNOWN_TIME, meetingNeedsTime, weeklyRuleOf } from "../setup";
import { addDays, findDateSpans, isoDayOfWeek, normalizeDate, parseDaysOfWeek, parseTimeRange } from "./dates";
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
      inferMeetingDaysFromSchedule(
        dropAsynchronousDays(
          recoverOfficeHours(
            blankUnstatedMeetingTimes(
              warnWhenWeeksHaveNoAnchor(
                mergePlaceholdersPerRow(collapseInventedSeries(unnumberWeeklyRules(await parseFromText(text, opts)))),
              ),
              text,
            ),
            text,
          ),
          text,
        ),
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
  // A range shares its meridiem: "2-3 p.m." and "10-11:15 am" state BOTH
  // ends. Read those first, so the bare left end -- which the general pass
  // below would rightly refuse as a lone integer -- is credited with the
  // meridiem that governs it. Dropping the 2 p.m. office hours taught this.
  const range = /\b(\d{1,2})(?:[:.](\d{2}))?\s*[-–—]\s*(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/gi;
  for (const m of text.matchAll(range)) {
    const pm = /p/i.test(m[5]);
    for (const [h, mm] of [[Number(m[1]), m[2] ?? "00"], [Number(m[3]), m[4] ?? "00"]] as [number, string][]) {
      if (h > 23 || Number(mm) > 59) continue;
      const hour = pm ? (h === 12 ? 12 : h + 12) : h === 12 ? 0 : h;
      out.add(`${String(hour).padStart(2, "0")}:${mm}`);
    }
  }
  // A time has minutes or a meridiem. A bare integer is not one: "Chapter 10"
  // and "15 points" made 10:00 and 15:00 look stated, which let a borrowed
  // start time pass as the document's own. A class written "MW 10-11" now
  // fails this and becomes a question -- the honest outcome, since 10-11 does
  // not say AM or PM either.
  const re = /\b(\d{1,2})(?:[:.](\d{2})\s*(a\.?m\.?|p\.?m\.?)?|\s*(a\.?m\.?|p\.?m\.?))/gi;
  for (const m of text.matchAll(re)) {
    const h = Number(m[1]);
    const mm = m[2] ?? "00";
    const meridiem = m[3] ?? m[4];
    if (h > 23 || Number(mm) > 59) continue;
    const pm = meridiem ? /p/i.test(meridiem) : null;
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
 * A meeting whose start time the document never states keeps its days and
 * loses its time.
 *
 * The invention is real and worth stopping: a Tuesday/Friday lecture at
 * 10:00-11:15, the 10:00 lifted from the office hours line and the 75 minutes
 * from nowhere, became twenty-six calendar events colliding with the real
 * office hours on the same days. But dropping the meeting threw away the half
 * the document DID state -- that this class meets on Tuesday and Friday -- and
 * left a warning in its place, which is a sentence no student can act on
 * without retyping what the syllabus already said.
 *
 * So the time becomes `UNKNOWN_TIME` and the meeting stays. Blank means
 * unknown, every consumer skips it (`meetingNeedsTime`), and `setupQuestions`
 * turns it into the one question only the student can answer: what time does
 * this class meet? The question replaces the warning, which is why nothing is
 * pushed onto `warnings` here any more.
 *
 * Office hours are the exception, and still dropped: no question is asked
 * about them, so an office hour with no stated time is nothing but a row of
 * days the student cannot use.
 */
export function blankUnstatedMeetingTimes(parsed: ParsedSyllabus, text: string): ParsedSyllabus {
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
  const keep: MeetingTime[] = [];
  const warnings = [...parsed.warnings];
  const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  for (const m of parsed.course.meetingTimes) {
    const rec = seen.get(m.startTime);
    const supported = rec?.anywhere === true && (m.kind === "office_hours" || rec.outsideOfficeHours);
    if (supported) {
      keep.push(m);
      continue;
    }
    if (m.kind === "office_hours") {
      const days = m.daysOfWeek.map((d) => DAY[d] ?? "?").join("/");
      // The extractor's own time is quoted when it had one, because "10:00
      // appears nowhere" is checkable by the student against the document and
      // "no time was found" is not.
      const found = m.startTime ? ` (${m.startTime} appears nowhere in the document)` : "";
      warnings.push(
        `Office hours on ${days} were left off: the syllabus names the days but not a time this app could find in it${found}.`,
      );
      continue;
    }
    keep.push({ ...m, startTime: UNKNOWN_TIME, endTime: UNKNOWN_TIME });
  }
  const meetingTimes = mergeBlankTimeMeetings(keep);
  // Every surviving meeting is the object that came in, and nothing merged:
  // the parse is untouched, so hand back the same object.
  const unchanged =
    meetingTimes.length === parsed.course.meetingTimes.length &&
    meetingTimes.every((m, i) => m === parsed.course.meetingTimes[i]);
  if (unchanged) return parsed;
  return { ...parsed, course: { ...parsed.course, meetingTimes }, warnings };
}

/**
 * Blank-time meetings of one kind and section are one meeting.
 *
 * The four "lectures" the model made out of a Tuesday/Friday office-hours
 * block are one unstated class time, not four: two Tuesday slots and two
 * Friday slots, all of them the same relabelling mistake. Left apart they
 * become four identical questions about the same class, and answering all four
 * puts four overlapping series on the calendar. Merged on the union of their
 * days they are one question -- "when does the Tuesday/Friday lecture meet?"
 * -- whose answer is the whole truth about that class.
 *
 * Only blank-time meetings merge, and only within a kind and a section: two
 * stated sections of a lecture are two real meetings, and a lab is not a
 * lecture. The merged meeting keeps no `location`: a room that arrived on a row
 * whose time the document never stated came in with the fabrication, and in the
 * case that motivates all of this it is the professor's office -- a class in the
 * wrong room sends the student to the wrong building. `instructor` survives when
 * every merged row names the same person, which is the one fact the relabelling
 * did get right.
 */
function mergeBlankTimeMeetings(meetings: MeetingTime[]): MeetingTime[] {
  const groups = new Map<string, MeetingTime[]>();
  const out: MeetingTime[] = [];
  for (const m of meetings) {
    if (!meetingNeedsTime(m)) {
      out.push(m);
      continue;
    }
    const key = `${m.kind}|${m.section ?? ""}`;
    const group = groups.get(key);
    if (group) {
      group.push(m);
      continue;
    }
    groups.set(key, [m]);
    // A placeholder in the output, replaced below, so a merged meeting keeps
    // the position its first row had rather than being appended at the end.
    out.push(m);
  }
  return out.map((m) => {
    const group = meetingNeedsTime(m) ? groups.get(`${m.kind}|${m.section ?? ""}`) : undefined;
    if (!group || group.length < 2) return m;
    const instructors = new Set(group.map((g) => g.instructor));
    return {
      ...m,
      daysOfWeek: [...new Set(group.flatMap((g) => g.daysOfWeek))].sort((a, b) => a - b),
      instructor: instructors.size === 1 ? group[0].instructor : null,
      location: null,
    };
  });
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
  // An exact or prefix match first; a shared word only when exactly one row
  // shares it. "Mastering A&P Homework" and "Mastering A & P Quizzes" both
  // contain "mastering", and taking the first row that did once folded two
  // graded categories, 10% and 5%, into one entry.
  const rowFor = (title: string): number => {
    const t = norm(title);
    const exact = rows.findIndex((r) => r === t || t.startsWith(r) || r.startsWith(t));
    if (exact >= 0) return exact;
    const words = t.split(" ").filter((x) => x.length >= 4);
    const byWord = rows.map((r, i) => (words.some((x) => r.includes(x.replace(/e?s$/, ""))) ? i : -1)).filter((i) => i >= 0);
    return byWord.length === 1 ? byWord[0] : -1;
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
    // "After last day of classes", starting on the last day of classes: a
    // break that begins on or after the term's end removes nothing from the
    // calendar and reads as a mistake on the review screen.
    if (endDate && start >= endDate) { changed = true; continue; }
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
      warnings.push(`"${first.title}" has no date and the syllabus lists no individual ${plural(stem.toLowerCase())}, so it is shown as the category "${title}".`);
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

/** "quiz" -> "quizzes", "essay" -> "essays", "lab" -> "labs"; the warning that once said "quizs". */
function plural(word: string): string {
  if (/(?:s|x|z|ch|sh)$/i.test(word)) return word.endsWith("z") ? `${word}zes` : `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/**
 * A weekly rule is one item, and the model is told so; it still sometimes
 * emits the first of the series it was told not to expand -- "Online
 * Discussion Boards Week 1" for boards due every Saturday. The "1" is not a
 * fact about the document. A lone undated item whose own text states a
 * weekly rule loses a trailing "1" / "Week 1" / "#1"; the app's weekly-day
 * question then stands for the whole series once the term has dates.
 *
 * Numbers that are part of a name stay: "Chapter 1", "Unit 1", "Module 1".
 */
export function unnumberWeeklyRules(parsed: ParsedSyllabus): ParsedSyllabus {
  const suffix = /\s*[-–:,]?\s*(?:\(\s*week\s*1\s*\)|week\s*1|#\s*1|no\.?\s*1|1)\s*$/i;
  const named = /\b(?:chapter|ch|unit|module|part|section|sec|phase|stage|level|tier|round)\.?$/i;
  let changed = false;
  const assessments = parsed.assessments.map((a) => {
    if (a.dueDate !== null || a.kind === "exam" || !suffix.test(a.title) || !weeklyRuleOf(a)) return a;
    const title = a.title.replace(suffix, "").trim();
    if (!title || named.test(title)) return a;
    const siblings = parsed.assessments.some((b) => b !== a && b.title.trim().toLowerCase().startsWith(title.toLowerCase()));
    if (siblings) return a;
    changed = true;
    return { ...a, title };
  });
  return changed ? { ...parsed, assessments } : parsed;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Tuesday and Friday", "Monday, Wednesday and Friday". */
function dayList(days: number[]): string {
  const names = days.map((d) => DAY_NAMES[d] ?? "?");
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * "Mondays (asynchronous online) and Thursdays 12:15 to 1:40 (in person)": the
 * Monday half is not a meeting anyone attends, so there is no time to ask the
 * student for. A blank-time class day that the document itself calls
 * asynchronous, in the same breath, is taken off the meeting; a meeting left
 * with no days goes. Stated times are never touched -- the Thursday half
 * shares the sentence and is real.
 */
export function dropAsynchronousDays(parsed: ParsedSyllabus, text: string): ParsedSyllabus {
  const asynchronous = new Set<number>();
  const flat = text.replace(/\s+/g, " ");
  DAY_NAMES.forEach((name, d) => {
    // No leading word boundary: a heading and the next paragraph can run
    // together in a converted document ("...and PowerMondays (asynchronous").
    // The window is tight on purpose -- "asynchronous online) and Thursdays"
    // must not reach Thursday, which is the in-person half of the same line.
    const after = new RegExp(`${name}s?\\b\\s*[(,:–-]?\\s*(?:\\w+\\s+){0,2}asynch?ronous`, "i");
    const before = new RegExp(`\\basynch?ronous(?:\\s+\\w+){0,2}\\s+\\(?${name}s?\\b`, "i");
    if (after.test(flat) || before.test(flat)) asynchronous.add(d);
  });
  if (asynchronous.size === 0) return parsed;

  let changed = false;
  const warnings = [...parsed.warnings];
  const meetingTimes: MeetingTime[] = [];
  for (const m of parsed.course.meetingTimes) {
    if (m.kind === "office_hours" || !meetingNeedsTime(m)) {
      meetingTimes.push(m);
      continue;
    }
    const removed = m.daysOfWeek.filter((d) => asynchronous.has(d));
    if (removed.length === 0) {
      meetingTimes.push(m);
      continue;
    }
    changed = true;
    const kept = m.daysOfWeek.filter((d) => !asynchronous.has(d));
    warnings.push(
      `${dayList(removed)} is asynchronous online, so it was not added as a class meeting -- there is no time to put on the calendar.`,
    );
    if (kept.length > 0) meetingTimes.push({ ...m, daysOfWeek: kept });
  }
  if (!changed) return parsed;
  return { ...parsed, course: { ...parsed.course, meetingTimes }, warnings };
}

/**
 * Office hours the model left out, read from the document's own "Office
 * Hours:" line.
 *
 * Two syllabi lost their office hours in the same run: "Virtual Office
 * Hours: Wednesdays and Fridays: 9:00am-11:00am" and "By appointment only
 * (in person) Wednesday 11:00 am- 2:00 pm and Thursdays 10:00 am- 1:00 pm".
 * Each is a stated day with a stated range; a wording change elsewhere in the
 * prompt was enough to tip the model into skipping both. The line is
 * deterministic to read, so it is read -- only when the parse holds no
 * office hours at all, and only from lines that say they are office hours
 * (plus the two lines after, since a PDF wraps "11:00" and "am- 2:00 pm"
 * onto separate lines).
 *
 * Within the joined text, day words and time ranges are taken in order and
 * each range attaches to the most recent day words: "Tuesday: 10:00-10:30am
 * & 3:00-4:00pm & Friday 2:30-3:00pm" is two Tuesday blocks and one Friday
 * block. A range with no days before it is skipped, and a day with no range
 * ("by appointment") emits nothing.
 */
export function recoverOfficeHours(parsed: ParsedSyllabus, text: string): ParsedSyllabus {
  if (parsed.course.meetingTimes.some((m) => m.kind === "office_hours")) return parsed;
  const lines = text.split(/\r?\n/);
  // The line that names office hours and up to three after it -- a PDF wraps
  // "Wednesday 11:00" and "am- 2:00 pm" onto separate lines, and "Mondays:
  // 12:30 PM to 3:00 PM" can sit two lines under its heading. The block stops
  // early at a blank line, at a new heading, or at a line about the class
  // itself, so a "Monday 9-10am class" under "Office hours: by appointment"
  // is never read as office hours.
  // Case-sensitive on purpose: "COURSE DESCRIPTION:" is a heading, "Mondays:
  // 12:30 PM to 3:00 PM" is the office hours themselves.
  const heading = /^\s*[A-Z][A-Z /&]{2,}:/;
  const stop = /^\s*$|\b(?:class(?:es)?|lecture|meets|meeting|section|recitation|lab|tutorial)\b/i;
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/\b(?:office|student)\s*hours\b/i.test(lines[i])) continue;
    const block = [lines[i]];
    for (let j = i + 1; j <= i + 3 && j < lines.length && !stop.test(lines[j]) && !heading.test(lines[j]); j++) block.push(lines[j]);
    blocks.push(block.join(" ").replace(/\s+/g, " "));
    i += block.length - 1;
  }
  if (blocks.length === 0) return parsed;

  const DAYS = "(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?s?\\.?";
  const token = new RegExp(
    `(${DAYS}(?:\\s*(?:,|and|&|\\/)\\s*${DAYS})*)|(\\d{1,2}(?::\\d{2})?\\s*(?:[ap]\\.?\\s*m\\.?)?\\s*(?:-|–|—|to|until)\\s*\\d{1,2}(?::\\d{2})?\\s*(?:[ap]\\.?\\s*m\\.?)?)`,
    "gi",
  );
  const found: MeetingTime[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    let days: number[] = [];
    for (const m of block.matchAll(token)) {
      if (m[1]) {
        days = parseDaysOfWeek(m[1]);
        continue;
      }
      if (days.length === 0) continue;
      const range = parseTimeRange(m[2]);
      if (!range || range.start >= range.end) continue;
      const key = `${days.join(",")}|${range.start}|${range.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        kind: "office_hours",
        section: null,
        instructor: parsed.course.instructor,
        daysOfWeek: days,
        startTime: range.start,
        endTime: range.end,
        location: null,
      });
    }
  }
  if (found.length === 0) return parsed;
  const describe = found.map((m) => `${dayList(m.daysOfWeek)} ${m.startTime}–${m.endTime}`).join("; ");
  return {
    ...parsed,
    course: { ...parsed.course, meetingTimes: [...parsed.course.meetingTimes, ...found] },
    warnings: [...parsed.warnings, `Office hours were read from the syllabus's office-hours line (${describe}). Check them against the document.`],
  };
}

/** Fewer dated rows than this is a list of deadlines, not a schedule. */
const MIN_SCHEDULE_DATES = 8;

/**
 * A syllabus that lists twenty-six dated class sessions and never once says
 * what time the class meets has told the student the days: they are the days
 * the sessions fall on. The model is asked to read them that way and does
 * not always. With no class meeting at all, the student gets no sessions on
 * the calendar and is asked nothing -- the one outcome the setup card exists
 * to prevent.
 *
 * So, when the term has bounds and the parse holds no class meeting (office
 * hours only, or nothing): every date in the document that falls inside the
 * term is read, and the weekdays that carry the bulk of them are the class
 * days -- if there are enough dates to be a schedule, the chosen days account
 * for nearly all of them, and the listed dates cover most of the sessions
 * those days would hold. The meeting is emitted with blank times, which is
 * the setup card's cue to ask. A regular day the schedule skips, when the
 * schedule is near-complete, is a day the class does not meet.
 *
 * A list of assignment deadlines fails the coverage test: eight Sunday
 * deadlines over a fifteen-week term are half the Sundays, not a schedule.
 */
export function inferMeetingDaysFromSchedule(parsed: ParsedSyllabus, text: string): ParsedSyllabus {
  const { startDate, endDate } = parsed.course;
  if (!startDate || !endDate || startDate > endDate) return parsed;
  if (parsed.course.meetingTimes.some((m) => m.kind !== "office_hours")) return parsed;

  const ctx = { termStart: startDate, termEnd: endDate };
  const dates = new Set<string>();
  for (const span of findDateSpans(text)) {
    const iso = normalizeDate(text.slice(span.start, span.end), ctx);
    if (iso && iso >= startDate && iso <= endDate) dates.add(iso);
  }
  if (dates.size < MIN_SCHEDULE_DATES) return parsed;

  const perDay = new Map<number, number>();
  for (const iso of dates) {
    const d = isoDayOfWeek(iso);
    if (d !== null) perDay.set(d, (perDay.get(d) ?? 0) + 1);
  }
  const days = [...perDay.entries()].filter(([, n]) => n >= 4).map(([d]) => d).sort((a, b) => a - b);
  if (days.length === 0 || days.length > 4) return parsed;
  const covered = days.reduce((n, d) => n + (perDay.get(d) ?? 0), 0);
  if (covered < dates.size * 0.85) return parsed;

  const expected: string[] = [];
  for (let d: string | null = startDate; d && d <= endDate; d = addDays(d, 1)) {
    const wd = isoDayOfWeek(d);
    if (wd !== null && days.includes(wd)) expected.push(d);
  }
  const listed = expected.filter((d) => dates.has(d));
  if (expected.length === 0 || listed.length < expected.length * 0.6) return parsed;

  const meeting: MeetingTime = {
    kind: "lecture",
    section: null,
    instructor: null,
    daysOfWeek: days,
    startTime: UNKNOWN_TIME,
    endTime: UNKNOWN_TIME,
    location: null,
  };
  const warnings = [
    ...parsed.warnings,
    `Class days (${dayList(days)}) were read from the dated schedule. The syllabus never states a class time, so you'll be asked for it.`,
  ];

  let noClass = parsed.course.noClass ?? [];
  if (listed.length >= expected.length * 0.8) {
    const inBreak = (d: string) => noClass.some((p) => p.start <= d && d <= p.end);
    const gaps = expected.filter((d) => !dates.has(d) && !inBreak(d));
    if (gaps.length > 0 && gaps.length <= 6) {
      noClass = [...noClass, ...gaps.map((d) => ({ start: d, end: d, reason: null }))];
      warnings.push(
        `${gaps.length === 1 ? "One regular class day is" : `${gaps.length} regular class days are`} missing from the dated schedule (${gaps.join(", ")}), so ${gaps.length === 1 ? "it was" : "they were"} marked as no class.`,
      );
    }
  }
  return {
    ...parsed,
    course: { ...parsed.course, meetingTimes: [...parsed.course.meetingTimes, meeting], noClass },
    warnings,
  };
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
