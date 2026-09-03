/**
 * Local JSON-file driver -- the demo/no-key fallback, and a legitimate small
 * production store when it is pointed at durable storage.
 *
 * The whole database is one file (`.data/db.json`, gitignored) so a contributor
 * can clone, upload a syllabus and see the app work without provisioning
 * Supabase. It is deliberately dumb: correctness and durability across a
 * restart matter here, throughput does not.
 *
 * `DATA_DIR` overrides where that file lives, which is what makes a mounted
 * volume (Railway, Fly, a Docker bind mount) work: point it at the mount and
 * the data outlives the container. Without a volume the default is inside the
 * deployment and every redeploy starts empty -- fine for a demo, silent data
 * loss for anything else.
 *
 * One writer only. This is a single file guarded by an in-process lock, so it
 * assumes ONE instance. Two replicas sharing a volume would overwrite each
 * other; scale past that and it is time for Postgres.
 *
 * Server-only.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  Assessment,
  Course,
  NotionConnection,
  NotionLink,
  ParsedSyllabus,
  User,
} from "@/lib/types";
import type { CalendarLink, Store, UserUpsert } from "@/lib/store";
import {
  isFeedTokenShaped,
  newCalendarFeedToken,
  notionSessionLinkPrefix,
} from "@/lib/store";

interface CalendarLinkRecord extends CalendarLink {
  assessmentId: string;
  updatedAt: string;
}

interface Database {
  users: User[];
  courses: Course[];
  assessments: Assessment[];
  calendarLinks: CalendarLinkRecord[];
  notionConnections: NotionConnection[];
  notionLinks: NotionLink[];
}

/**
 * Resolved per call rather than captured at module load, so a test (or a
 * platform that injects env late) is not stuck with whatever was set at import.
 */
function dataDir(): string {
  const configured = (process.env.DATA_DIR ?? "").trim();
  // A relative DATA_DIR is resolved against cwd, so "./data" behaves sanely
  // while "/data" (the usual mount point) is taken literally.
  return configured ? path.resolve(configured) : path.join(process.cwd(), ".data");
}

function dbPath(): string {
  return path.join(dataDir(), "db.json");
}

function emptyDatabase(): Database {
  return {
    users: [],
    courses: [],
    assessments: [],
    calendarLinks: [],
    notionConnections: [],
    notionLinks: [],
  };
}

/**
 * Fills in fields added after a row was written.
 *
 * The per-key `Array.isArray` checks below are the migration story for whole
 * collections; this is the same idea one level down, for a key added to an
 * existing row. A `db.json` written before `reviewedAt` existed has assessments
 * without it, and `undefined` is not `null`: it vanishes from the JSON the API
 * returns, so `needsReview()` and the UI would be reading a missing property
 * rather than "never reviewed". Normalising on read keeps every row that leaves
 * this module a complete `Assessment`.
 */
function normalizeAssessment(row: Assessment): Assessment {
  return { ...row, reviewedAt: row.reviewedAt ?? null };
}

/**
 * Same idea for courses: a row written before `noClass` existed has no such
 * key, and `undefined` would reach the calendar layer as "not an array" rather
 * than "this class has no breaks".
 */
function normalizeCourse(row: Course): Course {
  return { ...row, noClass: Array.isArray(row.noClass) ? row.noClass : [] };
}

/** And for users: rows predating `timezone`/`calendarFeedToken` read back as null. */
function normalizeUser(row: User): User {
  return {
    ...row,
    timezone: row.timezone ?? null,
    calendarFeedToken: row.calendarFeedToken ?? null,
  };
}

/**
 * Tolerant of a truncated or hand-edited file: a corrupt demo database should
 * degrade to "empty" rather than crash every route that touches storage.
 *
 * Per-key `Array.isArray` checks double as the migration story: a file written
 * before a collection existed simply has no such key, and reading it back gives
 * an empty array instead of `undefined` blowing up the first `.filter` call.
 */
async function readDatabase(): Promise<Database> {
  let raw: string;
  try {
    raw = await readFile(dbPath(), "utf8");
  } catch {
    return emptyDatabase();
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return emptyDatabase();
    const shape = parsed as Partial<Record<keyof Database, unknown>>;
    return {
      users: Array.isArray(shape.users)
        ? (shape.users as User[]).map(normalizeUser)
        : [],
      courses: Array.isArray(shape.courses)
        ? (shape.courses as Course[]).map(normalizeCourse)
        : [],
      assessments: Array.isArray(shape.assessments)
        ? (shape.assessments as Assessment[]).map(normalizeAssessment)
        : [],
      calendarLinks: Array.isArray(shape.calendarLinks)
        ? (shape.calendarLinks as CalendarLinkRecord[])
        : [],
      notionConnections: Array.isArray(shape.notionConnections)
        ? (shape.notionConnections as NotionConnection[])
        : [],
      notionLinks: Array.isArray(shape.notionLinks)
        ? (shape.notionLinks as NotionLink[])
        : [],
    };
  } catch {
    return emptyDatabase();
  }
}

