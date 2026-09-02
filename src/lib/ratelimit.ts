/**
 * Per-user rate limiting for the endpoints that spend money.
 *
 * `/api/upload` and `/api/chat` call OpenAI on the owner's key, and `/api/sync`
 * burns Google Calendar quota. None of them had a per-user ceiling, which is
 * fine until the app is handed to people who were invited to break it. This
 * module is the ceiling.
 *
 * WHAT THIS IS NOT
 * ----------------
 * State lives in a `Map` in one Node process. On Vercel that means:
 *
 *   - counters are per instance, so N warm instances multiply every cap by N;
 *   - a cold start resets every counter to zero;
 *   - nothing is shared between preview and production deployments.
 *
 * So this raises the cost of casual abuse -- a friend holding down a button, a
 * runaway client retry loop, an accidental `for` loop in someone's console --
 * from "free" to "annoying". It is NOT a security boundary and NOT a hard spend
 * ceiling. A determined tester who can trigger cold starts or fan out across
 * instances will get more than the numbers below suggest.
 *
 * The real hard stop is a monthly spend limit configured on the OpenAI account
 * itself; set one. The upgrade path for this module is a shared counter store
 * (Redis `INCR`, or a Supabase table with an atomic upsert) behind the same
 * `checkLimit` signature, at which point the caps become actually global.
 *
 * Keys are supplied by the caller and should identify a *user*
 * (`"user:<id>"`), never an IP alone: campus NAT puts a whole dorm behind one
 * address, and an IP is trivially rotated anyway.
 *
 * Pure and synchronous: no I/O, no network, no timers.
 */

export interface LimitRule {
  limit: number;
  windowMs: number;
}

