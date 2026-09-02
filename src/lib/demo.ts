import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseSyllabus } from "@/lib/parse";
import { DEMO_USER_ID, isDemoMode } from "@/lib/session";
import { store } from "@/lib/store";
import { attachWeights } from "@/lib/weights";

/**
 * Demo mode has to show a real semester, not an empty shell -- a blank
 * dashboard makes the product look broken rather than unconfigured. So the
 * first read for the demo user parses the bundled fixtures through the actual
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

let seeding: Promise<void> | null = null;

export async function ensureDemoSeed(userId: string): Promise<void> {
  if (!isDemoMode() || userId !== DEMO_USER_ID) return;
  // One in-flight seed only: concurrent dashboard fetches would otherwise each
  // create their own copy of the sample course.
  if (!seeding) seeding = seed().catch((err) => {
    seeding = null;
    throw err;
  });
  return seeding;
}

async function seed(): Promise<void> {
  await store.upsertUser({
    id: DEMO_USER_ID,
    email: "demo@syllabus.ai",
    name: "Demo Student",
    picture: null,
    googleRefreshToken: null,
  });

  const existing = await store.listCourses(DEMO_USER_ID);
  if (existing.length > 0) return;

  for (const name of FIXTURES) {
    const buf = await readFile(path.join(process.cwd(), "fixtures", name));
    const parsed = attachWeights(await parseSyllabus(buf, name));
    await store.createCourse(DEMO_USER_ID, parsed);
  }
}