/**
 * Write to a sibling temp file and rename: a crash mid-write leaves the previous
 * database intact instead of a half-written JSON blob.
 */
async function writeDatabase(db: Database): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  const tmp = `${dbPath()}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(db, null, 2)}\n`, "utf8");
  await rename(tmp, dbPath());
}

/**
 * Every operation -- read or write -- runs through one promise chain, so two
 * concurrent requests can never interleave a read-modify-write within this
 * process. `catch` on both settle paths keeps one failed op from poisoning the
 * queue for everything after it.
 */
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function readOnly<T>(fn: (db: Database) => T): Promise<T> {
  return serialize(async () => fn(await readDatabase()));
}

function mutate<T>(fn: (db: Database) => T): Promise<T> {
  return serialize(async () => {
    const db = await readDatabase();
    const result = fn(db);
    await writeDatabase(db);
    return result;
  });
}

/** Defensive copy: callers must not be able to mutate the on-disk snapshot. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Undated items sort last -- a syllabus item with no date is not "urgent". */
function byDueDate(a: Assessment, b: Assessment): number {
  if (a.dueDate === b.dueDate) return a.title.localeCompare(b.title);
  if (a.dueDate === null) return 1;
  if (b.dueDate === null) return -1;
  return a.dueDate < b.dueDate ? -1 : 1;
}

/**
 * Does this Notion link belong to a course that is going away?
 *
 * Course and assessment links match by id. Session links cannot: study sessions
 * are generated, never stored, so there is nothing to look their ids up in --
 * they are matched by the planner's `sb_<assessmentId>_<n>` prefix instead.
 */
function isLinkOrphanedByCourse(
  link: NotionLink,
  userId: string,
  courseId: string,
  assessmentIds: Set<string>,
): boolean {
  // Scoped to the owner as well as the ids: the session match below is a
  // prefix test, and only the course's own user can have links for it.
  if (link.userId !== userId) return false;
  if (link.kind === "course") return link.entityId === courseId;
  if (link.kind === "assessment") return assessmentIds.has(link.entityId);
  return [...assessmentIds].some((id) =>
    link.entityId.startsWith(notionSessionLinkPrefix(id)),
  );
}

/**
 * How many rows still belong to `userId` -- the post-condition `deleteUser`
 * checks itself against.
 *
 * `deleteUser` promises to be total, and a promise kept only by reading the
 * code stops being true the first time somebody adds a collection to
 * `Database`. Counting afterwards turns that into a failure someone sees:
 * throwing inside `mutate` aborts before the file is written, so a botched
 * delete leaves the database exactly as it was instead of half-erased.
 *
 * Course and assessment ids are passed in because their rows are the join
 * path: once the courses are gone there is nothing left to prove an assessment
 * (or a calendar link) was ever the user's.
 */
function userRowsRemaining(
  db: Database,
  userId: string,
  courseIds: Set<string>,
  assessmentIds: Set<string>,
): number {
  return (
    db.users.filter((u) => u.id === userId).length +
    db.courses.filter((c) => c.userId === userId || courseIds.has(c.id)).length +
    db.assessments.filter(
      (a) => courseIds.has(a.courseId) || assessmentIds.has(a.id),
    ).length +
    db.calendarLinks.filter((l) => assessmentIds.has(l.assessmentId)).length +
    db.notionConnections.filter((c) => c.userId === userId).length +
    db.notionLinks.filter((l) => l.userId === userId).length
  );
}

