/**
 * Builds (once) the hub page and the three databases a sync writes into.
 *
 * ## Why the ids stored on the connection are *data source* ids
 *
 * The installed SDK (`@notionhq/client` 5.x) defaults to Notion API version
 * **2025-09-03**, where a database is a container for one or more **data
 * sources** and it is the data source, not the database, that owns the
 * property schema and the rows. Concretely, in this version:
 *
 *   - `pages.create` puts a row in a database with
 *     `parent: { data_source_id }` -- `{ database_id }` is the old shape and
 *     is ambiguous the moment a database has more than one data source;
 *   - a `relation` property config points at `{ data_source_id }`;
 *   - `dataSources.retrieve({ data_source_id })` is the cheap "does this still
 *     exist" probe.
 *
 * Every id we need at write time is therefore a data source id, so
 * `coursesDbId` / `assignmentsDbId` / `sessionsDbId` hold the data source id
 * that `databases.create` returns in `data_sources[0].id`. The database id is
 * deliberately not stored: nothing in the sync path can use it, and keeping a
 * second id around would only invite someone to pass the wrong one.
 *
 * ## Idempotence
 *
 * `ensureWorkspace` is called before every sync. When the connection already
 * carries ids it verifies them with one cheap retrieve each and returns; a 404
 * means the student deleted that piece in Notion, and we rebuild it rather
 * than failing forever. Rebuilds cascade downwards, because relations point at
 * a specific data source: losing Courses invalidates the Course relation on
 * both other databases, so all three are rebuilt.
 *
 * The function is pure with respect to storage -- it returns an updated
 * connection and lets the caller persist it, so one write happens at the end
 * instead of four partial ones on the way through.
 *
 * Server-only.
 */

import type {
  CreateDatabaseParameters,
  DatabaseObjectResponse,
} from "@notionhq/client";
import { getNotionClient, isNotFound, type NotionClient } from "@/lib/notion/client";
import { richText } from "@/lib/notion/blocks";
import { log } from "@/lib/log";
import type { NotionConnection } from "@/lib/types";

/**
 * The hub's icon and title render together in Notion's sidebar as
 * "📚 Syllabus AI" -- the emoji is an icon, not part of the title text, so the
 * title stays searchable and copy-pastable.
 */
const HUB_ICON = "\u{1F4DA}";
export const HUB_TITLE = "Syllabus AI";

export const COURSES_DB_TITLE = "Courses";
export const ASSIGNMENTS_DB_TITLE = "Assignments";
export const SESSIONS_DB_TITLE = "Study Sessions";

type DatabaseProperties = NonNullable<
  NonNullable<CreateDatabaseParameters["initial_data_source"]>["properties"]
>;

/** Every row in every database carries this, so links can be rebuilt from Notion. */
const SYLLABUS_ID_PROPERTY: DatabaseProperties = {
  "Syllabus AI ID": {
    rich_text: {},
    description: "Syllabus AI's own id for this item. Do not edit.",
  },
};

function coursesSchema(): DatabaseProperties {
  return {
    Name: { title: {} },
    Code: { rich_text: {} },
    Instructor: { rich_text: {} },
    Term: { rich_text: {} },
    Dates: { date: {} },
    Meets: { rich_text: {} },
    ...SYLLABUS_ID_PROPERTY,
  };
}

