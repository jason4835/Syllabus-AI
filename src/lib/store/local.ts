/**
 * Local JSON-file driver -- the demo/no-key fallback.
 *
 * The whole database is one file (`.data/db.json`, gitignored) so a contributor
 * can clone, upload a syllabus and see the app work without provisioning
 * Supabase. It is deliberately dumb: correctness and durability across a dev
 * server restart matter here, throughput does not.
 *
 * Server-only.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  Assessment,
  Course,
  ParsedSyllabus,
  User,
} from "@/lib/types";
import type { CalendarLink, Store, UserUpsert } from "@/lib/store";

interface CalendarLinkRecord extends CalendarLink {
  assessmentId: string;
  updatedAt: string;
}

interface Database {
  users: User[];
  courses: Course[];
  assessments: Assessment[];
  calendarLinks: CalendarLinkRecord[];
}

const DATA_DIR = path.join(process.cwd(), ".data");
const DB_PATH = path.join(DATA_DIR, "db.json");

function emptyDatabase(): Database {
  return { users: [], courses: [], assessments: [], calendarLinks: [] };
}

/**
 * Tolerant of a truncated or hand-edited file: a corrupt demo database should
 * degrade to "empty" rather than crash every route that touches storage.
 */
async function readDatabase(): Promise<Database> {
  let raw: string;
  try {
    raw = await readFile(DB_PATH, "utf8");
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
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DB_PATH}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(db, null, 2)}\n`, "utf8");
  await rename(tmp, DB_PATH);
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
  };
}