export function createLocalStore(): Store {
  /** Ownership gate shared by every assessment path that takes a userId. */
  function ownedCourseIds(db: Database, userId: string): Set<string> {
    return new Set(
      db.courses.filter((c) => c.userId === userId).map((c) => c.id),
    );
  }

  return {
    async getUser(id) {
      return readOnly((db) => {
        const found = db.users.find((u) => u.id === id);
        return found ? clone(found) : null;
      });
    },

    async getUserByEmail(email) {
      const needle = email.toLowerCase();
      return readOnly((db) => {
        const found = db.users.find((u) => u.email.toLowerCase() === needle);
        return found ? clone(found) : null;
      });
    },

    async upsertUser(u: UserUpsert) {
      return mutate((db) => {
        const index = db.users.findIndex((existing) => existing.id === u.id);
        const existing = index === -1 ? undefined : db.users[index];
        const next: User = {
          id: u.id,
          email: u.email,
          name: u.name,
          picture: u.picture,
          googleRefreshToken: u.googleRefreshToken,
          // Absent key means "keep what is stored": the sign-in flow does not
          // know the browser's zone, and must not clear one already reported.
          timezone:
            u.timezone !== undefined ? u.timezone : (existing?.timezone ?? null),
          // Same rule, and it matters more: dropping the feed token here would
          // break every calendar app already subscribed to that URL, on every
          // sign-in. The callers that upsert a user do not know it.
          calendarFeedToken:
            u.calendarFeedToken !== undefined
              ? u.calendarFeedToken
              : (existing?.calendarFeedToken ?? null),
          // First write wins: re-authenticating must not reset the join date.
          createdAt:
            existing?.createdAt ?? u.createdAt ?? new Date().toISOString(),
        };
        if (index === -1) db.users.push(next);
        else db.users[index] = next;
        return clone(next);
      });
    },

    async setUserTimezone(userId, timezone) {
      return mutate((db) => {
        const index = db.users.findIndex((existing) => existing.id === userId);
        if (index === -1) return null;
        const next: User = { ...db.users[index], timezone };
        db.users[index] = next;
        return clone(next);
      });
    },

    async ensureCalendarFeedToken(userId) {
      return mutate((db) => {
        const index = db.users.findIndex((existing) => existing.id === userId);
        if (index === -1) return null;
        const current = db.users[index].calendarFeedToken;
        // Read-or-mint inside the same serialized write, so two concurrent
        // requests cannot each mint a token and leave one subscriber's URL
        // dead the moment it was handed out.
        if (current) return current;
        const token = newCalendarFeedToken();
        db.users[index] = { ...db.users[index], calendarFeedToken: token };
        return token;
      });
    },

    async resetCalendarFeedToken(userId) {
      return mutate((db) => {
        const index = db.users.findIndex((existing) => existing.id === userId);
        if (index === -1) return null;
        const token = newCalendarFeedToken();
        db.users[index] = { ...db.users[index], calendarFeedToken: token };
        return token;
      });
    },

    async getUserByFeedToken(token) {
      // Junk never reaches the data: an empty or truncated token is rejected
      // before the lookup, and the comparison below is whole-value equality --
      // never `startsWith`, which would let a guessed prefix find a real row.
      if (!isFeedTokenShaped(token)) return null;
      const needle = token.trim();
      return readOnly((db) => {
        const found = db.users.find((u) => u.calendarFeedToken === needle);
        return found ? clone(found) : null;
      });
    },

    async deleteUser(userId) {
      // One mutate, so the whole account disappears in a single atomic write:
      // a crash between two smaller writes would leave an account that is
      // half-deleted and unreachable through any route.
      return mutate((db) => {
        const index = db.users.findIndex((u) => u.id === userId);
        const existed = index !== -1;

        // Collected before anything is removed: assessments hang off courses
        // and calendar links off assessments, so once the courses are gone
        // their descendants have nothing left to be matched by.
        const courseIds = new Set(
          db.courses.filter((c) => c.userId === userId).map((c) => c.id),
        );
        const assessmentIds = new Set(
          db.assessments
            .filter((a) => courseIds.has(a.courseId))
            .map((a) => a.id),
        );

        db.courses = db.courses.filter((c) => c.userId !== userId);
        db.assessments = db.assessments.filter(
          (a) => !courseIds.has(a.courseId),
        );
        db.calendarLinks = db.calendarLinks.filter(
          (l) => !assessmentIds.has(l.assessmentId),
        );
        // Every Notion link carries its owner, session links included, so this
        // needs none of deleteCourse's prefix matching: the whole user goes,
        // not one course's worth of links. The Notion pages themselves stay
        // (docs/NOTION.md) -- what goes is our pointer to them.
        db.notionLinks = db.notionLinks.filter((l) => l.userId !== userId);
        db.notionConnections = db.notionConnections.filter(
          (c) => c.userId !== userId,
        );
        if (existed) db.users.splice(index, 1);

        const leftover = userRowsRemaining(db, userId, courseIds, assessmentIds);
        if (leftover > 0) {
          // Aborts the write, so the caller gets an error and the database is
          // untouched -- far better than reporting success over a half-erased
          // account.
          throw new Error(
            `[store/local] deleteUser is not total: ${leftover} row(s) still belong to this user`,
          );
        }

        // Reported rather than assumed, so the route can answer "no such
        // account" instead of confirming a deletion that never happened.
        return existed;
      });
    },

    async listCourses(userId) {
      return readOnly((db) =>
        clone(
          db.courses
            .filter((c) => c.userId === userId)
            .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
        ),
      );
    },

    async getCourse(id) {
      return readOnly((db) => {
        const found = db.courses.find((c) => c.id === id);
        return found ? clone(found) : null;
      });
    },

    async createCourse(userId, parsed: ParsedSyllabus) {
      return mutate((db) => {
        const courseId = randomUUID();
        const course: Course = {
          id: courseId,
          userId,
          code: parsed.course.code,
          title: parsed.course.title,
          instructor: parsed.course.instructor,
          term: parsed.course.term,
          startDate: parsed.course.startDate,
          endDate: parsed.course.endDate,
          meetingTimes: clone(parsed.course.meetingTimes ?? []),
          noClass: clone(parsed.course.noClass ?? []),
          gradeWeights: clone(parsed.course.gradeWeights ?? []),
          policies: clone(parsed.course.policies ?? []),
          createdAt: new Date().toISOString(),
        };

        const assessments: Assessment[] = parsed.assessments.map((a) => ({
          id: randomUUID(),
          courseId,
          title: a.title,
          kind: a.kind,
          dueDate: a.dueDate,
          dueTime: a.dueTime,
          weightPercent: a.weightPercent,
          sourceText: a.sourceText,
          confidence: a.confidence,
          // Freshly extracted: nobody has looked at it yet. The parsers set
          // this to null, and it is carried rather than assumed so a future
          // caller cannot silently lose it.
          reviewedAt: a.reviewedAt,
          notes: a.notes,
        }));

        db.courses.push(course);
        db.assessments.push(...assessments);
        return { course: clone(course), assessments: clone(assessments) };
      });
    },

    async updateCourse(userId, id, patch) {
      return mutate((db) => {
        const index = db.courses.findIndex(
          (c) => c.id === id && c.userId === userId,
        );
        // Missing and not-yours are indistinguishable, exactly as in
        // deleteCourse: a wrong userId must not confirm that an id exists.
        if (index === -1) return null;

        const current = db.courses[index];
        // id, userId and createdAt are identity, not data. Spreading the patch
        // over them and then restoring them keeps a stray key in the patch
        // object from re-parenting a course.
        const next: Course = {
          ...current,
          ...patch,
          id: current.id,
          userId: current.userId,
          createdAt: current.createdAt,
        };
        db.courses[index] = next;
        return clone(next);
      });
    },

    async deleteCourse(userId, courseId) {
      return mutate((db) => {
        const index = db.courses.findIndex(
          (c) => c.id === courseId && c.userId === userId,
        );
        // Missing and not-yours are indistinguishable on purpose: a wrong userId
        // must not confirm that a course id exists.
        if (index === -1) return false;

        db.courses.splice(index, 1);
        const orphanIds = new Set(
          db.assessments.filter((a) => a.courseId === courseId).map((a) => a.id),
        );
        db.assessments = db.assessments.filter((a) => a.courseId !== courseId);
        db.calendarLinks = db.calendarLinks.filter(
          (l) => !orphanIds.has(l.assessmentId),
        );
        // The Notion pages themselves are deliberately left in place (see
        // docs/NOTION.md); what goes is our pointer to them, so a course
        // re-uploaded later builds fresh pages instead of patching pages that
        // describe a deleted class.
        db.notionLinks = db.notionLinks.filter(
          (l) => !isLinkOrphanedByCourse(l, userId, courseId, orphanIds),
        );
        return true;
      });
    },

    async listAssessments(userId) {
      return readOnly((db) => {
        const owned = ownedCourseIds(db, userId);
        return clone(
          db.assessments.filter((a) => owned.has(a.courseId)).sort(byDueDate),
        );
      });
    },

    async createAssessment(userId, courseId, assessment) {
      return mutate((db) => {
        // Ownership is proven against the course, since that is where an
        // assessment's owner lives. Checked before the push, so a stranger's
        // course id writes nothing.
        const owns = db.courses.some(
          (c) => c.id === courseId && c.userId === userId,
        );
        if (!owns) return null;

        const next: Assessment = {
          id: randomUUID(),
          courseId,
          title: assessment.title,
          kind: assessment.kind,
          dueDate: assessment.dueDate,
          dueTime: assessment.dueTime,
          weightPercent: assessment.weightPercent,
          sourceText: assessment.sourceText,
          confidence: assessment.confidence,
          reviewedAt: assessment.reviewedAt,
          notes: assessment.notes,
        };
        db.assessments.push(next);
        return clone(next);
      });
    },

    async updateAssessment(userId, id, patch) {
      return mutate((db) => {
        const owned = ownedCourseIds(db, userId);
        const index = db.assessments.findIndex(
          (a) => a.id === id && owned.has(a.courseId),
        );
        if (index === -1) return null;

        const current = db.assessments[index];
        // id and courseId are identity, not data -- a patch may not move an
        // assessment into another course (potentially another user's).
        const next: Assessment = {
          ...current,
          ...patch,
          id: current.id,
          courseId: current.courseId,
        };
        db.assessments[index] = next;
        return clone(next);
      });
    },

    async deleteAssessment(userId, id) {
      return mutate((db) => {
        const owned = ownedCourseIds(db, userId);
        const index = db.assessments.findIndex(
          (a) => a.id === id && owned.has(a.courseId),
        );
        // Same silence as deleteCourse: not-yours reads as not-there.
        if (index === -1) return false;

        db.assessments.splice(index, 1);
        db.calendarLinks = db.calendarLinks.filter(
          (l) => l.assessmentId !== id,
        );
        // deleteCourse's cascade, narrowed to one item: the assessment's own
        // link by id, and its study sessions' links by the planner's prefix,
        // since generated sessions have no row to join against. Scoped to the
        // owner because that prefix test is not an id match. The Notion pages
        // themselves stay put (docs/NOTION.md) -- what goes is our pointer.
        const sessionPrefix = notionSessionLinkPrefix(id);
        db.notionLinks = db.notionLinks.filter((l) => {
          if (l.userId !== userId) return true;
          if (l.kind === "assessment") return l.entityId !== id;
          if (l.kind === "session") return !l.entityId.startsWith(sessionPrefix);
          return true;
        });
        return true;
      });
    },

    async getCalendarLink(assessmentId) {
      return readOnly((db) => {
        const found = db.calendarLinks.find(
          (l) => l.assessmentId === assessmentId,
        );
        return found
          ? { googleEventId: found.googleEventId, calendarId: found.calendarId }
          : null;
      });
    },

    async setCalendarLink(assessmentId, googleEventId, calendarId) {
      await mutate((db) => {
        const record: CalendarLinkRecord = {
          assessmentId,
          googleEventId,
          calendarId,
          updatedAt: new Date().toISOString(),
        };
        const index = db.calendarLinks.findIndex(
          (l) => l.assessmentId === assessmentId,
        );
        if (index === -1) db.calendarLinks.push(record);
        else db.calendarLinks[index] = record;
        return undefined;
      });
    },

    async getNotionConnection(userId) {
      return readOnly((db) => {
        const found = db.notionConnections.find((c) => c.userId === userId);
        return found ? clone(found) : null;
      });
    },

    async setNotionConnection(conn) {
      return mutate((db) => {
        const next = clone(conn);
        const index = db.notionConnections.findIndex(
          (c) => c.userId === conn.userId,
        );
        // Whole-record replace, not a merge: the callers that write this (the
        // OAuth callback, the hub builder, the 401 handler) each hold the full
        // connection, and a merge would quietly keep stale hub ids alive after
        // a reconnect to a different workspace.
        if (index === -1) db.notionConnections.push(next);
        else db.notionConnections[index] = next;
        return clone(next);
      });
    },

    async deleteNotionConnection(userId) {
      return mutate((db) => {
        const before = db.notionConnections.length + db.notionLinks.length;
        db.notionConnections = db.notionConnections.filter(
          (c) => c.userId !== userId,
        );
        // The links are worthless without the token that created them, and
        // keeping them would make a later reconnect patch pages in a workspace
        // the user may no longer be using.
        db.notionLinks = db.notionLinks.filter((l) => l.userId !== userId);
        return before !== db.notionConnections.length + db.notionLinks.length;
      });
    },

    async getNotionLink(kind, entityId) {
      return readOnly((db) => {
        const found = db.notionLinks.find(
          (l) => l.kind === kind && l.entityId === entityId,
        );
        return found ? clone(found) : null;
      });
    },

    async setNotionLink(link) {
      await mutate((db) => {
        const index = db.notionLinks.findIndex(
          (l) => l.kind === link.kind && l.entityId === link.entityId,
        );
        // (kind, entityId) is the key, so re-linking after Notion 404s on a
        // page the user deleted overwrites the dead page id in place.
        if (index === -1) db.notionLinks.push(clone(link));
        else db.notionLinks[index] = clone(link);
        return undefined;
      });
    },

    async listNotionLinks(userId) {
      return readOnly((db) =>
        clone(db.notionLinks.filter((l) => l.userId === userId)),
      );
    },
  };
}
