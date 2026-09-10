import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseSyllabus } from "@/lib/parse";
import { isDemoUser } from "@/lib/session";
import { store } from "@/lib/store";
import { attachWeights } from "@/lib/weights";

/**
 * A demo account has to show a real semester, not an empty shell -- a blank
 * dashboard makes the product look broken rather than unconfigured. So the
 * first read for a demo user parses the bundled fixtures through the actual
 * pipeline, which also means the demo exercises the same code path as a real
 * upload instead of hard-coded JSON that can drift from the parser.
 *
 * Three courses rather than one, deliberately: the workload heatmap and its
 * heavy-week warnings are the product's whole argument, and a single course
 * never collides with itself. The fixtures are dated so that two exams and a
 * paper land in the same October week.
 */
const FIXTURES = [
  "sample-syllabus.txt",
  "sample-syllabus-chem.txt",
  "sample-syllabus-hist.txt",
];

/**
 * In-flight seeds, keyed by user.
 *
 * One global promise used to be enough because there was one global demo
 * account. Now every visitor gets their own, and a single shared promise would
 * make the second visitor await the FIRST visitor's seed and then find their
 * own workspace empty. Entries are dropped once settled, so this holds only
 * work actually in progress rather than one entry per visitor forever.
 */
const seeding = new Map<string, Promise<void>>();

/**
 * Fills a demo sandbox with the sample semester, once.
 *
 * Safe and cheap to call on every read: a signed-in user is rejected by the
 * prefix check without touching the store, and an already-seeded sandbox costs
 * one `listCourses`.
 */
export async function ensureDemoSeed(userId: string): Promise<void> {
  if (!isDemoUser(userId)) return;

  // Concurrent dashboard fetches (config, me, courses and plan all fire on
  // mount) would otherwise each create their own copy of the sample courses.
  // The map is read and written with no await in between, so two requests in
  // the same tick cannot both start a seed.
  const inFlight = seeding.get(userId);
  if (inFlight) return inFlight;

  const run = seed(userId).finally(() => {
    seeding.delete(userId);
  });
  seeding.set(userId, run);
  return run;
}

/**
 * Emails are `unique` in the schema (supabase/schema.sql) and the Supabase
 * store lowercases them on write, so demo accounts cannot all share one
 * address and cannot derive one from their case-sensitive base64url id. A
 * short hash of the id gives a stable, lowercase, collision-free plus-tag.
 *
 * The domain is one we actually own: a demo@ address on a domain we do not
 * control is someone else's mailbox, and bounces land on them.
 */
function demoEmail(userId: string): string {
  const tag = createHash("sha256").update(userId).digest("hex").slice(0, 12);
  return `demo+${tag}@syllabuscenter.com`;
}

async function seed(userId: string): Promise<void> {
  await store.upsertUser({
    id: userId,
    email: demoEmail(userId),
    name: "Demo Student",
    picture: null,
    googleRefreshToken: null,
  });

  const existing = await store.listCourses(userId);
  if (existing.length > 0) return;

  for (const name of FIXTURES) {
    const buf = await readFile(path.join(process.cwd(), "fixtures", name));
    const parsed = attachWeights(await parseSyllabus(buf, name));
    await store.createCourse(userId, parsed);
  }
}
