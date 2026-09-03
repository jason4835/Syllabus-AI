/**
 * iCalendar (RFC 5545) serialisation.
 *
 * One decision shapes this whole file: **there are no RRULEs and no VTIMEZONE
 * blocks**. Recurring events are expanded into individual VEVENTs and every
 * timed event is written as a UTC instant (`DTSTART:20261102T150000Z`).
 *
 * The alternative -- emitting `DTSTART;TZID=America/New_York` plus a
 * hand-rolled VTIMEZONE -- is the single most reliable way to ship a broken
 * feed. A correct VTIMEZONE for an arbitrary IANA zone needs that zone's full
 * historical and future transition rules, the runtime does not expose them, and
 * a subtly wrong one moves a student's 10am class by an hour for half the term
 * in whichever client is strictest. Expanding to per-occurrence UTC through
 * `toUtc` gets DST right for free, because each occurrence's offset is resolved
 * on its own date. The cost is a larger file; a semester of classes is still
 * only a few hundred VEVENTs.
 *
 * All-day events stay floating (`VALUE=DATE`) -- a due date is a date, and
 * pinning it to an instant is what drags a midnight deadline into the day
 * before for anyone reading the feed from another zone.
 *
 * Output is byte-for-byte deterministic for the same input apart from DTSTAMP.
 */

import { type CalendarEvent, addDays, expandAll, toUtc } from "@/lib/calendar/events";

const PRODID = "-//Syllabus AI//Calendar Feed//EN";
const UID_DOMAIN = "syllabus-ai";
const CRLF = "\r\n";

export interface IcsOptions {
  /** Calendar name clients display (X-WR-CALNAME). */
  name: string;
  /** IANA zone the events' floating datetimes are anchored to. */
  timeZone: string;
  /** Overridable for deterministic tests. Defaults to now. */
  now?: Date;
}

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** `Date` -> "YYYYMMDDTHHMMSSZ". */
function utcStamp(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`
  );
}

/** "YYYY-MM-DD" -> "YYYYMMDD". */
function dateStamp(date: string): string {
  return date.slice(0, 10).replace(/-/g, "");
}

/**
 * RFC 5545 text escaping. Order matters: backslashes first, or every escape we
 * add would be escaped again on the next pass.
 */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

const encoder = new TextEncoder();

/**
 * Content-line folding: lines are limited to 75 OCTETS, not characters, and a
 * continuation begins with a single space that counts toward the next line's
 * budget. Folding is done over UTF-8 code points so a multi-byte character is
 * never split down the middle -- a client that decodes the halves separately
 * shows mojibake, or rejects the file outright.
 */
function foldLine(line: string): string[] {
  if (encoder.encode(line).length <= 75) return [line];

  const out: string[] = [];
  let current = "";
  let currentBytes = 0;
  let limit = 75;

  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (currentBytes + size > limit) {
      out.push(current);
      // Continuation lines carry a leading space, which eats one octet.
      current = " ";
      currentBytes = 1;
      limit = 75;
    }
    current += ch;
    currentBytes += size;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * VALARMs for an event, if it has any.
 *
 * Recurring class meetings and office hours carry no reminders by design (see
 * `reminderMinutes` in the planner), and the `kind` guard makes that structural
 * rather than incidental: a reminder that fires before every office hour of the
 * semester is how a student mutes the whole feed, and office hours are the one
 * meeting kind a well-meaning future edit is most likely to "helpfully" nudge.
 */
function alarms(event: CalendarEvent, lines: string[]): void {
  if (event.kind === "meeting") return;
  for (const minutes of event.reminderMinutes) {
    if (!Number.isFinite(minutes) || minutes < 0) continue;
    lines.push("BEGIN:VALARM");
    lines.push("ACTION:DISPLAY");
    lines.push(`DESCRIPTION:${escapeText(event.title)}`);
    lines.push(`TRIGGER:-PT${Math.round(minutes)}M`);
    lines.push("END:VALARM");
  }
}

function renderEvent(event: CalendarEvent, dtstamp: string, lines: string[]): void {
  lines.push("BEGIN:VEVENT");
  lines.push(`UID:${event.key}@${UID_DOMAIN}`);
  lines.push(`DTSTAMP:${dtstamp}`);

  if (event.allDay) {
    // DTEND is EXCLUSIVE for date-valued events, so a one-day item ends the
    // following morning. The model carries the inclusive last day.
    const end = addDays(event.end, 1) ?? event.end;
    lines.push(`DTSTART;VALUE=DATE:${dateStamp(event.start)}`);
    lines.push(`DTEND;VALUE=DATE:${dateStamp(end)}`);
  } else {
    lines.push(`DTSTART:${utcStamp(toUtc(event.start, event.timeZone))}`);
    lines.push(`DTEND:${utcStamp(toUtc(event.end, event.timeZone))}`);
  }

  lines.push(`SUMMARY:${escapeText(event.title)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
  alarms(event, lines);
  lines.push("END:VEVENT");
}

/**
 * A complete .ics document for the given events.
 *
 * Recurring events are expanded first, so what a client sees is one VEVENT per
 * class meeting that actually happens -- breaks and holidays are simply absent
 * rather than described by an EXDATE the client has to apply correctly.
 */
export function renderIcs(events: CalendarEvent[], opts: IcsOptions): string {
  const dtstamp = utcStamp(opts.now ?? new Date());

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    `PRODID:${PRODID}`,
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(opts.name)}`,
    `X-WR-TIMEZONE:${opts.timeZone}`,
    // Both spellings: the standard one and the Outlook/Apple-era property that
    // predates it. Clients honour one or the other, rarely both.
    "X-PUBLISHED-TTL:PT1H",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
  ];

  for (const event of expandAll(events)) {
    renderEvent(event, dtstamp, lines);
  }

  lines.push("END:VCALENDAR");

  // Folding last, over the finished lines, so no producer above has to think
  // about octet budgets. Trailing CRLF: the file ends with a complete line.
  return lines.flatMap(foldLine).join(CRLF) + CRLF;
}
