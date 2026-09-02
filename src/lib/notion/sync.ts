/**
 * Notion sync -- the mirror image of `@/lib/google/calendar`.
 *
 * The shape is copied deliberately: `syncToNotion(userId, opts)` takes the
 * same options, honours the same `dryRun` contract, collects per-item failures
 * in `errors[]` instead of aborting, and returns one result envelope. Anyone
 * who has read the calendar sync can read this one.
 *
 * Three rules do the work:
 *
 * 1. **Plan first, then execute.** The full list of intended operations is
 *    built up front from the store's link table, and the *same* loop then
 *    walks it whether or not this is a dry run -- a dry run only skips the
 *    network calls. That is what makes demo mode's counts truthful: there is
 *    no second code path that could drift.
 *
 * 2. **Idempotent by construction.** A link means `pages.update`; no link
 *    means `pages.create` plus a new link. A 404 on update (the student
 *    deleted the page) means create fresh and re-link. Syncing twice never
 *    duplicates.
 *
 * 3. **Bodies are written once.** The class-page body is appended only when
 *    the Courses row is created. Re-writing it would mean deleting and
 *    re-appending blocks around whatever the student has added below the
 *    divider, which is exactly how software loses somebody's notes. Dates that
 *    move are corrected in the Assignments *properties*, and the body's
 *    schedule links to those rows, so the page stays a correct table of
 *    contents without being touched.
 *
 * Server-only.
 */

import type { PageObjectResponse, SearchResponse } from "@notionhq/client";
import {
  assessmentProperties,
  buildCoursePageBlocks,
  chunkBlocks,
  courseProperties,
  courseTitle,
  sessionProperties,
  type PageProperties,
} from "@/lib/notion/blocks";
import {
  describeNotionError,
  getNotionClient,
  isNotFound,
  isRevoked,
  type NotionClient,
} from "@/lib/notion/client";
import { ensureWorkspace } from "@/lib/notion/workspace";
import { log, logApiError } from "@/lib/log";
import { store } from "@/lib/store";
import type {
  Assessment,
  Course,
  NotionConnection,
  NotionLink,
  NotionLinkKind,
  NotionSyncResult,
  StudyBlock,
} from "@/lib/types";

export interface NotionSyncOptions {
  courses: Course[];
  assessments: Assessment[];
  studyBlocks?: StudyBlock[];
  /** Compute the plan and the counts without touching the network. Powers demo mode. */
  dryRun?: boolean;
}

/** A page the integration can see and could host the hub. */
export interface NotionParentCandidate {
  id: string;
  title: string;
  url: string;
}

/* -------------------------------------------------------------------------- */
/* Parent selection                                                            */
/* -------------------------------------------------------------------------- */

/** How many search results to consider. A picker longer than this is unusable anyway. */
const MAX_PARENT_CANDIDATES = 50;

function isFullPageResult(
  result: SearchResponse["results"][number],
): result is PageObjectResponse {
  return result.object === "page" && "properties" in result;
}

/** A page's own title, from whichever property is the title one. */
function titleOf(page: PageObjectResponse): string {
  for (const value of Object.values(page.properties)) {
    if (value.type !== "title") continue;
    const text = value.title.map((t) => t.plain_text).join("").trim();
    if (text) return text;
  }
  return "Untitled";
}

/**
 * Pages the user shared with the integration at consent time.
 *
 * Database *rows* are pages too and come back from `search`, but a hub cannot
 * live inside someone's database, so only top-level and nested ordinary pages
 * are offered. Showing an impossible choice and failing on selection would be
 * worse than showing a shorter list.
 */
export async function listParentCandidates(
  conn: NotionConnection,
): Promise<NotionParentCandidate[]> {
  const client = getNotionClient(conn.accessToken);
  const candidates: NotionParentCandidate[] = [];
  let cursor: string | undefined;

  do {
    const page: SearchResponse = await client.search({
      filter: { property: "object", value: "page" },
      sort: { timestamp: "last_edited_time", direction: "descending" },
      page_size: 100,
      start_cursor: cursor,
    });

    for (const result of page.results) {
      if (!isFullPageResult(result)) continue;
      if (result.in_trash) continue;
      if (result.parent.type !== "page_id" && result.parent.type !== "workspace") continue;
      candidates.push({ id: result.id, title: titleOf(result), url: result.url });
      if (candidates.length >= MAX_PARENT_CANDIDATES) return candidates;
    }

    cursor = page.next_cursor ?? undefined;
  } while (cursor);

  return candidates;
}

/**
 * Points the connection at a page and builds the workspace under it.
 *
 * Status only becomes `connected` once the hub actually exists -- otherwise a
 * failed build would leave the dashboard claiming everything is fine while
 * every sync errors.
 */
