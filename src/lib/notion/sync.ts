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
 * 3. **The student's preferences decide what exists.** The same
 *    `CalendarPrefs` the calendar sync honours -- unticking "Study sessions"
 *    stops Notion writing them, and archives the ones already there. Notion has
 *    no class-meeting database, so only `deadlines` and `studySessions` have
 *    anything here to apply to.
 *
 * 4. **What leaves the plan leaves Notion.** A removal pass diffs the plan
 *    against the link table and archives what is left over, with one exception
 *    the calendar lane paid for first: a study session the student already sat
 *    is absent from the plan because the day is over, not because it stopped
 *    mattering. See `removeStalePages`.
 *
 * 5. **Bodies are written once.** The class-page body is appended only when
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
import { buildSemesterPlan } from "@/lib/plan";
import { notionSessionLinkPrefix, store } from "@/lib/store";
import type { OrphanedNotionPage } from "@/lib/store";
import { DEFAULT_CALENDAR_PREFS } from "@/lib/types";
import type {
  Assessment,
  CalendarPrefs,
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
  /**
   * What to write into Notion. Defaults to the user's stored preferences, and
   * to `DEFAULT_CALENDAR_PREFS` when they have none -- the same resolution
   * order `syncToCalendar` uses, because the setting is one setting: a student
   * who unticks "Study sessions" means it everywhere, not only on Google.
   *
   * Only the two preferences Notion can act on are read here: `deadlines`
   * (the Coursework rows) and `studySessions`. Class meetings are not synced to
   * Notion at all, so `classes` / `recitations` / `officeHours` have nothing to
   * apply to -- see the note on `applicablePrefs`.
   */
  prefs?: CalendarPrefs;
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
/* Preferences                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Everything about the *user* this sync depends on, read in one go.
 *
 * Same resolution order as `resolveSyncContext` in `@/lib/google/calendar`: an
 * explicit `opts.prefs` beats the stored preferences, which beat the defaults.
 * The panel says the setting applies to the syncs; it now does.
 *
 * The zone is only ever used to answer "has this study session already
 * happened" (see `pastStudySessionIds`), which is a question no server zone can
 * answer for a student in another one.
 */
async function resolveSyncContext(
  userId: string,
  opts: NotionSyncOptions,
): Promise<{ timeZone: string; prefs: CalendarPrefs }> {
  const user = await store.getUser(userId).catch(() => null);
  return {
    timeZone: user?.timezone ?? serverTimeZone(),
    prefs: opts.prefs ?? user?.calendarPrefs ?? DEFAULT_CALENDAR_PREFS,
  };
}

function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
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
async function planOps(opts: NotionSyncOptions, prefs: CalendarPrefs): Promise<SyncPlan> {
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

  // Preferences gate the rows, not the class pages: a Courses row is the hub
  // itself, not one of the categories the student can switch off.
  const assessments: PlannedOp[] = [];
  for (const a of prefs.deadlines ? opts.assessments : []) {
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
  for (const b of prefs.studySessions ? (opts.studyBlocks ?? []) : []) {
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
    removed: 0,
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

  const { timeZone, prefs } = await resolveSyncContext(userId, opts);
  const plan = await planOps(opts, prefs);
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

    // Computed from the plan and the clock alone -- no network -- so the dry
    // run and the real run protect exactly the same sessions. Lazy because most
    // syncs have no stale session at all and never need to ask.
    let past: ReadonlySet<string> | null = null;
    await removeStalePages(
      userId,
      opts,
      plan,
      {
        client,
        comprehensive: await coversEveryCourse(userId, opts),
        pastSessions: () => (past ??= pastStudySessionIds(opts, timeZone, prefs)),
      },
      result,
    );
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
    prefs: { deadlines: prefs.deadlines, studySessions: prefs.studySessions },
    created: result.created,
    updated: result.updated,
    removed: result.removed,
    skipped: result.skipped,
    errors: result.errors.length,
  });

  return result;
}

/* -------------------------------------------------------------------------- */
/* Reconciliation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The links this sync is allowed to archive: everything that could belong to
 * the courses being synced, and nothing else.
 *
 * Mirrors `reconciliationScope` in `@/lib/google/calendar`, one entity kind at
 * a time instead of one key shape at a time:
 *
 *  - a course link, keyed by the course's own id;
 *  - an assessment link, keyed by the assessment's own id;
 *  - a session link, whose id is `sb_<assessmentId>_<n>` and can only be
 *    matched by prefix, because the planner mints sessions and never stores
 *    them.
 *
 * A course absent from `opts.courses` contributes no id and no prefix, so
 * syncing one class cannot touch another class's pages.
 *
 * `comprehensive` is the one widening: when this sync covers every course the
 * user has, a link whose entity is nowhere in the input describes something
 * that no longer exists at all -- a deleted assessment, a deleted course --
 * and there is no other sync that could ever claim it. A single-course sync
 * leaves those alone, because it cannot tell an orphan from another class's row.
 */
function reconciliationScope(opts: NotionSyncOptions, comprehensive: boolean) {
  const courseIds = new Set(opts.courses.map((c) => c.id));
  const mine = opts.assessments.filter((a) => courseIds.has(a.courseId));
  const assessmentIds = new Set(mine.map((a) => a.id));
  const sessionPrefixes = mine.map((a) => notionSessionLinkPrefix(a.id));

  return (link: NotionLink): boolean => {
    if (link.kind === "course") return courseIds.has(link.entityId) || comprehensive;
    if (link.kind === "assessment") return assessmentIds.has(link.entityId) || comprehensive;
    return (
      sessionPrefixes.some((prefix) => link.entityId.startsWith(prefix)) || comprehensive
    );
  };
}

/**
 * Today, as the student's calendar shows it. Copied from the calendar sync
 * because "in the past" is a question only a zone can answer: on a UTC host, a
 * New York student's Tuesday evening is already Wednesday.
 */
function todayIn(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * The earliest day the semester touches, minus a month of runway. Null when
 * there is no dated work at all, in which case there is nothing to protect.
 */
function semesterStart(opts: NotionSyncOptions): Date | null {
  const days = [
    ...opts.courses.map((c) => c.startDate),
    ...opts.assessments.map((a) => a.dueDate),
  ].filter((d): d is string => typeof d === "string" && d.length >= 10);
  if (days.length === 0) return null;

  const earliest = days.reduce((a, b) => (a < b ? a : b));
  const ms = Date.parse(`${earliest.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return new Date(ms - 30 * 24 * 60 * 60 * 1000);
}

/**
 * The study sessions the student has already sat.
 *
 * The calendar lane learned this the hard way and the lesson transfers exactly:
 * `buildStudyBlocks` refuses to schedule a day that has passed, so a session
 * planned in week 2 is simply absent from the plan by week 3 -- and a
 * reconciliation pass reads "absent from the plan" as "delete it". Over a
 * semester that quietly erases the record of twenty to forty sessions the
 * student actually worked through.
 *
 * A session's date is nowhere in its id (`sb_<assessmentId>_<n>`) and nowhere
 * in the link row, so it is recovered the only honest way there is: by running
 * the same planner against a clock set before the semester started, which
 * yields the whole ladder, past sessions included, with their dates. Pure and
 * offline, so a dry run protects exactly the same pages with no calls.
 *
 * Two cases deliberately fall through to archiving, as on the calendar side:
 * an assessment that no longer exists contributes no sessions here, so its
 * orphans are still cleaned up; and study sessions switched off in preferences
 * are not protected either -- "stop putting these in Notion" means all of them.
 */
function pastStudySessionIds(
  opts: NotionSyncOptions,
  timeZone: string,
  prefs: CalendarPrefs,
): Set<string> {
  const ids = new Set<string>();
  if (!prefs.studySessions) return ids;

  const before = semesterStart(opts);
  if (!before) return ids;

  const today = todayIn(timeZone);
  const asPlannedThen = buildSemesterPlan(opts.courses, opts.assessments, {
    now: before,
    timeZone,
  });
  for (const block of asPlannedThen.studyBlocks) {
    if (block.start.slice(0, 10) < today) ids.add(block.id);
  }
  return ids;
}

/**
 * Archives the pages this sync's plan no longer contains.
 *
 * Runs after the writes, over the links belonging to the courses in this sync
 * (see `reconciliationScope`). A link whose entity is not in the plan describes
 * a page whose reason to exist is gone: an assessment the student deleted, a
 * study session the planner dropped, a category they switched off. Archiving is
 * Notion's delete -- `pages.update` with `archived: true` -- and it is
 * deliberately not destructive: the page moves to the trash, where a student
 * who disagrees can restore it.
 *
 * Notion first, then the link: an orphaned link is recoverable (the next sync
 * archives it again, and archiving twice is a no-op) while an orphaned page
 * would be unreachable, which is the bug this exists to fix.
 *
 * A dry run walks the identical diff and reports the identical `removed`
 * without one network call, because the diff comes from the plan and the store
 * and the network is used solely to carry it out.
 */
async function removeStalePages(
  userId: string,
  opts: NotionSyncOptions,
  plan: SyncPlan,
  args: {
    client: NotionClient | null;
    comprehensive: boolean;
    pastSessions: () => ReadonlySet<string>;
  },
  result: NotionSyncResult,
): Promise<void> {
  // Nothing in scope: no course means no id and no prefix, and "archive
  // everything" is never the right reading of an empty input.
  if (opts.courses.length === 0) return;

  const desired = new Set<string>();
  for (const op of [...plan.courses, ...plan.assessments, ...plan.sessions]) {
    desired.add(`${op.kind}:${op.entityId}`);
  }

  let links: NotionLink[];
  try {
    links = await store.listNotionLinks(userId);
  } catch (err) {
    // Never fatal: the pages just written are correct either way, and a cleanup
    // that cannot read its own links simply has nothing to do.
    result.errors.push(`Could not list existing Notion pages: ${describeLocal(err)}`);
    return;
  }

  const inScope = reconciliationScope(opts, args.comprehensive);

  for (const link of links) {
    if (desired.has(`${link.kind}:${link.entityId}`)) continue;
    if (!inScope(link)) continue;
    // A session the student already sat is not stale, it is history. The link
    // stays too, so a later sync still knows the page is ours.
    if (link.kind === "session" && args.pastSessions().has(link.entityId)) continue;

    if (args.client === null) {
      // Dry run: same diff, no calls, no link touched.
      result.removed += 1;
      continue;
    }

    const client = args.client;
    try {
      try {
        // Notion's delete. `archived` (not `in_trash`) is what the write side
        // of the API takes, in every version the SDK speaks.
        await client.pages.update({ page_id: link.pageId, archived: true });
      } catch (err) {
        // 404: already gone -- the student deleted it themselves, or a previous
        // run got as far as Notion and no further. The end state is the one we
        // wanted, so this counts as removed and the link still goes.
        if (!isNotFound(err)) throw err;
      }
      await store.deleteNotionLink(link.kind, link.entityId);
      result.removed += 1;
    } catch (err) {
      if (isRevoked(err)) throw err;
      // The link is deliberately left in place so the next sync retries it.
      result.errors.push(
        `${describeStale(link, opts)}: ${client.describeError(err)}`,
      );
    }
  }
}

/** What `archiveNotionPages` managed to do, and what it could not. */
export interface NotionPageRemoval {
  removed: number;
  errors: string[];
}

/**
 * Archives specific pages we created, given the links that named them.
 *
 * The counterpart to `removeStalePages` for the one case that pass cannot
 * reach. It reconciles against the courses being synced; a course the student
 * deleted is in no sync's scope, and its link rows -- the only record of the
 * page ids -- went with it. So `deleteCourse` and `deleteAssessment` hand the
 * rows back on their way out and they land here, exactly as their calendar
 * links land in `deleteCalendarEvents`.
 *
 * Only ever the generated rows: coursework and study sessions. The class page
 * is not in what the store returns, and this function is not the place that
 * decision gets revisited (see `CourseDeletion.notionPages`).
 *
 * Best effort by construction. It never throws: the student asked for the
 * course to go, and Notion being down is not a reason to refuse them. What is
 * lost then is the tidy-up, not the delete -- and archiving is Notion's trash,
 * so nothing here is unrecoverable in either direction.
 */
export async function archiveNotionPages(
  userId: string,
  pages: readonly OrphanedNotionPage[],
): Promise<NotionPageRemoval> {
  const result: NotionPageRemoval = { removed: 0, errors: [] };
  // Before the connection is read, so the overwhelmingly common case -- a
  // student who never connected Notion, and so has no links -- costs nothing
  // and reports nothing.
  if (pages.length === 0) return result;

  let client: NotionClient;
  try {
    const conn = await store.getNotionConnection(userId);
    if (!conn || conn.status !== "connected") {
      result.errors.push("Notion is not connected.");
      return result;
    }
    client = getNotionClient(conn.accessToken);
  } catch (err) {
    result.errors.push(`Notion unavailable: ${describeLocal(err)}`);
    return result;
  }

  for (const page of pages) {
    try {
      await client.pages.update({ page_id: page.pageId, archived: true });
      result.removed += 1;
    } catch (err) {
      // 404: already gone, which is the end state that was asked for.
      if (isNotFound(err)) {
        result.removed += 1;
        continue;
      }
      // Collected, never thrown -- including a revoked token, which the
      // removal pass rethrows because it has a sync to abort and this has not.
      result.errors.push(
        `${page.kind} ${page.entityId}: ${client.describeError(err)}`,
      );
    }
  }
  return result;
}

/**
 * Turns a stale link back into something a person recognises. "9 removed" gives
 * a student no way to tell a tidy-up from a mistake. Derived from the input
 * where possible and from the id where not, because the whole point is that
 * these entities may no longer exist.
 */
function describeStale(link: NotionLink, opts: NotionSyncOptions): string {
  if (link.kind === "course") {
    const course = opts.courses.find((c) => c.id === link.entityId);
    return course ? courseTitle(course) : "A course page";
  }
  if (link.kind === "assessment") {
    const a = opts.assessments.find((x) => x.id === link.entityId);
    if (!a) return "A deleted item";
    const code = opts.courses.find((c) => c.id === a.courseId)?.code;
    return code ? `${code}: ${a.title}` : a.title;
  }
  const owner = /^sb_(.+)_\d+$/.exec(link.entityId)?.[1];
  const a = owner ? opts.assessments.find((x) => x.id === owner) : undefined;
  return a ? `Study session — ${a.title}` : "A study session";
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

/**
 * True when this sync's input is the user's whole set of courses.
 *
 * Only then can a link whose entity is nowhere in the input be read as an
 * orphan rather than as another sync's business -- see `reconciliationScope`.
 * A store that cannot answer means "assume not", which narrows the cleanup
 * rather than widening it: the wrong answer here archives someone's pages.
 */
async function coversEveryCourse(userId: string, opts: NotionSyncOptions): Promise<boolean> {
  try {
    const all = await store.listCourses(userId);
    const synced = new Set(opts.courses.map((c) => c.id));
    return all.every((c) => synced.has(c.id));
  } catch {
    return false;
  }
}

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