export interface LimitVerdict {
  allowed: boolean;
  /**
   * Requests left in the tightest applicable window. On a denial this is 0 --
   * for the rule that denied, which is the only one the caller can act on.
   */
  remaining: number;
  /** Unix ms when the window resets -- becomes the Retry-After header. */
  resetAt: number;
  /** Which rule denied it (or, when allowed, which one is closest to denying). */
  rule: string;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

/**
 * Every rule is `<family>:<window>`. Two windows apply to each LLM route on
 * purpose: the short one stops a hammering client, the daily one is the actual
 * cost control, since a script pacing itself at the per-minute limit would
 * still run up a four-figure bill overnight.
 *
 * Numbers are sized for a private beta of roughly a dozen invited friends. They
 * are meant to be invisible to honest use and obvious to a stress test.
 */
export const RULES: Record<string, LimitRule> = {
  // A syllabus upload sends a large PDF's text through the model -- by far the
  // most expensive call in the app. Nobody legitimately uploads more than a
  // few in a minute; 3 leaves room for a retry after a failed parse.
  "upload:user:burst": { limit: 3, windowMs: MINUTE },
  // A full course load is ~6 syllabi. 20 covers re-uploading everything twice
  // over while poking at the parser, and caps one person's worst day at a
  // couple of dollars rather than an open tab.
  "upload:user:daily": { limit: 20, windowMs: DAY },

  // Chat is cheap by comparison (the context is the parsed plan, not the PDF)
  // and conversation is bursty, so the per-minute cap is loose enough that a
  // fast typist never sees it but a scripted loop does.
  "chat:user:burst": { limit: 12, windowMs: MINUTE },
  // A heavy real study session might be 40 questions. 150 is generous for a
  // person and ruinous for nobody.
  "chat:user:daily": { limit: 150, windowMs: DAY },

  // Sync costs no LLM tokens, but one call writes many Google Calendar events,
  // and Google's per-user write quota is the thing that breaks. 6/min lets
  // someone sync several courses and retry; it stops a refresh-key loop.
  "sync:user:burst": { limit: 6, windowMs: MINUTE },

  // Backstop across ALL users, so a single shared or leaked account cannot
  // become the whole bill. Deliberately above any one user's cap and below the
  // sum of everyone's: honest aggregate use for a dozen testers is a few
  // hundred calls a day, so 1000 never trips by accident, while 12 users each
  // maxing their personal daily allowance (2040 calls) trips it early.
  "global:openai:burst": { limit: 60, windowMs: MINUTE },
  "global:openai:daily": { limit: 1000, windowMs: DAY },
};

/**
 * What a route asks for. Rules are checked in order and the first failure wins,
 * so per-user rules come before the global backstop: when a user is over their
 * own limit, the message should be about them, not about the service.
 */
const RULE_SETS: Record<string, readonly string[]> = {
  "upload:user": [
    "upload:user:burst",
    "upload:user:daily",
    "global:openai:burst",
    "global:openai:daily",
  ],
  "chat:user": [
    "chat:user:burst",
    "chat:user:daily",
    "global:openai:burst",
    "global:openai:daily",
  ],
  "sync:user": ["sync:user:burst"],
  "global:openai": ["global:openai:burst", "global:openai:daily"],
};

/**
 * Global rules are counted once for everyone, so they ignore the caller's key.
 * Without this a per-user key would give each user their own "global" bucket,
 * which is exactly the failure the backstop exists to prevent.
 */
const GLOBAL_BUCKET = "*";

interface Counter {
  count: number;
  /** Unix ms; the entry is dead weight once `now >= resetAt`. */
  resetAt: number;
}

const windows = new Map<string, Counter>();

/**
 * Sweeping the whole Map on every request would make the limiter O(keys) per
 * call -- the cost would grow with the abuse it is meant to survive. Amortize
 * instead: one full pass every N calls is O(1) per call on average and bounds
 * the Map at (unique keys seen within N calls), which is what actually matters.
 */
const SWEEP_EVERY = 256;
let callsSinceSweep = 0;

/** Removes windows that have already expired. Returns how many were dropped. */
export function sweepExpired(now: number = Date.now()): number {
  let dropped = 0;
  for (const [key, counter] of windows) {
    if (now >= counter.resetAt) {
      windows.delete(key);
      dropped += 1;
    }
  }
  callsSinceSweep = 0;
  return dropped;
}

function maybeSweep(now: number): void {
  callsSinceSweep += 1;
  if (callsSinceSweep >= SWEEP_EVERY) sweepExpired(now);
}

function bucketKey(key: string, rule: string): string {
  return `${rule}|${rule.startsWith("global:") ? GLOBAL_BUCKET : key}`;
}

/** The rules a caller's `rule` argument expands to. */
function rulesFor(rule: string): readonly string[] {
  const set = RULE_SETS[rule];
  if (set) return set;
  // A single rule name is also accepted, so a caller can check one window
  // directly (and so a typo fails loudly instead of silently allowing).
  if (RULES[rule]) return [rule];
  throw new Error(`Unknown rate limit rule: ${rule}`);
}

interface Evaluation {
  rule: string;
  bucket: string;
  counter: Counter;
  allowed: boolean;
  remaining: number;
}

/**
 * Fixed windows rather than sliding: the reset instant is exact, so
 * `Retry-After` is a real number instead of an estimate, and one counter per
 * key beats a timestamp array per key for memory under load. The tradeoff is
 * the usual one -- up to 2x the limit across a window boundary -- which is
 * irrelevant at these magnitudes.
 */
function evaluate(key: string, rule: string, now: number): Evaluation {
  const config = RULES[rule];
  if (!config) throw new Error(`Unknown rate limit rule: ${rule}`);

  const bucket = bucketKey(key, rule);
  const existing = windows.get(bucket);
  const counter: Counter =
    existing && now < existing.resetAt
      ? existing
      : { count: 0, resetAt: now + config.windowMs };

  const allowed = counter.count < config.limit;
  return {
    rule,
    bucket,
    counter,
    allowed,
    // What is left *after* this request would be counted, so an allowed verdict
    // reports what the caller can still do -- matching X-RateLimit-Remaining.
    remaining: allowed ? config.limit - counter.count - 1 : 0,
  };
}

/**
 * The verdict to hand back when everything passed: the window closest to
 * running out, so headers warn about the limit the user will actually hit.
 */
function tightest(evaluations: Evaluation[]): Evaluation {
  return evaluations.reduce((best, next) =>
    next.remaining < best.remaining ? next : best,
  );
}

function verdictOf(evaluation: Evaluation): LimitVerdict {
  return {
    allowed: evaluation.allowed,
    remaining: evaluation.remaining,
    resetAt: evaluation.counter.resetAt,
    rule: evaluation.rule,
  };
}

/**
 * Consumes one unit against every rule in `rule`, if and only if all of them
 * allow it.
 *
 * The two phases are the point: checking and consuming in one pass would burn a
 * unit of the per-minute allowance on a request the daily cap was going to
 * reject anyway, so a user pinned at their daily limit would also lose their
 * burst allowance for the next day.
 */
export function checkLimit(
  key: string,
  rule: string,
  now: number = Date.now(),
): LimitVerdict {
  maybeSweep(now);

  const evaluations: Evaluation[] = [];
  for (const name of rulesFor(rule)) {
    const evaluation = evaluate(key, name, now);
    // First failure wins and nothing is consumed: the caller is being turned
    // away, so it should not pay for the attempt.
    if (!evaluation.allowed) return verdictOf(evaluation);
    evaluations.push(evaluation);
  }

  for (const evaluation of evaluations) {
    evaluation.counter.count += 1;
    windows.set(evaluation.bucket, evaluation.counter);
  }

  return verdictOf(tightest(evaluations));
}

/**
 * Same answer as `checkLimit` without spending anything -- for showing a user
 * their remaining quota, or for a route that wants to know before doing work it
 * would have to throw away.
 */
export function peekLimit(
  key: string,
  rule: string,
  now: number = Date.now(),
): LimitVerdict {
  const evaluations: Evaluation[] = [];
  for (const name of rulesFor(rule)) {
    const evaluation = evaluate(key, name, now);
    if (!evaluation.allowed) return verdictOf(evaluation);
    evaluations.push(evaluation);
  }
  return verdictOf(tightest(evaluations));
}

/** Tests only. Production code has no reason to hand everyone a fresh budget. */
export function resetAllLimits(): void {
  windows.clear();
  callsSinceSweep = 0;
}

/** Diagnostics and tests: how many windows are currently held in memory. */
export function limiterSize(): number {
  return windows.size;
}

/** What a route needs to answer a denial. */
export interface LimitDenial {
  /** Seconds until the window resets -- the `Retry-After` header value. */
  retryAfterSeconds: number;
  /** One plain sentence to show the user. */
  message: string;
  rule: string;
  resetAt: number;
}

/**
 * "in 3 minutes", not "in 187 seconds". Rounds up so the stated time is never
 * optimistic -- a user who comes back exactly when told should get through.
 */
function formatWait(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / SECOND));
  if (seconds < 60) {
    return `in ${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) {
    return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const hours = Math.ceil(minutes / 60);
  return `in about ${hours} hour${hours === 1 ? "" : "s"}`;
}

/**
 * Messages state the fact and the wait, and nothing else. The people hitting
 * these limits were invited to hit them; a scolding tone would be both rude and
 * useless, and naming an exact quota just tells a tester what to script around.
 */
const MESSAGES: Record<string, (wait: string) => string> = {
  "upload:user:burst": (wait) =>
    `You've hit the upload limit. Try again ${wait}.`,
  "upload:user:daily": (wait) =>
    `You've used today's syllabus uploads. The limit resets ${wait}.`,
  "chat:user:burst": (wait) =>
    `You're asking faster than the limit allows. Try again ${wait}.`,
  "chat:user:daily": (wait) =>
    `You've used today's questions. The limit resets ${wait}.`,
  "sync:user:burst": (wait) =>
    `Calendar sync is rate limited. Try again ${wait}.`,
  "global:openai:burst": (wait) =>
    `Syllabus AI is handling a lot of requests right now. Try again ${wait}.`,
  "global:openai:daily": (wait) =>
    `Syllabus AI has reached its shared daily usage cap. It resets ${wait}.`,
};

/**
 * Turns a verdict into the numbers and words a 429 needs. Safe to call on an
 * allowed verdict (routes rarely need to), in which case it just describes when
 * the tightest window rolls over.
 */
export function describeLimit(
  verdict: LimitVerdict,
  now: number = Date.now(),
): LimitDenial {
  const waitMs = Math.max(0, verdict.resetAt - now);
  const wait = formatWait(waitMs);
  const build =
    MESSAGES[verdict.rule] ??
    ((w: string) => `You've hit a usage limit. Try again ${w}.`);

  return {
    retryAfterSeconds: Math.max(1, Math.ceil(waitMs / SECOND)),
    message: build(wait),
    rule: verdict.rule,
    resetAt: verdict.resetAt,
  };
}