export async function chooseParent(
  userId: string,
  pageId: string,
): Promise<NotionConnection> {
  const conn = await store.getNotionConnection(userId);
  if (!conn) {
    throw new Error(`No Notion connection for user ${userId}. Complete the OAuth flow first.`);
  }

  const built = await ensureWorkspace({ ...conn, parentPageId: pageId });
  const saved = await store.setNotionConnection({ ...built, status: "connected" });
  log.info("notion.parent_chosen", { userId, hubPageId: saved.hubPageId });
  return saved;
}

/* -------------------------------------------------------------------------- */
/* Planning -- shared by the real and dry-run paths                            */
/* -------------------------------------------------------------------------- */

interface PlannedOp {
  kind: NotionLinkKind;
  /** Our id for the entity. The key the link table and this planner agree on. */
  entityId: string;
  /** Course this op belongs to, so a failed course can skip its dependants. */
  courseId: string;
  /** Human label for `errors[]`. Never contains a token or a page id. */
  label: string;
  /** Existing Notion page, or null when this is a create. */
  link: NotionLink | null;
  /** Built lazily at execution time: relations need page ids the plan lacks. */
  properties: (ctx: RelationContext, initial: boolean) => PageProperties;
}

/** Page ids discovered as the run proceeds, for relation properties. */
interface RelationContext {
  coursePages: Map<string, string>;
  assessmentPages: Map<string, string>;
  /** courseId -> page URL, for the result's "Open in Notion" links. */
  courseUrls: Map<string, string>;
}

interface SyncPlan {
  courses: PlannedOp[];
  assessments: PlannedOp[];
  sessions: PlannedOp[];
  errors: string[];
}

/**
 * Turns courses + assessments + study blocks into the exact list of Notion
 * writes we intend to make. The only I/O is the link lookup, which a dry run
 * needs too -- it is what decides create versus update.
 */
async function planOps(opts: NotionSyncOptions): Promise<SyncPlan> {
  const errors: string[] = [];
  const courseById = new Map(opts.courses.map((c) => [c.id, c]));

  const courses: PlannedOp[] = [];
  for (const course of opts.courses) {
    courses.push({
      kind: "course",
      entityId: course.id,
      courseId: course.id,
      label: courseTitle(course),
      link: await store.getNotionLink("course", course.id),
      properties: () => courseProperties(course),
    });
  }

  const assessments: PlannedOp[] = [];
  for (const a of opts.assessments) {
    const course = courseById.get(a.courseId) ?? null;
    assessments.push({
      kind: "assessment",
      entityId: a.id,
      courseId: a.courseId,
      label: course ? `${course.code}: ${a.title}` : a.title,
      link: await store.getNotionLink("assessment", a.id),
      properties: (ctx, initial) =>
        assessmentProperties(a, ctx.coursePages.get(a.courseId) ?? null, { initial }),
    });
  }

  const sessions: PlannedOp[] = [];
  for (const b of opts.studyBlocks ?? []) {
    const course = courseById.get(b.courseId) ?? null;
    sessions.push({
      kind: "session",
      entityId: b.id,
      courseId: b.courseId,
      label: course ? `${course.code}: ${b.title}` : b.title,
      link: await store.getNotionLink("session", b.id),
      properties: (ctx, initial) =>
        sessionProperties(
          b,
          ctx.coursePages.get(b.courseId) ?? null,
          ctx.assessmentPages.get(b.assessmentId) ?? null,
          { initial },
        ),
    });
  }

  return { courses, assessments, sessions, errors };
}

/* -------------------------------------------------------------------------- */
/* Execution                                                                   */
/* -------------------------------------------------------------------------- */

/** The data source a row of each kind lives in. */
function dataSourceFor(conn: NotionConnection, kind: NotionLinkKind): string | null {
  if (kind === "course") return conn.coursesDbId;
  if (kind === "assessment") return conn.assignmentsDbId;
  return conn.sessionsDbId;
}

type OpOutcome = "created" | "updated";

/**
 * Which counter in the result an op bumps. `NotionSyncResult` says
 * "assignments" where our domain says "assessment", so the mapping is spelled
 * out once rather than re-derived at each call site.
 */
const COUNTER_FOR: Record<NotionLinkKind, "courses" | "assignments" | "sessions"> = {
  course: "courses",
  assessment: "assignments",
  session: "sessions",
};

/**
 * Applies one planned op. Returns which counter to bump, and records the page
 * id so later relations and the class-page body can point at it.
 *
 * The dry-run branch is a single `if` around the network calls rather than a
 * separate function, so the counting logic is literally the same code.
 */
