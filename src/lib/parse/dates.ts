/**
 * Date and time normalization for syllabus text.
 *
 * Syllabi write dates every way a human can: "9/12", "Sep 12", "Mon 9/12",
 * "September 12, 2026", "Oct 5-7", "Week 4". Worse, they routinely omit the
 * year -- which is the single most dangerous ambiguity in this pipeline. A
 * "Jan 20" inside a Fall-2026 syllabus belongs to 2027, and silently stamping
 * 2026 on it would drop the item into the past, where the planner and the
 * calendar sync would quietly ignore it. So year inference here is deliberately
 * conservative: we only assign a year that lands the date inside the known
 * term, and return null otherwise. A null date surfaces to the user as "we
 * couldn't date this" -- a wrong date never surfaces at all.
 *
 * Everything in this module is pure and side-effect free so the extractor, the
 * fallback parser and any future re-parse path all agree on what a date means.
 */

/** Term bounds used to resolve years the syllabus left out. */
export interface DateContext {
  termStart?: string | null;
  termEnd?: string | null;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

// Longest-first so "september" wins over "sep" -- JS alternation is first-match,
// not longest-match, and getting this backwards silently truncates every date.
const MONTH_PATTERN = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|");

/** 0 = Sunday .. 6 = Saturday, matching MeetingTime.daysOfWeek. */
const WEEKDAY_WORDS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tues: 2,
  tue: 2,
  wednesday: 3,
  weds: 3,
  wed: 3,
  thursday: 4,
  thurs: 4,
  thur: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1] ?? 31;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function toIso(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Days since epoch for an ISO date -- lets us compare/offset without Date's timezone traps. */
function toDayNumber(year: number, month: number, day: number): number {
  // Howard Hinnant's civil-from-days, inverted. Pure integer math, so a date
  // never shifts by a day because the server happens to run in UTC+13.
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function fromDayNumber(days: number): { year: number; month: number; day: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: month <= 2 ? y + 1 : y, month, day };
}

/** 0 = Sunday .. 6 = Saturday. Day 0 of the epoch (1970-01-01) was a Thursday. */
function dayOfWeek(days: number): number {
  return ((days % 7) + 11) % 7;
}

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

/** Strict ISO parse. Rejects impossible dates like 2026-02-30 rather than rolling them over. */
export function parseIsoDate(iso: string | null | undefined): CivilDate | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

/** Add whole days to an ISO date. Returns null if the input is not a valid ISO date. */
export function addDays(iso: string, days: number): string | null {
  const d = parseIsoDate(iso);
  if (!d) return null;
  const next = fromDayNumber(toDayNumber(d.year, d.month, d.day) + days);
  return toIso(next.year, next.month, next.day);
}

/** ISO weekday (0 = Sunday) for an ISO date, or null when unparseable. */
export function isoDayOfWeek(iso: string): number | null {
  const d = parseIsoDate(iso);
  if (!d) return null;
  return dayOfWeek(toDayNumber(d.year, d.month, d.day));
}

/** Normalizes the many dash characters syllabi use for ranges into a plain hyphen. */
function normalizeDashes(s: string): string {
  return s.replace(/[‐-―−]/g, "-");
}

function expandTwoDigitYear(raw: number): number {
  // A syllabus will never mean 1926, and the pivot only matters for "9/12/26".
  if (raw >= 100) return raw;
  return raw < 70 ? 2000 + raw : 1900 + raw;
}

interface DateFragment {
  start: number;
  end: number;
  month: number;
  day: number;
  year: number | null;
}

/**
 * Finds every date-looking fragment in a string, left to right.
 *
 * We scan rather than anchor because syllabus lines mix a date in with a lot of
 * other text ("Week 5 | Fri Oct 2 | Midterm 1 in Hayes 210").
 */
function scanFragments(text: string): DateFragment[] {
  const found: DateFragment[] = [];

  // "September 12, 2026" / "Sep 12" / "Sept. 12th"
  const monthFirst = new RegExp(
    `\\b(${MONTH_PATTERN})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(\\d{4}))?`,
    "gi",
  );
  for (let m = monthFirst.exec(text); m !== null; m = monthFirst.exec(text)) {
    const month = MONTHS[m[1].toLowerCase()];
    found.push({
      start: m.index,
      end: m.index + m[0].length,
      month,
      day: Number(m[2]),
      year: m[3] ? Number(m[3]) : null,
    });
  }

  // "12 September 2026" -- the international ordering, which US syllabi use for
  // study-abroad and cross-listed courses.
  const dayFirst = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_PATTERN})\\.?(?:\\s*,?\\s*(\\d{4}))?`,
    "gi",
  );
  for (let m = dayFirst.exec(text); m !== null; m = dayFirst.exec(text)) {
    const month = MONTHS[m[2].toLowerCase()];
    found.push({
      start: m.index,
      end: m.index + m[0].length,
      month,
      day: Number(m[1]),
      year: m[3] ? Number(m[3]) : null,
    });
  }

  // "9/12", "9/12/26", "09/12/2026". US month-first ordering, which is what
  // American syllabi mean; a "13/5" is treated as day-first since it can't be a month.
  const numeric = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g;
  for (let m = numeric.exec(text); m !== null; m = numeric.exec(text)) {
    let month = Number(m[1]);
    let day = Number(m[2]);
    if (month > 12 && day <= 12) {
      [month, day] = [day, month];
    }
    found.push({
      start: m.index,
      end: m.index + m[0].length,
      month,
      day,
      year: m[3] ? expandTwoDigitYear(Number(m[3])) : null,
    });
  }

  // Drop overlaps -- "12 September 2026" matches both month-first and day-first
  // scanners. Sorting by start then by width keeps the widest interpretation.
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const deduped: DateFragment[] = [];
  for (const f of found) {
    const last = deduped[deduped.length - 1];
    if (last && f.start < last.end) continue;
    if (f.month < 1 || f.month > 12) continue;
    if (f.day < 1 || f.day > 31) continue;
    deduped.push(f);
  }
  return deduped;
}

/**
 * Picks the year for a month/day the syllabus left bare.
 *
 * Rule: the year must land the date inside the term. If no candidate year does,
 * we return null rather than guessing -- see the module comment.
 */
function resolveYear(month: number, day: number, ctx: DateContext): number | null {
  const start = parseIsoDate(ctx.termStart);
  const end = parseIsoDate(ctx.termEnd);
  if (!start && !end) return null;

  const startNum = start ? toDayNumber(start.year, start.month, start.day) : null;
  const endNum = end ? toDayNumber(end.year, end.month, end.day) : null;

  const anchorYear = start?.year ?? end?.year;
  if (anchorYear === undefined) return null;

  // A term never spans more than a couple of calendar years, so a three-year
  // window around the anchor covers every legitimate candidate.
  const candidates: number[] = [];
  for (let y = anchorYear - 1; y <= anchorYear + 2; y += 1) {
    if (day > daysInMonth(y, month)) continue; // Feb 29 in a non-leap year
    candidates.push(y);
  }

  const inside = candidates.filter((y) => {
    const n = toDayNumber(y, month, day);
    if (startNum !== null && n < startNum) return false;
    if (endNum !== null && n > endNum) return false;
    return true;
  });
  if (inside.length > 0) return Math.min(...inside);

  // Only one bound known: accept the nearest year on the correct side, but only
  // within a year of the bound so a stray date can't be dragged across a decade.
  if (startNum !== null && endNum === null) {
    const forward = candidates
      .map((y) => ({ y, n: toDayNumber(y, month, day) }))
      .filter((c) => c.n >= startNum && c.n - startNum <= 400);
    if (forward.length > 0) return forward.sort((a, b) => a.n - b.n)[0].y;
  }
  if (endNum !== null && startNum === null) {
    const backward = candidates
      .map((y) => ({ y, n: toDayNumber(y, month, day) }))
      .filter((c) => c.n <= endNum && endNum - c.n <= 400);
    if (backward.length > 0) return backward.sort((a, b) => b.n - a.n)[0].y;
  }

  return null;
}

/** "Week 4" (optionally with a weekday) resolved against the term start. */
function resolveWeekNumber(text: string, ctx: DateContext): string | null {
  const weekMatch = /\bweek\s*#?\s*(\d{1,2})\b/i.exec(text);
  if (!weekMatch) return null;
  const start = parseIsoDate(ctx.termStart);
  if (!start) return null;

  const weekNumber = Number(weekMatch[1]);
  if (weekNumber < 1 || weekNumber > 30) return null;

  const startNum = toDayNumber(start.year, start.month, start.day);
  // Week 1 is the week that contains the first day of class, so we anchor on
  // that week's Monday and step forward in whole weeks from there.
  const mondayOfWeek1 = startNum - ((dayOfWeek(startNum) + 6) % 7);
  const mondayOfTarget = mondayOfWeek1 + (weekNumber - 1) * 7;

  // "Fri of Week 4" is a real pattern; a bare "Week 4" we date to the Monday.
  let offset = 0;
  const weekdayMatch = new RegExp(`\\b(${Object.keys(WEEKDAY_WORDS).sort((a, b) => b.length - a.length).join("|")})\\b`, "i").exec(text);
  if (weekdayMatch) {
    const dow = WEEKDAY_WORDS[weekdayMatch[1].toLowerCase()];
    offset = (dow + 6) % 7; // Monday = 0 .. Sunday = 6
  }

  const target = fromDayNumber(mondayOfTarget + offset);
  return toIso(target.year, target.month, target.day);
}

/**
 * A day range whose tail has no month of its own -- "Oct 5-7", "Dec 14-18, 2026".
 *
 * The trailing year matters: without capturing it, "December 14-18, 2026" would
 * lose its year the moment we swapped day 14 for day 18, and fall back to
 * guessing.
 */
const OPEN_RANGE_TAIL = /^\s*(?:-|to|through|thru|&|and)\s*(\d{1,2})(?:st|nd|rd|th)?(?![\d:/])(?:\s*,?\s*(\d{4})\b)?/i;

/** Resolves one scanned fragment, optionally absorbing a "-18, 2026" style tail. */
function resolveFragment(fragment: DateFragment, tail: string, ctx: DateContext): string | null {
  let month = fragment.month;
  let day = fragment.day;
  let year = fragment.year;

  const range = OPEN_RANGE_TAIL.exec(tail);
  if (range) {
    const endDay = Number(range[1]);
    if (endDay >= day && endDay <= 31) {
      day = endDay;
      if (range[2]) year = Number(range[2]);
    }
  }

  const resolved = year ?? resolveYear(month, day, ctx);
  if (resolved === null) return null;
  if (day > daysInMonth(resolved, month)) return null;
  return toIso(resolved, month, day);
}

/** Character spans of every date-looking fragment, so callers can strip dates out of titles. */
export function findDateSpans(text: string): Array<{ start: number; end: number }> {
  return scanFragments(normalizeDashes(text)).map((f) => ({ start: f.start, end: f.end }));
}

/**
 * Turns any syllabus date expression into `YYYY-MM-DD`, or null when the date
 * cannot be pinned down honestly.
 *
 * Ranges resolve to their END ("Oct 5-7" -> Oct 7, "Dec 14-18" -> Dec 18)
 * because when a syllabus gives a window for a graded item, the last day is the
 * deadline the student actually has to hit.
 */
export function normalizeDate(raw: string, ctx: DateContext = {}): string | null {
  if (typeof raw !== "string") return null;
  const text = normalizeDashes(raw).replace(/\s+/g, " ").trim();
  if (text.length === 0) return null;

  // An already-ISO date is authoritative -- never re-derive it.
  const isoMatch = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (isoMatch) {
    const parsed = parseIsoDate(isoMatch[0]);
    if (parsed) return toIso(parsed.year, parsed.month, parsed.day);
  }

  const fragments = scanFragments(text);
  if (fragments.length === 0) {
    // No calendar date at all -- the only thing left that can carry one is a
    // week number measured off the term start.
    return resolveWeekNumber(text, ctx);
  }

  const last = fragments[fragments.length - 1];
  return resolveFragment(last, text.slice(last.end), ctx);
}

/**
 * Reads both ends of a span like "August 24, 2026 - December 18, 2026" or
 * "Dec 14-18, 2026". Used for term bounds, where losing the start date costs us
 * every year inference downstream.
 */
export function normalizeDateRange(
  raw: string,
  ctx: DateContext = {},
): { start: string | null; end: string | null } {
  if (typeof raw !== "string") return { start: null, end: null };
  const text = normalizeDashes(raw).replace(/\s+/g, " ").trim();
  const fragments = scanFragments(text);
  if (fragments.length === 0) return { start: null, end: null };

  const first = fragments[0];
  const last = fragments[fragments.length - 1];

  // With a single fragment the range must be the "14-18" form, so the same
  // fragment supplies the start (bare) and the end (with its tail absorbed).
  const start = resolveFragment(first, "", ctx);
  const end = resolveFragment(last, text.slice(last.end), ctx);
  return { start, end: end ?? start };
}

/**
 * Extracts a wall-clock time as `HH:MM` (24h).
 *
 * Returns the FIRST time in the string, which for "due by 11:59 PM" and for
 * "MWF 10:00-10:50" is the one a caller wants; use `parseTimeRange` when both
 * ends of a range matter.
 */
export function parseTime(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text.length === 0) return null;

  if (/\bnoon\b/i.test(text)) return "12:00";
  if (/\bmidnight\b/i.test(text)) return "00:00";

  // 12-hour with a meridiem is unambiguous, so try it before bare digits.
  const twelve = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?\b/i.exec(text);
  if (twelve) {
    let hour = Number(twelve[1]);
    const minute = twelve[2] ? Number(twelve[2]) : 0;
    if (hour < 1 || hour > 12 || minute > 59) return null;
    const isPm = twelve[3].toLowerCase() === "p";
    if (hour === 12) hour = 0;
    if (isPm) hour += 12;
    return `${pad2(hour)}:${pad2(minute)}`;
  }

  // Bare "14:30" / "10:00". Requires the colon so we never read "MATH 221" or a
  // page number as a time.
  const twentyFour = /\b(\d{1,2}):(\d{2})\b/.exec(text);
  if (twentyFour) {
    const hour = Number(twentyFour[1]);
    const minute = Number(twentyFour[2]);
    if (hour > 23 || minute > 59) return null;
    return `${pad2(hour)}:${pad2(minute)}`;
  }

  return null;
}

/**
 * Reads "10:00-10:50" or "2:00-3:15pm" into both endpoints.
 *
 * The trailing meridiem often applies to both ends ("2:00-3:15pm"), so an
 * un-suffixed start borrows the end's meridiem when that keeps the range
 * moving forward in time.
 */
export function parseTimeRange(raw: string): { start: string; end: string } | null {
  const text = normalizeDashes(raw);
  const m = /(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?\s*m\.?)?)\s*(?:-|to|until)\s*(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?\s*m\.?)?)/i.exec(
    text,
  );
  if (!m) return null;

  const rawStart = m[1].trim();
  const rawEnd = m[2].trim();
  const endMeridiem = /([ap])\.?\s*m\.?\s*$/i.exec(rawEnd);
  const startHasMeridiem = /[ap]\.?\s*m\.?\s*$/i.test(rawStart);

  let start = parseTime(startHasMeridiem || !endMeridiem ? rawStart : `${rawStart}${endMeridiem[1]}m`);
  const end = parseTime(rawEnd);
  if (!start || !end) return null;

  // "10:00-10:50am" borrowed correctly; "11:00-1:00pm" would have produced
  // 23:00, so fall back to the literal reading when the range inverts.
  if (start > end && !startHasMeridiem) {
    const literal = parseTime(rawStart);
    if (literal && literal <= end) start = literal;
  }
  return { start, end };
}

/**
 * Reads a day-of-week code into `MeetingTime.daysOfWeek`.
 *
 * Handles both the compact registrar forms ("MWF", "TTh", "TR") and spelled-out
 * lists ("Mon/Wed/Fri"). The compact form is why this can't just be a word
 * lookup: "T" and "Th" collide, so we consume longest-token-first.
 */
export function parseDaysOfWeek(raw: string): number[] {
  const days = new Set<number>();

  const words = raw.toLowerCase().match(/[a-z]+/g) ?? [];
  let matchedWord = false;
  for (const word of words) {
    if (word in WEEKDAY_WORDS && word.length >= 3) {
      days.add(WEEKDAY_WORDS[word]);
      matchedWord = true;
    }
  }
  if (matchedWord) return [...days].sort((a, b) => a - b);

  // Compact codes: scan a token at a time, longest first.
  const compact: Array<[string, number]> = [
    ["SU", 0],
    ["SA", 6],
    ["TH", 4],
    ["TU", 2],
    ["M", 1],
    ["T", 2],
    ["W", 3],
    ["R", 4],
    ["F", 5],
    ["S", 6],
    ["U", 0],
  ];
  // "H" belongs in the class even though it is never a day on its own -- without
  // it "TTh" tokenizes as "TT" and Thursday silently disappears.
  const token = (raw.toUpperCase().match(/[MTWRFSUH]{1,10}/g) ?? []).sort((a, b) => b.length - a.length)[0];
  if (!token) return [];

  let i = 0;
  while (i < token.length) {
    const hit = compact.find(([code]) => token.startsWith(code, i));
    if (!hit) {
      i += 1;
      continue;
    }
    days.add(hit[1]);
    i += hit[0].length;
  }
  return [...days].sort((a, b) => a - b);
}

/**
 * A conventional calendar window for a term label like "Fall 2026".
 *
 * This is NOT a claim about the course's real start and end dates -- it is
 * generous on purpose. Its only job is to give `normalizeDate` enough context
 * to pick the right year for a bare "Jan 20" when the syllabus never printed
 * its term dates. Callers must not surface these as `Course.startDate`.
 */
export function termWindowFromLabel(label: string | null | undefined): DateContext {
  if (!label) return {};
  const m = /\b(fall|autumn|spring|summer|winter)\s*,?\s*(20\d{2})\b/i.exec(label);
  if (!m) return {};
  const season = m[1].toLowerCase();
  const year = Number(m[2]);

  switch (season) {
    case "fall":
    case "autumn":
      return { termStart: toIso(year, 8, 1), termEnd: toIso(year, 12, 31) };
    case "spring":
      return { termStart: toIso(year, 1, 1), termEnd: toIso(year, 6, 15) };
    case "summer":
      return { termStart: toIso(year, 5, 1), termEnd: toIso(year, 9, 15) };
    case "winter":
      // Winter terms straddle New Year, which is exactly the case that makes
      // naive year inference wrong.
      return { termStart: toIso(year, 11, 15), termEnd: toIso(year + 1, 3, 31) };
    default:
      return {};
  }
}
