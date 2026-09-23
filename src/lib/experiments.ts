/**
 * A/B tests: which variant a given person sees, decided the same way everywhere.
 *
 * No vendor and no network call. Assignment is a pure hash of the experiment
 * key and the subject id, which buys three things that matter more here than
 * any dashboard feature:
 *
 *  1. **The server decides.** The price experiment picks a Stripe price id. If
 *     the browser chose its own variant, the browser would be choosing its own
 *     price -- so assignment has to happen somewhere the visitor cannot reach,
 *     and be reproducible on the next request without storing anything.
 *  2. **It is sticky for free.** The same person gets the same variant on every
 *     request, on every device, forever, because the answer is a function of
 *     their id rather than a coin flip someone had to remember. No assignment
 *     table, no cookie to lose, and nobody is ever quoted two different prices.
 *  3. **It cannot fail.** A flag service that is slow or down would mean a
 *     paywall that renders late or wrong. This is arithmetic.
 *
 * PostHog still sees which variant was shown -- it rides along as a property on
 * every event (see `@/lib/analytics`), which is what makes a funnel splittable
 * by variant. PostHog reports; it does not decide.
 *
 * Importable from a client component: no secrets, no `node:` imports.
 */

/** A declared test. `variants[0]` is always the control. */
export interface Experiment<V extends string = string> {
  key: string;
  variants: readonly V[];
}

/**
 * Every live experiment, in one place.
 *
 * Deleting one is how a test ends: the call sites fall back to the control
 * branch, which is the one that should survive anyway. Renaming a key
 * REBUCKETS EVERYONE -- the key is half the hash input -- so a rename is a new
 * experiment, and mid-flight it would show a returning customer a new price.
 * Change the variants, never the key.
 */
export const EXPERIMENTS = {
  /** Paywall framing and copy. Same price in both arms. */
  paywallCopy: {
    key: "paywall_copy",
    variants: ["control", "outcome"],
  },
  /**
   * The Term Pass price itself.
   *
   * The arms map to Stripe price ids through `STRIPE_TERM_PASS_PRICE_IDS`
   * (see `@/lib/pricing`), and the amount shown to a student is read back from
   * Stripe rather than typed anywhere -- the Terms promise that the displayed
   * price is the charged price, and the only way to keep that promise is to
   * never have a second copy of the number.
   */
  termPassPrice: {
    key: "term_pass_price",
    variants: ["control", "higher"],
  },
  /** Landing hero headline and call to action. Measured on sign-up rate. */
  landingHero: {
    key: "landing_hero",
    variants: ["control", "outcome"],
  },
} as const satisfies Record<string, Experiment>;

export type ExperimentName = keyof typeof EXPERIMENTS;
export type VariantOf<N extends ExperimentName> =
  (typeof EXPERIMENTS)[N]["variants"][number];

/**
 * FNV-1a, 32-bit.
 *
 * Chosen for being boring: a dozen lines, identical in Node and every browser,
 * no dependency, and no `node:crypto` -- which matters because this module is
 * imported by client components. It is not a cryptographic hash and does not
 * need to be; nothing here is a secret, and an attacker who predicts their own
 * bucket learns which button they will see.
 *
 * `>>> 0` after every step keeps the value an unsigned 32-bit integer, because
 * JavaScript's `*` on a 32-bit-looking number silently produces a double and
 * the avalanche stops working.
 */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    // The FNV prime, 16777619, as shifts.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return fmix32(h);
}

/**
 * MurmurHash3's finalizer. Four lines, and they are not optional.
 *
 * FNV-1a's weakness is its HIGH bits: the last byte mixed in reaches them only
 * through carry propagation, so for short or near-identical inputs the top of
 * the word barely moves off the offset basis. That would be a curiosity if
 * `bucketOf` used the whole word -- but it divides by 2^32, so for a two-arm
 * experiment the variant is decided by the single most significant bit, which
 * is precisely the bit FNV moves least.
 *
 * The symptom, before this existed: every one-character subject id landed in
 * the control arm of every experiment. Real ids (UUIDs, Google's 21-digit
 * `sub`) split near enough to even that it would never have been noticed from
 * the data -- an experiment quietly running at 60/40 does not announce itself,
 * it just takes longer to reach significance and nobody knows why.
 *
 * `fmix32` fixes it at the source by making every output bit depend on every
 * input bit, so the split no longer varies with how long or how similar the
 * ids happen to be. `Math.imul` rather than `*` because the products overflow
 * 32 bits and `*` would silently promote them to doubles and lose the low bits
 * that carry the mixing.
 */
function fmix32(input: number): number {
  let h = input;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A subject's stable position in [0, 1) for one experiment. */
export function bucketOf(experimentKey: string, subjectId: string): number {
  return hash32(`${experimentKey}:${subjectId}`) / 0x100000000;
}

/**
 * Which variant this subject sees. Always returns something.
 *
 * An empty subject id returns the control rather than throwing: a call site
 * that has no id yet (a visitor before their cookie is settled) should render
 * the safe branch, not crash the page it is deciding the shape of.
 *
 * Variants are split evenly. Uneven splits are a knob nobody has asked for, and
 * an even split is the one that reaches significance soonest.
 */
export function variantOf<N extends ExperimentName>(
  name: N,
  subjectId: string | null | undefined,
): VariantOf<N> {
  const experiment = EXPERIMENTS[name];
  const variants = experiment.variants as readonly VariantOf<N>[];
  if (!subjectId) return variants[0];
  const index = Math.floor(bucketOf(experiment.key, subjectId) * variants.length);
  // Guard the 1.0 edge: bucketOf cannot return it today, but an index one past
  // the end would be `undefined` leaking into the UI rather than a loud error.
  return variants[Math.min(index, variants.length - 1)];
}

/**
 * Every assignment for one subject, as the flat map the client and the analytics
 * layer both want.
 *
 * One call so a page cannot accidentally ask about two experiments with two
 * different subject ids, and so `/api/config` has a single thing to serialise.
 */
export function assignmentsFor(
  subjectId: string | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(EXPERIMENTS) as ExperimentName[]) {
    out[EXPERIMENTS[name].key] = variantOf(name, subjectId);
  }
  return out;
}