async function runOp(
  op: PlannedOp,
  ctx: RelationContext,
  args: {
    client: NotionClient | null;
    conn: NotionConnection;
    userId: string;
    dryRun: boolean;
  },
): Promise<OpOutcome> {
  const { client, conn, userId, dryRun } = args;

  const remember = (pageId: string, url: string | null): void => {
    if (op.kind === "course") {
      ctx.coursePages.set(op.entityId, pageId);
      if (url) ctx.courseUrls.set(op.entityId, url);
    }
    if (op.kind === "assessment") ctx.assessmentPages.set(op.entityId, pageId);
  };

  const record = async (pageId: string, url: string | null): Promise<void> => {
    remember(pageId, url);
    await store.setNotionLink({
      userId,
      kind: op.kind,
      entityId: op.entityId,
      pageId,
      url,
    });
  };

  const create = async (): Promise<void> => {
    if (!client) return;
    const dataSourceId = dataSourceFor(conn, op.kind);
    if (!dataSourceId) {
      throw new Error("the Syllabus AI workspace is not built yet");
    }
    const page = await client.pages.create({
      // 2025-09-03: rows are created against a data source, not a database.
      parent: { type: "data_source_id", data_source_id: dataSourceId },
      properties: op.properties(ctx, true),
    });
    await record(page.id, "url" in page ? page.url : null);
  };

  if (op.link) {
    // The page already exists, so its id is known even in a dry run -- that is
    // what lets a dry run's `coursePages` be as accurate as a real run's.
    remember(op.link.pageId, op.link.url);

    if (!dryRun && client) {
      try {
        await client.pages.update({
          page_id: op.link.pageId,
          properties: op.properties(ctx, false),
        });
      } catch (err) {
        // 404: the student deleted the page. Recreate and repoint the link
        // rather than failing on every sync from here to graduation.
        if (!isNotFound(err)) throw err;
        log.info("notion.relink", { kind: op.kind, entityId: op.entityId });
        await create();
        return "created";
      }
    }
    return "updated";
  }

  if (!dryRun) await create();
  return "created";
}

/**
 * Pushes a semester into the user's Notion workspace.
 *
 * @returns counts, the hub URL and a courseId -> page URL map. Per-item
 *          failures land in `errors[]`; only a revoked token stops the run.
 */
