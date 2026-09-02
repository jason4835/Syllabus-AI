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
import { notionSessionLinkPrefix } from "@/lib/store";

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
      users: Array.isArray(shape.users) ? (shape.users as User[]) : [],
      courses: Array.isArray(shape.courses) ? (shape.courses as Course[]) : [],
      assessments: Array.isArray(shape.assessments)
        ? (shape.assessments as Assessment[])
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
          notes: a.notes,
        }));

        db.courses.push(course);
        db.assessments.push(...assessments);
        return { course: clone(course), assessments: clone(assessments) };
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
