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
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

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

  // One Notion sync is ~40 requests against an integration-wide 3/s budget
  // shared by every user. 4/min per person covers "sync, fix a date, sync
  // again" and stops a mashed button from starving everyone else.
  "notion:user:burst": { limit: 4, windowMs: MINUTE },

  // Confirming and correcting extracted items costs nothing -- no model call,
  // one small row update -- so this cap exists only to stop a script, never a
  // person. A student fixing a badly-parsed syllabus works down the list fast:
  // confirm, confirm, fix a date, confirm. 60/min is roughly one action per
  // second sustained for a minute, which no one reaches by hand and any loop
  // blows past immediately. Deliberately the loosest rule in this file; there
  // is nothing to protect here but the database's dignity.
  "edit:user:burst": { limit: 60, windowMs: MINUTE },

  // The feed is unauthenticated -- the token is the credential -- so the
  // limit is per token, and generous: Apple Calendar polls hourly, Outlook
  // every few hours; 30/min only ever trips on a script.
  "feed:token:burst": { limit: 30, windowMs: MINUTE },

  /**
   * A visitor with no account yet, metered by IP instead of by user id.
   *
   * THIS IS THE RULE THAT MAKES THE OTHERS MEAN ANYTHING on the money routes.
   * Every per-user cap above assumes an account is expensive to obtain, and for
   * a signed-in user it is -- it costs a Google login. A demo sandbox costs
   * nothing: send no cookie and the server mints one, with a brand-new upload
   * budget attached. So a script that drops its cookie between requests has an
   * unlimited allowance of model calls, and "3 uploads a minute per user" caps
   * nothing at all. Keying the demo budget to the network the request came from
   * is what closes that, because an IP is the one thing minting a fresh account
   * does not change.
   *
   * Sized to be generous to the visitor this is FOR -- someone trying the app
   * before signing up, who uploads one or two syllabi and decides. Beyond that
   * the answer is "sign in", which is a better funnel anyway than an anonymous
   * stranger burning model budget.
   *
   * Signed-in users never touch these rules. Campus NAT puts a whole dorm on
   * one address, which would be a real problem if this metered everybody --
   * it is exactly why the cap applies only before sign-in, and why hitting it
   * offers a Google button rather than a wait.
   */
  "demo:ip:burst": { limit: 3, windowMs: 10 * MINUTE },
  "demo:ip:daily": { limit: 8, windowMs: DAY },

  // Backstop across ALL users, so a single shared or leaked account cannot
  // become the whole bill. Deliberately above any one user's cap and below the
  // sum of everyone's.
  //
  // Tunable from the environment because the right number is a function of how
  // many people are using the app, and that changes faster than a deploy: a
  // dozen invited testers and a thousand students off an ad campaign want very
  // different ceilings, and the failure mode of leaving it at the smaller one
  // is that legitimate users get turned away. See OPENAI_GLOBAL_* in
  // .env.example. The defaults below are sized for roughly a thousand users.
  //
  // Held in memory, so on serverless this is a PER-INSTANCE circuit breaker,
  // not a true global ceiling -- N warm instances means N times the number. It
  // is a fast local brake, and the hard stop is the monthly spend limit set on
  // the OpenAI account itself. Set one; this is not a substitute.
  /**
   * Alert-email throttling. Not a user limit at all -- the "caller" here is the
   * logger, and the resource being protected is the operator's inbox.
   *
   * Reusing this module rather than writing a second counter, because dedupe IS
   * a fixed window: "at most one of these per hour" is the same question
   * `checkLimit` already answers, and a bespoke Map in the alerting code would
   * be the same bug surface again with none of the tests.
   *
   * Two windows, and both are load-bearing. The per-event cooldown is what stops
   * a single broken route from sending one email per request -- a stream of
   * identical alerts is how an operator learns to filter the alert address to
   * trash, which is worse than no alerting at all. The global cap is the
   * backstop for the case the cooldown cannot catch: a deploy that breaks
   * everything at once produces many DIFFERENT event names, each of which passes
   * its own cooldown. Twenty an hour is enough to understand an incident and few
   * enough that a provider does not start treating the domain as a spammer.
   */
  "alert:event:cooldown": { limit: 1, windowMs: HOUR },
  "global:alerts:hourly": { limit: 20, windowMs: HOUR },

  "global:openai:burst": {
    limit: envLimit("OPENAI_GLOBAL_BURST_CAP", 120),
    windowMs: MINUTE,
  },
  "global:openai:daily": {
    limit: envLimit("OPENAI_GLOBAL_DAILY_CAP", 5000),
    windowMs: DAY,
  },
};

/**
 * A positive integer from the environment, or the default.
 *
 * Read once at module load: these are deployment-wide ceilings, not per-request
 * settings, and re-reading env on every rate-limit check would put a syscall on
 * the hot path of the thing meant to be cheap. Anything unparseable or
 * non-positive falls back rather than throwing -- a typo in a hosting dashboard
 * should degrade to the documented default, not take the site down.
 */
function envLimit(name: string, fallback: number): number {
  const parsed = Number.parseInt((process.env[name] ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

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
  "notion:user": ["notion:user:burst"],
  // No daily companion and no global backstop: edits spend nothing, so there
  // is no bill for either to protect.
  "edit:user": ["edit:user:burst"],
  "feed:token": ["feed:token:burst"],
  // Checked IN ADDITION TO the per-user set, only for visitors with no account.
  "demo:ip": ["demo:ip:burst", "demo:ip:daily"],
  // Cooldown first, so a repeat of one event says so rather than blaming the
  // global cap -- the two denials mean very different things when you are
  // reading the logs afterwards to find out what you were not told about.
  "alert:email": ["alert:event:cooldown", "global:alerts:hourly"],
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
  "notion:user:burst": (wait) =>
    `Notion sync is rate limited. Try again ${wait}.`,
  "edit:user:burst": (wait) =>
    `You're making changes faster than the limit allows. Try again ${wait}.`,
  "feed:token:burst": (wait) =>
    `This calendar feed is being fetched too often. Try again ${wait}.`,
  "global:openai:burst": (wait) =>
    `Syllabus Center is handling a lot of requests right now. Try again ${wait}.`,
  "global:openai:daily": (wait) =>
    `Syllabus Center has reached its shared daily usage cap. It resets ${wait}.`,
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
