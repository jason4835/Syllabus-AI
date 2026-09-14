import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseSyllabus } from "@/lib/parse";
import { isDemoUser, resolveSession } from "@/lib/session";
import type { ResolvedSession } from "@/lib/session";
import { store } from "@/lib/store";
import { attachWeights } from "@/lib/weights";

/**
 * A demo account has to show a real semester, not an empty shell -- a blank
 * dashboard makes the product look broken rather than unconfigured. So the
 * first read for a demo user parses the bundled fixtures through the actual
 * pipeline, which also means the demo exercises the same code path as a real
 * upload instead of hard-coded JSON that can drift from the parser.
 *
 * Through the pattern-matching half of that pipeline, never the model: see the
 * `offline` call below for why paying per visitor to re-derive a fixed answer
 * was indefensible.
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

/**
 * The identity a route should act as -- and the ONLY way a route gets one.
 *
 * `resolveSession` mints a demo id and sets the cookie, and that is all it can
 * do: it is a pure leaf that must not know about the store. But every table has
 * a foreign key to `users`, so an id with no row behind it is an identity that
 * cannot own anything. Ten routes reached that state -- they minted and then
 * wrote a course, a timezone, a feed token -- and the first write failed with a
 * constraint violation. It never showed on the JSON store, which has no keys.
 *
 * Wrapping the two steps here, and having routes call this instead, makes the
 * invariant structural: there is no path to a userId that skips the row. The
 * row is written only when the id is fresh; an existing cookie was minted
 * through here already, and the seeding routes self-heal the rest.
 */
export async function resolveVisitor(): Promise<ResolvedSession> {
  const session = await resolveSession();
  if (session.created) await ensureDemoUser(session.userId);
  return session;
}

/**
 * The user row and nothing else. Split from `seed` so a fresh identity can be
 * made real without parsing three syllabi, and so the two cannot drift: the
 * seed calls this rather than writing the row itself.
 */
export async function ensureDemoUser(userId: string): Promise<void> {
  if (!isDemoUser(userId)) return;
  await store.upsertUser({
    id: userId,
    email: demoEmail(userId),
    name: "Demo Student",
    picture: null,
    googleRefreshToken: null,
  });
}

async function seed(userId: string): Promise<void> {
  await ensureDemoUser(userId);

  const existing = await store.listCourses(userId);
  if (existing.length > 0) return;

  for (const name of FIXTURES) {
    const buf = await readFile(path.join(process.cwd(), "fixtures", name));
    // Never the model, however the server is configured. The fixtures are
    // static, so the model's answer for them is the same every time -- and this
    // runs once per visitor, on routes that do not and should not charge anyone
    // for showing them a sample. It was the only unmetered spend in the app.
    const parsed = attachWeights(await parseSyllabus(buf, name, { offline: true }));
    await store.createCourse(userId, parsed);
  }
}