function assignmentsSchema(coursesDataSourceId: string): DatabaseProperties {
  return {
    Name: { title: {} },
    Course: {
      // `single_property`: the relation is one-directional. A `dual_property`
      // relation would silently add a synced column to the Courses data source
      // after it was created, which makes the schema depend on the order
      // things were built in -- not worth it for a back-link the class page
      // already provides as its Schedule list.
      relation: { data_source_id: coursesDataSourceId, single_property: {} },
    },
    Type: {
      select: {
        options: [
          { name: "Assignment", color: "blue" },
          { name: "Exam", color: "red" },
          { name: "Quiz", color: "orange" },
          { name: "Project", color: "purple" },
          { name: "Reading", color: "green" },
          { name: "Lab", color: "yellow" },
          { name: "Presentation", color: "pink" },
          { name: "Other", color: "default" },
        ],
      },
    },
    Due: { date: {} },
    // Notion's percent format renders the stored value x100 (0.18 -> "18%").
    Weight: { number: { format: "percent" } },
    Status: {
      select: {
        options: [
          { name: "Not started", color: "default" },
          { name: "In progress", color: "yellow" },
          { name: "Done", color: "green" },
        ],
      },
    },
    "Est. hours": { number: { format: "number" } },
    "Needs review": { checkbox: {} },
    ...SYLLABUS_ID_PROPERTY,
  };
}

function sessionsSchema(
  coursesDataSourceId: string,
  assignmentsDataSourceId: string,
): DatabaseProperties {
  return {
    Name: { title: {} },
    Course: { relation: { data_source_id: coursesDataSourceId, single_property: {} } },
    Assignment: {
      relation: { data_source_id: assignmentsDataSourceId, single_property: {} },
    },
    When: { date: {} },
    Why: { rich_text: {} },
    Done: { checkbox: {} },
    ...SYLLABUS_ID_PROPERTY,
  };
}

/* -------------------------------------------------------------------------- */
/* Creation                                                                    */
/* -------------------------------------------------------------------------- */

function isFullDatabaseResponse(
  value: Awaited<ReturnType<NotionClient["databases"]["create"]>>,
): value is DatabaseObjectResponse {
  return "data_sources" in value;
}

async function createHubPage(
  client: NotionClient,
  parentPageId: string,
): Promise<{ hubPageId: string; hubUrl: string | null }> {
  const page = await client.pages.create({
    parent: { type: "page_id", page_id: parentPageId },
    icon: { type: "emoji", emoji: HUB_ICON },
    properties: { title: { title: richText(HUB_TITLE) } },
    children: [
      {
        paragraph: {
          rich_text: richText(
            "Everything below is built from the syllabi you upload and kept current on every sync. The three databases are shared across all your classes, so you can filter by course for one class or by date for the whole semester.",
          ),
        },
      },
      {
        // The one manual step in the product, stated plainly where the student
        // will hit it. Notion's API cannot create database *views*, only
        // properties and rows -- so we make the missing piece one click away
        // instead of pretending it does not exist.
        callout: {
          icon: { type: "emoji", emoji: "\u{1F5D3}️" },
          rich_text: richText(
            "Want a semester calendar? Open Assignments or Study Sessions and click + Add view → Calendar. Every dated row already has a real date property, so it works immediately. (Notion's API cannot create views for you.)",
          ),
        },
      },
    ],
  });

  return {
    hubPageId: page.id,
    hubUrl: "url" in page ? page.url : null,
  };
}

/**
 * Creates a database under the hub and returns the id of its initial data
 * source -- the id everything downstream actually needs. See the file header.
 */
async function createDatabase(
  client: NotionClient,
  hubPageId: string,
  title: string,
  properties: DatabaseProperties,
): Promise<string> {
  const db = await client.databases.create({
    parent: { type: "page_id", page_id: hubPageId },
    title: richText(title),
    initial_data_source: { properties },
  });

  if (!isFullDatabaseResponse(db)) {
    throw new Error(
      `Notion returned a partial object when creating the "${title}" database, with no data source id to write rows into.`,
    );
  }

  const dataSourceId = db.data_sources[0]?.id;
  if (!dataSourceId) {
    throw new Error(`Notion created the "${title}" database but reported no data source.`);
  }
  return dataSourceId;
}

/* -------------------------------------------------------------------------- */
/* Verification                                                                */
/* -------------------------------------------------------------------------- */

