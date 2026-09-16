/**
 * The lazy migration that gives every course written before terms existed a
 * term to belong to.
 *
 * There is no SQL data migration, for the same reason none of the earlier
 * columns had one: the read side is where this codebase absorbs a schema
 * change, so a deploy never has to be preceded by a script and a rollback never
 * has to be preceded by another one. `ensureTermsBackfilled` runs once per user
 * on the next read of their courses and is a no-op forever after, because after
 * it every course has a `termId`.
 *
 * What it must get right is grandfathering. A student who had three courses had
 * them for free, and the pass is sold per term, so the terms this creates carry
 * `freeCourses = the number of courses migrated into them`: nothing a user
 * already had is taken away, and the paywall applies only to the NEXT course
 * they add. The terms are also created confirmed -- nothing was asked of a user
 * who did nothing new (docs/TERM-PASS.md, "Existing users").
 *
 * Server-only: it writes through the store.
 */

import { addDays, parseIsoDate } from "@/lib/parse/dates";
import { log } from "@/lib/log";
import { store } from "@/lib/store";
import {
  MAX_TERM_DAYS,
  TERM_MATCH_OVERLAP,
  guessTermType,
  normalizeTermLabel,
  overlapFraction,
  seasonName,
  termLengthDays,
} from "@/lib/terms";
import type { Course, TermType } from "@/lib/types";

/**
 * Courses that will become one term. `label` is the term text they shared, when
 * they had one -- it becomes the term's name, because whatever the syllabus
 * called it is better than anything this file could invent.
 */
interface Group {
  label: string | null;
  courses: Course[];
}

/** A course's own window, or null unless it stated a usable pair. */
function bounds(course: Course): { start: string; end: string } | null {
  const { startDate, endDate } = course;
  if (startDate === null || endDate === null) return null;
  if (parseIsoDate(startDate) === null || parseIsoDate(endDate) === null) return null;
  if (endDate < startDate) return null;
  return { start: startDate, end: endDate };
}

/**
 * The window a group covers: earliest start to latest end.
 *
 * Null unless the group has both ends of a window somewhere in it. Half a window
 * is not a shorter term, it is a term nothing can compute an expiry from, so the
 * honest answer is a term with no dates and a setup card that asks.
 */
function groupBounds(group: Group): { start: string; end: string } | null {
  const starts = group.courses
    .map((c) => c.startDate)
    .filter((d): d is string => d !== null && parseIsoDate(d) !== null)
    .sort();
  const ends = group.courses
    .map((c) => c.endDate)
    .filter((d): d is string => d !== null && parseIsoDate(d) !== null)
    .sort();
  if (starts.length === 0 || ends.length === 0) return null;

  const start = starts[0];
  let end = ends[ends.length - 1];
  if (end < start) return null;

  // Clamped by moving the END, never the start: the start is a date a syllabus
  // actually stated, while the far end of a union of several courses is where
  // one outlier can stretch a "term" past six months. A term that is too long
  // could not be created at all (`validateTermInput`), and refusing to migrate
  // somebody's courses over it would be the worst outcome available.
  if (termLengthDays(start, end) > MAX_TERM_DAYS) {
    end = addDays(start, MAX_TERM_DAYS) ?? end;
  }
  return { start, end };
}

/**
 * Files every term-less course of this user's into a term, once.
 *
 * Grouping, in the order the plan states: by the `term` text when the syllabus
 * gave one, then by overlapping dates, and finally one group for the courses
 * that have neither. Safe to call on every read -- it returns immediately when
 * there is nothing to do -- and safe to call again after a previous call
 * finished, for the same reason. Two calls racing each other could create two
 * terms for one group; that is a duplicate term the student can delete, not lost
 * data, and it is not worth a lock in a store that has no transactions.
 */
/**
 * One run per user at a time. The dashboard asks for courses and terms in
 * parallel and both routes call this, so two runs regularly start together;
 * each saw every course term-less and each made a term, leaving an empty
 * duplicate. The second caller now waits for the first and then finds
 * nothing to do.
 */
const inFlight = new Map<string, Promise<void>>();

export async function ensureTermsBackfilled(userId: string): Promise<void> {
  const running = inFlight.get(userId);
  if (running) return running;
  const run = backfill(userId).finally(() => {
    if (inFlight.get(userId) === run) inFlight.delete(userId);
  });
  inFlight.set(userId, run);
  return run;
}

async function backfill(userId: string): Promise<void> {
  const courses = await store.listCourses(userId);
  // Oldest first, which `listCourses` is not: the grouping below is
  // order-dependent -- the first course to open a group gives it its name, and
  // the first syllabus's spelling of a label is the one the student sees -- so
  // "whatever order the driver happened to return" would make the result depend
  // on the driver. The id breaks a tie so the same database always produces the
  // same terms, however many courses were written in the same millisecond.
  const termless = courses
    .filter((c) => c.termId === null)
    .sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.id.localeCompare(b.id)
        : a.createdAt < b.createdAt
          ? -1
          : 1,
    );
  if (termless.length === 0) return;

  // Keyed by the normalized label, so "Fall 2026" and "fall  2026" are one term.
  const labelled = new Map<string, Group>();
  // Date-grouped and undated groups, in the order they were opened. The undated
  // one is last so it reads that way in the list too.
  const dated: Group[] = [];
  const undated: Group = { label: null, courses: [] };

  for (const course of termless) {
    const label = course.term?.trim() ?? "";
    if (label.length > 0) {
      const key = normalizeTermLabel(label);
      const existing = labelled.get(key);
      if (existing) existing.courses.push(course);
      else labelled.set(key, { label, courses: [course] });
      continue;
    }

    const window = bounds(course);
    if (window === null) {
      undated.courses.push(course);
      continue;
    }

    // The same test `suggestTerm` applies to an existing term, against the
    // group's union rather than a stored row: half of this course has to fall
    // inside the group for it to be the same term. A January module next to an
    // autumn semester therefore starts its own group instead of widening one.
    const joined = dated.find((group) => {
      const union = groupBounds(group);
      if (union === null) return false;
      return (
        overlapFraction(window.start, window.end, union.start, union.end) >=
        TERM_MATCH_OVERLAP
      );
    });
    if (joined) joined.courses.push(course);
    else dated.push({ label: null, courses: [course] });
  }

  const groups = [...labelled.values(), ...dated];
  if (undated.courses.length > 0) groups.push(undated);

  const now = new Date().toISOString();
  let assigned = 0;

  for (const group of groups) {
    const window = groupBounds(group);
    const name =
      group.label ?? (window !== null ? seasonName(window.start) : "My courses");
    const termType: TermType =
      window !== null
        ? guessTermType(window.start, window.end, group.label ?? name)
        : // No dates means no length, and a type read off a label alone would be
          // a guess the student then has to notice and undo.
          "custom";

    const term = await store.createTerm(userId, {
      name,
      termType,
      startDate: window?.start ?? null,
      endDate: window?.end ?? null,
      // The whole point: every course being migrated stays free.
      freeCourses: group.courses.length,
      // Confirmed, because nothing was asked of a user who did nothing new.
      confirmedAt: now,
    });

    for (const course of group.courses) {
      const updated = await store.updateCourse(userId, course.id, { termId: term.id });
      if (updated !== null) assigned += 1;
    }
  }

  log.info("terms.backfilled", { userId, terms: groups.length, courses: assigned });
}
