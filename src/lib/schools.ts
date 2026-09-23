/**
 * Canonical school names, and the search that maps what a student types onto
 * one of them.
 *
 * Free text here was worthless for the one thing the question exists for --
 * grouping. "nyu", "NYU", "New York University" and "NYU Gallatin" are one
 * school and four rows, and a breakdown by school that has to be cleaned by
 * hand every week is a breakdown nobody looks at. So the field is a search
 * over this list, the server stores only a canonical name from it, and
 * anything that does not match is kept separately (`schoolOther`) rather than
 * polluting the canonical column.
 *
 * The list is every US institution in the open `university-domains-list`
 * dataset (`./schools.data.ts`, ~2,300 names) -- so "Adel" finds Adelphi, not
 * just the famous few. On top of it sits `ALIASES`: the abbreviations and
 * short forms students actually type ("nyu", "ucla", "penn state"), which the
 * dataset does not carry. Aliases exist to be found BY, never to be saved:
 * the stored value is always the dataset's own spelling.
 *
 * Matching is forgiving in one direction only. A query is normalised (case,
 * punctuation, "univ" -> "university", articles dropped) and compared against
 * each school's normalised name and aliases; the result is the canonical name
 * exactly as listed.
 *
 * SERVER-ONLY by size. The onboarding card searches through `GET /api/schools`
 * and never imports this module -- 74 KB of names has no business in a client
 * bundle for a three-question card.
 */

import { US_SCHOOL_NAMES } from "@/lib/schools.data";

export interface School {
  name: string;
  /** Lowercase search aliases: abbreviations, common short forms. */
  aliases?: string[];
}

/**
 * Abbreviations and short forms, keyed by the dataset's canonical name.
 *
 * Hand-maintained and deliberately short: this is for the spellings a student
 * would type instead of the full name, not a second copy of the list. If a
 * canonical name here ever stops matching the dataset (a rename upstream), the
 * merge below keeps the entry anyway, so an alias can never silently vanish.
 */
const ALIASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["Arizona State University", ["asu"]],
  ["Boston College", ["bc"]],
  ["Boston University", ["bu"]],
  ["California Institute of Technology", ["caltech"]],
  ["Carnegie Mellon University", ["cmu"]],
  ["Columbia University", ["columbia"]],
  ["Florida State University", ["fsu"]],
  ["Georgia Institute of Technology", ["georgia tech", "gt"]],
  ["Indiana University - Bloomington", ["iu", "indiana university bloomington"]],
  ["Johns Hopkins University", ["jhu", "hopkins"]],
  ["Massachusetts Institute of Technology", ["mit"]],
  ["Michigan State University", ["msu"]],
  ["New York University", ["nyu", "nyu gallatin", "nyu stern", "nyu tandon", "nyu tisch", "nyu cas"]],
  ["Ohio State University - Columbus", ["osu", "ohio state", "the ohio state university", "ohio state university"]],
  ["Pennsylvania State University", ["penn state", "psu"]],
  ["Purdue University", ["purdue"]],
  ["Rutgers University", ["rutgers"]],
  ["Texas A&M University - College Station", ["tamu", "texas a and m", "texas a and m university"]],
  ["The University of Texas at Austin", ["ut austin", "ut", "university of texas"]],
  ["University of California, Berkeley", ["uc berkeley", "berkeley", "cal"]],
  ["University of California, Davis", ["uc davis", "ucd"]],
  ["University of California, Irvine", ["uc irvine", "uci"]],
  ["University of California, Los Angeles", ["ucla"]],
  ["University of California, San Diego", ["uc san diego", "ucsd"]],
  ["University of California, Santa Barbara", ["ucsb"]],
  ["University of Chicago", ["uchicago"]],
  ["University of Colorado at Boulder", ["cu boulder", "university of colorado boulder"]],
  ["University of Florida", ["uf"]],
  ["University of Georgia", ["uga"]],
  ["University of Illinois Urbana-Champaign", ["uiuc", "illinois"]],
  ["University of Maryland, College Park", ["umd", "maryland"]],
  ["University of Michigan - Ann Arbor", ["umich", "michigan", "university of michigan"]],
  ["University of Minnesota", ["umn"]],
  ["University of North Carolina at Chapel Hill", ["unc", "unc chapel hill"]],
  ["University of Notre Dame", ["notre dame"]],
  ["University of Pennsylvania", ["upenn", "penn"]],
  ["University of Pittsburgh", ["pitt"]],
  ["University of Southern California", ["usc"]],
  ["University of Virginia, Charlottesville", ["uva", "university of virginia"]],
  ["University of Washington", ["uw", "udub"]],
  ["University of Wisconsin - Madison", ["uw madison", "wisconsin", "university of wisconsin madison"]],
  ["Vanderbilt University", ["vandy"]],
  ["Virginia Tech", ["vt", "virginia polytechnic institute"]],
  ["Washington University, Saint Louis", ["washu", "wustl", "washington university in st louis"]],
];

/**
 * The dataset with the aliases folded in. Built once at module load.
 *
 * Entries named in `ALIASES` but absent from the dataset are added rather than
 * dropped -- see the note on `ALIASES`.
 */
function buildSchools(): School[] {
  const byName = new Map<string, School>();
  for (const name of US_SCHOOL_NAMES) byName.set(name, { name });
  for (const [name, aliases] of ALIASES) {
    const existing = byName.get(name);
    if (existing) existing.aliases = [...aliases];
    else byName.set(name, { name, aliases: [...aliases] });
  }
  return [...byName.values()];
}

/** The list in use. */
export const SCHOOLS: readonly School[] = buildSchools();

/**
 * One spelling for comparison. Lowercase, punctuation and articles gone,
 * "univ." expanded, whitespace collapsed -- so "The Univ. of Texas" and
 * "university of texas" meet in the middle.
 */
export function normalizeSchool(input: string): string {
  return input
    .toLowerCase()
    .replace(/&/g, " and ")
    // Periods are DELETED, not turned into spaces, before anything else: a
    // dotted abbreviation ("N.Y.U.", "U.C.L.A.") has to collapse onto its
    // undotted form, and treating the dots as separators would leave "n y u",
    // which matches nothing. "St. Louis" and "Univ." survive this fine.
    .replace(/\./g, "")
    .replace(/\buniv\b/g, "university")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(the|of|at|in)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface Indexed {
  school: School;
  keys: string[];
}

let index: Indexed[] | null = null;
function indexed(): Indexed[] {
  if (!index) {
    index = SCHOOLS.map((school) => ({
      school,
      keys: [normalizeSchool(school.name), ...(school.aliases ?? []).map(normalizeSchool)],
    }));
  }
  return index;
}

/** The canonical school for what a student typed, or null if nothing matches. */
export function canonicalSchool(input: string): string | null {
  const needle = normalizeSchool(input);
  if (!needle) return null;
  for (const entry of indexed()) {
    if (entry.keys.includes(needle)) return entry.school.name;
  }
  return null;
}

/**
 * Typeahead: schools whose name or alias starts with, then contains, the query.
 * Prefix matches first so "uni" does not bury "University of X" under every
 * school with "university" in the middle. Capped so the dropdown stays a
 * dropdown.
 */
export function findSchools(query: string, limit = 8): string[] {
  const needle = normalizeSchool(query);
  if (needle.length < 2) return [];
  const starts: string[] = [];
  const contains: string[] = [];
  for (const entry of indexed()) {
    if (entry.keys.some((k) => k.startsWith(needle))) starts.push(entry.school.name);
    else if (entry.keys.some((k) => k.includes(needle))) contains.push(entry.school.name);
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}