/** True when the object is still there. A 404 is an answer, not a failure. */
async function stillExists(probe: () => Promise<unknown>): Promise<boolean> {
  try {
    await probe();
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* ensureWorkspace                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Guarantees the hub page and all three databases exist, creating or repairing
 * whatever is missing.
 *
 * @returns the connection with any newly created ids filled in. **The caller
 *          persists it** -- doing it here would mean a partial write for every
 *          intermediate step.
 */
export async function ensureWorkspace(conn: NotionConnection): Promise<NotionConnection> {
  if (!conn.parentPageId) {
    throw new Error(
      "This Notion connection has no parent page yet. Call chooseParent() with a page the user shared before building the workspace.",
    );
  }

  const parentPageId = conn.parentPageId;
  const client = getNotionClient(conn.accessToken);
  let next: NotionConnection = { ...conn };

  /* --- Hub --- */
  let hubOk = false;
  const existingHubId = next.hubPageId;
  if (existingHubId) {
    hubOk = await stillExists(() => client.pages.retrieve({ page_id: existingHubId }));
    if (!hubOk) {
      log.info("notion.workspace.hub_missing", { userId: next.userId });
    }
  }

  if (!hubOk) {
    const hub = await createHubPage(client, parentPageId);
    // A new hub means the old databases (which lived under it) are gone too.
    next = {
      ...next,
      hubPageId: hub.hubPageId,
      hubUrl: hub.hubUrl,
      coursesDbId: null,
      assignmentsDbId: null,
      sessionsDbId: null,
    };
    log.info("notion.workspace.hub_created", { userId: next.userId });
  }

  const hubPageId = next.hubPageId;
  if (!hubPageId) throw new Error("Notion created the Syllabus AI hub page but returned no id.");

  /* --- Courses --- */
  let coursesOk = false;
  const existingCoursesId = next.coursesDbId;
  if (existingCoursesId) {
    coursesOk = await stillExists(() =>
      client.dataSources.retrieve({ data_source_id: existingCoursesId }),
    );
  }
  if (!coursesOk) {
    // Both other databases hold a relation into Courses; that relation names a
    // data source id, so a new Courses data source invalidates them.
    next = {
      ...next,
      coursesDbId: await createDatabase(client, hubPageId, COURSES_DB_TITLE, coursesSchema()),
      assignmentsDbId: null,
      sessionsDbId: null,
    };
    log.info("notion.workspace.db_created", { userId: next.userId, db: COURSES_DB_TITLE });
  }
  const coursesDbId = next.coursesDbId;
  if (!coursesDbId) throw new Error("Notion created the Courses database but returned no id.");

  /* --- Assignments --- */
  let assignmentsOk = false;
  const existingAssignmentsId = next.assignmentsDbId;
  if (existingAssignmentsId) {
    assignmentsOk = await stillExists(() =>
      client.dataSources.retrieve({ data_source_id: existingAssignmentsId }),
    );
  }
  if (!assignmentsOk) {
    next = {
      ...next,
      assignmentsDbId: await createDatabase(
        client,
        hubPageId,
        ASSIGNMENTS_DB_TITLE,
        assignmentsSchema(coursesDbId),
      ),
      // Study Sessions relates to Assignments, so it follows Assignments down.
      sessionsDbId: null,
    };
    log.info("notion.workspace.db_created", { userId: next.userId, db: ASSIGNMENTS_DB_TITLE });
  }
  const assignmentsDbId = next.assignmentsDbId;
  if (!assignmentsDbId) {
    throw new Error("Notion created the Assignments database but returned no id.");
  }

  /* --- Study Sessions --- */
  let sessionsOk = false;
  const existingSessionsId = next.sessionsDbId;
  if (existingSessionsId) {
    sessionsOk = await stillExists(() =>
      client.dataSources.retrieve({ data_source_id: existingSessionsId }),
    );
  }
  if (!sessionsOk) {
    next = {
      ...next,
      sessionsDbId: await createDatabase(
        client,
        hubPageId,
        SESSIONS_DB_TITLE,
        sessionsSchema(coursesDbId, assignmentsDbId),
      ),
    };
    log.info("notion.workspace.db_created", { userId: next.userId, db: SESSIONS_DB_TITLE });
  }

  return next;
}