export async function syncToNotion(
  userId: string,
  opts: NotionSyncOptions,
): Promise<NotionSyncResult> {
  const dryRun = opts.dryRun === true;

  const result: NotionSyncResult = {
    created: { courses: 0, assignments: 0, sessions: 0 },
    updated: { courses: 0, assignments: 0, sessions: 0 },
    skipped: 0,
    hubUrl: null,
    coursePages: {},
    errors: [],
  };

  let conn = await store.getNotionConnection(userId);
  result.hubUrl = conn?.hubUrl ?? null;

  // A dry run answers "what would this create", which is a question worth
  // answering *before* the student has connected anything -- it is what demo
  // mode shows. Planning needs only the link table, so an absent or half-built
  // connection is not an obstacle to it. A real run, of course, is.
  if (!dryRun) {
    if (!conn) {
      result.errors.push("Notion is not connected. Connect it from the dashboard to sync.");
      return result;
    }
    if (conn.status === "revoked") {
      result.errors.push(
        "Notion access was revoked. Reconnect the integration from the dashboard.",
      );
      return result;
    }
    if (conn.status === "needs_parent" || !conn.parentPageId) {
      result.errors.push(
        "Notion needs a page to build under. Pick one from the dashboard to finish setup.",
      );
      return result;
    }
  }

  const plan = await planOps(opts);
  result.errors.push(...plan.errors);

  let client: NotionClient | null = null;

  if (!dryRun && conn) {
    try {
      // Cheap when everything already exists; rebuilds whatever the student
      // deleted in Notion. Persisted here so the next sync skips the rebuild.
      const built = await ensureWorkspace(conn);
      conn = await store.setNotionConnection(built);
      result.hubUrl = conn.hubUrl;
      client = getNotionClient(conn.accessToken);
    } catch (err) {
      if (isRevoked(err)) return await markRevoked(userId, conn, result);
      // Nothing can be written without the databases, so this is the one
      // failure that legitimately ends the run -- reported, not thrown.
      logApiError("notion.workspace_failed", err, { userId });
      result.errors.push(
        `Notion workspace unavailable: ${describeNotionError(err, conn.accessToken)}`,
      );
      return result;
    }
  }

  const ctx: RelationContext = {
    coursePages: new Map(),
    assessmentPages: new Map(),
    courseUrls: new Map(),
  };
  const activeConn = conn;
  /** Courses whose row could not be written -- their dependants are skipped. */
  const failedCourses = new Set<string>();
  /** Courses created in *this* run: the only ones that get a page body. */
  const createdCourses: Course[] = [];
  const courseById = new Map(opts.courses.map((c) => [c.id, c]));

  const apply = async (op: PlannedOp): Promise<void> => {
    if (op.kind !== "course" && failedCourses.has(op.courseId)) {
      result.skipped += 1;
      return;
    }
    try {
      const outcome = await runOp(op, ctx, {
        client,
        // In a dry run there may be no connection at all; the placeholder is
        // never dereferenced because `client` is null.
        conn: activeConn ?? EMPTY_CONNECTION,
        userId,
        dryRun,
      });
      result[outcome][COUNTER_FOR[op.kind]] += 1;
      if (op.kind === "course" && outcome === "created") {
        const course = courseById.get(op.entityId);
        if (course) createdCourses.push(course);
      }
    } catch (err) {
      if (isRevoked(err)) throw err;
      if (op.kind === "course") failedCourses.add(op.courseId);
      result.errors.push(
        `${op.label}: ${client ? client.describeError(err) : describeLocal(err)}`,
      );
    }
  };

  try {
    // Courses first: an assignment's Course relation needs a target.
    for (const op of plan.courses) await apply(op);
    for (const op of plan.assessments) await apply(op);

    // Only now do the schedule mentions have pages to point at, which is why
    // the body is appended here rather than at course-creation time.
    if (!dryRun && client) {
      for (const course of createdCourses) {
        await appendCoursePageBody(client, course, opts.assessments, ctx, result);
      }
    }

    for (const op of plan.sessions) await apply(op);
  } catch (err) {
    if (!isRevoked(err)) throw err;
    return await markRevoked(userId, activeConn, result);
  }

  // Populated from links that already existed and from pages created just now,
  // so a dry run reports the URLs of everything it would leave alone and a
  // real run reports every page it touched.
  for (const [courseId, url] of ctx.courseUrls) result.coursePages[courseId] = url;

  log.info("notion.sync", {
    userId,
    dryRun,
    created: result.created,
    updated: result.updated,
    skipped: result.skipped,
    errors: result.errors.length,
  });

  return result;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Stand-in used only on the dry-run path, where `client` is null and nothing
 * reads these fields. Its access token is empty on purpose: there is no real
 * secret to leak into a code path that never makes a request.
 */
const EMPTY_CONNECTION: NotionConnection = {
  userId: "",
  accessToken: "",
  workspaceId: "",
  workspaceName: null,
  botId: null,
  parentPageId: null,
  hubPageId: null,
  hubUrl: null,
  coursesDbId: null,
  assignmentsDbId: null,
  sessionsDbId: null,
  status: "needs_parent",
  connectedAt: "",
};

function describeLocal(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Writes the class-page body. Failures here are reported but never fatal: the
 * row (with all its properties) already exists, and a missing body is a much
 * smaller loss than a missing deadline.
 */
async function appendCoursePageBody(
  client: NotionClient,
  course: Course,
  assessments: Assessment[],
  ctx: RelationContext,
  result: NotionSyncResult,
): Promise<void> {
  const pageId = ctx.coursePages.get(course.id);
  if (!pageId) return;

  const mine = assessments.filter((a) => a.courseId === course.id);
  const blocks = buildCoursePageBlocks(course, mine, ctx.assessmentPages);

  try {
    // Notion accepts at most 100 children per append, and a busy syllabus can
    // exceed that. Chunks go in order, so the page reads correctly even if a
    // later chunk fails.
    for (const chunk of chunkBlocks(blocks)) {
      await client.blocks.children.append({ block_id: pageId, children: chunk });
    }
  } catch (err) {
    if (isRevoked(err)) throw err;
    result.errors.push(`${courseTitle(course)} page body: ${client.describeError(err)}`);
  }
}

/**
 * A 401 means the student removed the integration. Mark it so the dashboard
 * can prompt a reconnect instead of retrying forever, and return what the run
 * had achieved before the token died.
 */
async function markRevoked(
  userId: string,
  conn: NotionConnection | null,
  result: NotionSyncResult,
): Promise<NotionSyncResult> {
  if (conn) {
    try {
      await store.setNotionConnection({ ...conn, status: "revoked" });
    } catch (err) {
      logApiError("notion.revoke_persist_failed", err, { userId });
    }
  }
  log.warn("notion.sync.revoked", { userId });
  result.errors.push("Notion access was revoked. Reconnect the integration from the dashboard.");
  return result;
}
