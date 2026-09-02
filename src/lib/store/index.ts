/**
 * Storage facade for Syllabus AI.
 *
 * Routes never talk to Supabase or the filesystem directly: they talk to
 * `store`. That keeps the demo path (no keys, local JSON file) and the hosted
 * path (Supabase) behind one contract, so a route written against one works
 * unchanged against the other.
 *
 * Server-only. Nothing here may be imported from a client component.
 */

import type {
  Assessment,
  Course,
  NotionConnection,
  NotionLink,
  NotionLinkKind,
  ParsedSyllabus,
  User,
} from "@/lib/types";
import { createLocalStore } from "@/lib/store/local";
import { createSupabaseStore } from "@/lib/store/supabase";

/**
 * What `upsertUser` accepts: `createdAt` is assigned on first write.
 *
 * `timezone` is optional because nothing in the sign-in flow knows it -- only
 * the browser does, and it arrives later on its own route. Omitting the key
 * therefore means "leave the stored zone alone"; passing an explicit `null`
 * clears it. Without that distinction every re-authentication would wipe a
 * zone the user had already reported.
 */
export type UserUpsert = Omit<User, "createdAt" | "timezone"> & {
  createdAt?: string;
  timezone?: string | null;
};

/**
 * A Google Calendar event we already created for an assessment. Persisting it
 * is what makes a re-sync an update instead of a duplicate event.
 */
export interface CalendarLink {
  googleEventId: string;
  calendarId: string;
}

/**
 * Prefix of every Notion link id belonging to one assessment's study sessions.
 *
 * Study sessions are the one synced entity that is never persisted: the planner
 * mints them on demand as `sb_<assessmentId>_<n>` (src/lib/plan/study.ts), so
 * when a course is deleted there is no row to join against and their links can
 * only be found by matching that prefix. Both drivers share this helper so the
 * two cascades cannot drift apart from each other or from the planner.
 */
export function notionSessionLinkPrefix(assessmentId: string): string {
  return `sb_${assessmentId}_`;
}

export interface Store {
  getUser(id: string): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;
  upsertUser(u: UserUpsert): Promise<User>;
  /**
   * Records the IANA zone the browser reported. Separate from `upsertUser` so
   * the one caller that actually knows the zone cannot accidentally overwrite
   * the rest of the profile. Null when the user does not exist.
   */
  setUserTimezone(userId: string, timezone: string): Promise<User | null>;

  listCourses(userId: string): Promise<Course[]>;
  getCourse(id: string): Promise<Course | null>;
  createCourse(
    userId: string,
    parsed: ParsedSyllabus,
  ): Promise<{ course: Course; assessments: Assessment[] }>;
  deleteCourse(userId: string, courseId: string): Promise<boolean>;

  listAssessments(userId: string): Promise<Assessment[]>;
  updateAssessment(
    userId: string,
    id: string,
    patch: Partial<Assessment>,
  ): Promise<Assessment | null>;

  getCalendarLink(assessmentId: string): Promise<CalendarLink | null>;
  setCalendarLink(
    assessmentId: string,
    googleEventId: string,
    calendarId: string,
  ): Promise<void>;

  getNotionConnection(userId: string): Promise<NotionConnection | null>;
  /** Upsert keyed by userId. Replaces the whole record. */
  setNotionConnection(conn: NotionConnection): Promise<NotionConnection>;
  /** Also removes that user's notion links. False when there was nothing to delete. */
  deleteNotionConnection(userId: string): Promise<boolean>;

  getNotionLink(
    kind: NotionLinkKind,
    entityId: string,
  ): Promise<NotionLink | null>;
  /** Upsert keyed by (kind, entityId): a re-link after a 404 must update in place, never duplicate. */
  setNotionLink(link: NotionLink): Promise<void>;
  listNotionLinks(userId: string): Promise<NotionLink[]>;
}

let instance: Store | null = null;

/**
 * Resolved lazily rather than at module load: Next evaluates modules during the
 * build, when the deployment's env vars are not necessarily present yet.
 */
export function getStore(): Store {
  if (instance) return instance;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (url && serviceRoleKey) {
    instance = createSupabaseStore(url, serviceRoleKey);
    console.log("[store] driver=supabase");
  } else {
    instance = createLocalStore();
    const dir = (process.env.DATA_DIR ?? "").trim();
    // Say plainly whether this data survives a redeploy. "driver=local" alone
    // reads the same whether it is a durable volume or a disk about to vanish.
    console.log(
      dir
        ? `[store] driver=local dir=${dir} (persistent volume) -- set SUPABASE_* to use Postgres instead`
        : "[store] driver=local dir=.data (EPHEMERAL -- lost on redeploy) -- mount a volume and set DATA_DIR, or set SUPABASE_*",
    );
  }

  return instance;
}

/**
 * Delegating literal rather than a Proxy so the driver choice still happens on
 * first use, but callers get plain, fully typed methods.
 */
export const store: Store = {
  getUser: (id) => getStore().getUser(id),
  getUserByEmail: (email) => getStore().getUserByEmail(email),
  upsertUser: (u) => getStore().upsertUser(u),
  setUserTimezone: (userId, timezone) =>
    getStore().setUserTimezone(userId, timezone),
  listCourses: (userId) => getStore().listCourses(userId),
  getCourse: (id) => getStore().getCourse(id),
  createCourse: (userId, parsed) => getStore().createCourse(userId, parsed),
  deleteCourse: (userId, courseId) => getStore().deleteCourse(userId, courseId),
  listAssessments: (userId) => getStore().listAssessments(userId),
  updateAssessment: (userId, id, patch) =>
    getStore().updateAssessment(userId, id, patch),
  getCalendarLink: (assessmentId) => getStore().getCalendarLink(assessmentId),
  setCalendarLink: (assessmentId, googleEventId, calendarId) =>
    getStore().setCalendarLink(assessmentId, googleEventId, calendarId),
  getNotionConnection: (userId) => getStore().getNotionConnection(userId),
  setNotionConnection: (conn) => getStore().setNotionConnection(conn),
  deleteNotionConnection: (userId) => getStore().deleteNotionConnection(userId),
  getNotionLink: (kind, entityId) => getStore().getNotionLink(kind, entityId),
  setNotionLink: (link) => getStore().setNotionLink(link),
  listNotionLinks: (userId) => getStore().listNotionLinks(userId),
};

export default store;
