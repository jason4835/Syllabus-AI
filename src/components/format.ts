/**
 * Small date/number helpers. No date library is installed on purpose, so these
 * stay deliberately narrow: ISO dates from the API are calendar dates
 * (YYYY-MM-DD) and must be read in the user's local zone, never as UTC.
 */

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAYS_LONG = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];
const MS_PER_DAY = 86_400_000;

/** Parses `YYYY-MM-DD` (or an ISO datetime) into a *local* Date. */
export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) {
    const loose = new Date(value);
    return Number.isNaN(loose.getTime()) ? null : loose;
  }
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Whole days from today to `value`; negative when it is in the past. */
export function daysUntil(value: string | Date, now = new Date()): number | null {
  const target = value instanceof Date ? value : parseDate(value);
  if (!target) return null;
  return Math.round(
    (startOfDay(target).getTime() - startOfDay(now).getTime()) / MS_PER_DAY,
  );
}

/** "Mon, Oct 14" */
export function formatDate(value: string | Date | null): string {
  const date = value instanceof Date ? value : parseDate(value);
  if (!date) return "No date";
  return `${DAYS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

/** "Oct 14" */
export function formatDateShort(value: string | Date | null): string {
  const date = value instanceof Date ? value : parseDate(value);
  if (!date) return "TBD";
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

export function formatWeekday(value: string | Date | null): string {
  const date = value instanceof Date ? value : parseDate(value);
  return date ? DAYS_LONG[date.getDay()] : "";
}

/** "Oct 14 – Oct 20" for the week beginning at `weekStart`. */
export function formatWeekRange(weekStart: string): string {
  const start = parseDate(weekStart);
  if (!start) return "Unknown week";
  const end = new Date(start.getTime() + 6 * MS_PER_DAY);
  return `${formatDateShort(start)} – ${formatDateShort(end)}`;
}

/** "in 5 days" / "today" / "3 days ago" — plain, never cute. */
export function formatRelative(value: string | Date | null, now = new Date()): string {
  const days = value === null ? null : daysUntil(value, now);
  if (days === null) return "unscheduled";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days > 0) {
    if (days < 14) return `in ${days} days`;
    if (days < 60) return `in ${Math.round(days / 7)} weeks`;
    return `in ${Math.round(days / 30)} months`;
  }
  const past = Math.abs(days);
  if (past < 14) return `${past} days ago`;
  if (past < 60) return `${Math.round(past / 7)} weeks ago`;
  return `${Math.round(past / 30)} months ago`;
}

/** 24h "14:30" -> "2:30 PM" */
export function formatTime(value: string | null): string | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!match) return value;
  const hour = Number(match[1]);
  const suffix = hour >= 12 ? "PM" : "AM";
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${match[2]} ${suffix}`;
}

/** The two halves of a 12h clock reading, kept apart so a range can share one. */
function clockParts(value: string): { clock: string; suffix: "AM" | "PM" } | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return {
    // Inside a range a whole hour is written bare: "8–9:50 AM", not "8:00".
    clock: match[2] === "00" ? String(display) : `${display}:${match[2]}`,
    suffix: hour >= 12 ? "PM" : "AM",
  };
}

/**
 * "10:15 AM–12:15 PM", "12:30–1:50 PM", "8–9:50 AM" — a sitting's start and
 * end, written the way a syllabus writes it: the meridiem is said once when
 * both ends share it, and twice when they straddle noon or midnight.
 *
 * A null `end` falls back to the lone start time, so a caller can hand over an
 * assessment's two fields without branching on whether the range exists.
 */
export function formatTimeRange(
  start: string | null,
  end: string | null,
): string | null {
  if (!start) return null;
  if (!end) return formatTime(start);
  const from = clockParts(start);
  const to = clockParts(end);
  // Something the parser never produces: show both readings rather than lie.
  if (!from || !to) return `${formatTime(start)}–${formatTime(end)}`;
  const meridiem = from.suffix === to.suffix ? "" : ` ${from.suffix}`;
  return `${from.clock}${meridiem}–${to.clock} ${to.suffix}`;
}

/** ISO `YYYY-MM-DD` of the Monday on or before `value`. */
export function mondayOf(value: string | Date | null): string | null {
  const date = value instanceof Date ? value : parseDate(value);
  if (!date) return null;
  const offset = (date.getDay() + 6) % 7;
  const monday = new Date(date.getTime() - offset * MS_PER_DAY);
  const month = String(monday.getMonth() + 1).padStart(2, "0");
  const day = String(monday.getDate()).padStart(2, "0");
  return `${monday.getFullYear()}-${month}-${day}`;
}

export function formatHours(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return "0 hrs";
  const rounded = hours < 10 ? Math.round(hours * 10) / 10 : Math.round(hours);
  return `${rounded} ${rounded === 1 ? "hr" : "hrs"}`;
}

export function formatPercent(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  const rounded = Math.round(value * 10) / 10;
  return `${rounded}%`;
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}
