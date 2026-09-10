"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CalendarPrefs, CalendarSyncResult, Course, User } from "@/lib/types";
import { DEFAULT_CALENDAR_PREFS } from "@/lib/types";
import {
  apiGet,
  apiPatch,
  apiPost,
  parseRetryAfterSeconds,
} from "@/components/api-client";
import { Panel } from "@/components/ui/panel";
import { Button, Spinner } from "@/components/ui/button";
import { ErrorState, Note } from "@/components/ui/states";
import { LoadingRegion, SkeletonRows } from "@/components/ui/skeleton";
import { AlertIcon, CalendarIcon, CheckIcon } from "@/components/icons";
import { formatDateShort } from "@/components/format";

/** `POST /api/sync` answers with the result plus which mode it ran in. */
type SyncResponse = CalendarSyncResult & { dryRun?: boolean };

type State =
  | { kind: "idle" }
  /** `dry` is what was asked for; the result says what actually ran. */
  | { kind: "running"; dry: boolean }
  | { kind: "done"; dry: boolean; result: SyncResponse }
  | { kind: "error"; error: string; detail?: string };

/**
 * Shape of `GET /api/me/feed`. Declared here rather than in `src/lib/types.ts`
 * because it is a view model this panel is the only consumer of -- same call
 * the Notion panel makes for its status.
 */
export interface FeedInfo {
  /** https:// form of the feed -- what Outlook and Google want pasted in. */
  url: string | null;
  /** webcal:// form -- what macOS/iOS hand straight to Calendar. */
  webcal: string | null;
}

type FeedState =
  | { kind: "loading" }
  | { kind: "ready"; feed: FeedInfo }
  | { kind: "error"; error: string; detail?: string };

/** Neither field is worth a second request: each is the other with a scheme swap. */
function normalizeFeed(raw: Partial<FeedInfo> | null | undefined): FeedInfo {
  const url = typeof raw?.url === "string" && raw.url ? raw.url : null;
  const webcal = typeof raw?.webcal === "string" && raw.webcal ? raw.webcal : null;
  return {
    url: url ?? (webcal ? webcal.replace(/^webcal:/i, "https:") : null),
    webcal: webcal ?? (url ? url.replace(/^https?:/i, "webcal:") : null),
  };
}

export function SyncPanel({
  demoMode,
  googleReady,
  hasCourses,
  courses = [],
  onChooseSection,
}: {
  demoMode: boolean;
  googleReady: boolean;
  hasCourses: boolean;
  /** Only to name the courses a sync result reports back by id. */
  courses?: Course[];
  /** Send the student to that course's chooser on the roadmap. */
  onChooseSection?: (courseId: string) => void;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  /**
   * A 429 left the button enabled and the message static, so the honest
   * response — press it again in forty seconds — read as press it again now.
   * The wait comes out of the message the envelope carries, the same way the
   * Notion panel reads it, and ticks down in front of the student.
   */
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (cooldownUntil === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [cooldownUntil]);

  const cooldownLeft =
    cooldownUntil === null
      ? 0
      : Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
  const running = state.kind === "running";
  const blocked = running || cooldownLeft > 0 || !hasCourses;

  async function sync(dry: boolean) {
    setState({ kind: "running", dry });
    const result = await apiPost<SyncResponse>(
      "/api/sync",
      dry ? { dryRun: true } : {},
    );
    if (!result.ok) {
      setState({ kind: "error", error: result.error, detail: result.detail });
      const seconds = parseRetryAfterSeconds(result.error, result.detail);
      if (seconds !== null) {
        setNow(Date.now());
        setCooldownUntil(Date.now() + seconds * 1000);
      }
      return;
    }
    setState({ kind: "done", dry, result: result.data });
  }

  return (
    <Panel
      id="sync"
      title="Calendar sync"
      icon={<CalendarIcon width={17} height={17} />}
      description={
        demoMode
          ? "Dry run — nothing is written to a real calendar."
          : "Sync every deadline, study session and class meeting to your calendar."
      }
    >
      <div className="space-y-4">
        {demoMode ? (
          <Note>
            Demo mode reports exactly what <em>would</em> be created, updated and
            skipped. Connect a Google account to write these events for real.
          </Note>
        ) : !googleReady ? (
          <Note tone="warn">
            Google Calendar is not configured on this server, so sync will fail
            until the Google credentials are set.
          </Note>
        ) : null}

        <CalendarPrefsSection />

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void sync(false)} disabled={blocked}>
            {running && !state.dry ? (
              <>
                <Spinner label="Syncing" />
                Syncing…
              </>
            ) : (
              <>
                <CalendarIcon width={16} height={16} />
                {demoMode ? "Preview the sync" : "Sync to Google Calendar"}
              </>
            )}
          </Button>
          {/* The removals are the part nobody expects, so there is a way to
              read them before anything is written rather than after. */}
          <Button
            variant="secondary"
            onClick={() => void sync(true)}
            disabled={blocked}
          >
            {running && state.dry ? (
              <>
                <Spinner label="Checking what will change" />
                Checking…
              </>
            ) : (
              "See what will change"
            )}
          </Button>
          {!hasCourses ? (
            <p className="text-[0.8125rem] text-muted">
              Upload a syllabus first — there is nothing to sync yet.
            </p>
          ) : null}
        </div>

        {cooldownLeft > 0 ? (
          <p
            role="status"
            className="text-[0.8125rem] leading-relaxed text-muted"
          >
            Too many syncs in a row — you can sync again in{" "}
            <span className="font-mono text-ink tabular-nums">
              {formatWait(cooldownLeft)}
            </span>
            .
          </p>
        ) : null}

        <p className="text-[0.75rem] leading-relaxed text-muted">
          Class meetings go across as recurring events — one series per meeting
          pattern — with the holidays and breaks your syllabus names skipped, so
          a reading week stays empty instead of filling with a class that
          isn&rsquo;t happening.
        </p>

        {state.kind === "error" ? (
          <ErrorState
            error={state.error}
            detail={state.detail}
            onRetry={
              cooldownLeft > 0 ? undefined : () => void sync(false)
            }
          />
        ) : null}

        {state.kind === "done" ? (
          (() => {
            // A dry run is what was asked for, or what the server fell back to
            // with no Google account attached; either way nothing was written.
            const preview = state.dry || state.result.dryRun === true;
            const removedItems = state.result.removedItems ?? [];
            const removed = state.result.removed ?? 0;
            return (
          <div
            role="status"
            className="rise rounded-lg border border-line bg-sunken/60 p-4"
          >
            <p className="flex items-center gap-1.5 text-[0.8125rem] font-semibold text-ok">
              <CheckIcon width={15} height={15} />
              {preview
                ? "Nothing written yet — here is what this sync would do"
                : "Sync complete"}
            </p>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
              <Stat
                label={preview ? "To create" : "Created"}
                value={state.result.created}
              />
              <Stat
                label={preview ? "To update" : "Updated"}
                value={state.result.updated}
              />
              <Stat label="Skipped" value={state.result.skipped} />
              <Stat
                label="Class schedules"
                value={state.result.classSeries ?? 0}
                note="one per meeting pattern"
              />
            </dl>
            {/* Removals are the quiet half of a sync and the half a student
                otherwise meets as events silently missing. "No longer in your
                syllabus" was the rare case; a moved date or a type switched
                off above is the ordinary one, so the copy says so and the
                titles are listed rather than counted. */}
            {removed > 0 ? (
              <div className="mt-2 rounded-md border border-line bg-surface px-3 py-2">
                <p className="text-[0.8125rem] leading-relaxed text-ink-soft">
                  <span className="font-mono text-ink tabular-nums">
                    {removed}
                  </span>{" "}
                  {preview
                    ? `${removed === 1 ? "event will be" : "events will be"} removed`
                    : `${removed === 1 ? "event was" : "events were"} removed`}{" "}
                  — the date moved, the item is gone from your syllabus, or you
                  switched that type off above.
                </p>
                {removedItems.length > 0 ? (
                  <ul className="mt-2 space-y-1">
                    {removedItems.map((item) => (
                      <li
                        key={item.key}
                        className="flex flex-wrap items-baseline justify-between gap-x-3 text-[0.8125rem] leading-relaxed text-ink"
                      >
                        <span className="min-w-0">{item.title}</span>
                        <span className="font-mono text-[0.75rem] text-muted tabular-nums">
                          {item.start ? formatDateShort(item.start) : "no date"}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {(state.result.needsSection ?? []).length > 0 ? (
              <div className="mt-3">
                <Note tone="warn">
                  <span className="block">
                    Class meetings were skipped for{" "}
                    {courseCodes(courses, state.result.needsSection).join(", ")} —
                    the syllabus lists several sections and we won&rsquo;t guess
                    which one is yours.
                  </span>
                  <span className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                    {state.result.needsSection.map((courseId) => (
                      <SectionJump
                        key={courseId}
                        code={courseCode(courses, courseId)}
                        onClick={
                          onChooseSection
                            ? () => onChooseSection(courseId)
                            : undefined
                        }
                        courseId={courseId}
                      />
                    ))}
                  </span>
                </Note>
              </div>
            ) : null}

            <p className="mt-3 text-[0.75rem] text-muted">
              Calendar:{" "}
              <code className="rounded-sm bg-raised px-1 py-0.5 font-mono text-ink-soft">
                {state.result.calendarId || "—"}
              </code>
            </p>
            {state.result.errors.length > 0 ? (
              <ul className="mt-3 space-y-1.5">
                {state.result.errors.map((message, index) => (
                  <li
                    key={`${message}-${index}`}
                    className="flex items-start gap-2 rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-[0.8125rem] leading-relaxed text-ink"
                  >
                    <span className="mt-0.5 shrink-0 text-danger">
                      <AlertIcon width={13} height={13} />
                    </span>
                    {message}
                  </li>
                ))}
              </ul>
            ) : null}

            {/* A preview ends where the decision is: next to what it found. */}
            {preview && !demoMode ? (
              <div className="mt-3">
                <Button
                  size="sm"
                  onClick={() => void sync(false)}
                  disabled={blocked}
                >
                  <CalendarIcon width={15} height={15} />
                  Sync it for real
                </Button>
              </div>
            ) : null}
          </div>
            );
          })()
        ) : null}

        <FeedSection demoMode={demoMode} />
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* Courses a sync could not finish                                            */
/* -------------------------------------------------------------------------- */

function courseCode(courses: Course[], courseId: string): string {
  return courses.find((course) => course.id === courseId)?.code ?? "a course";
}

function courseCodes(courses: Course[], ids: string[]): string[] {
  return ids.map((id) => courseCode(courses, id));
}

/**
 * A jump, not a route: the chooser is already on this page, a panel away. The
 * anchor is the fallback for a shell that did not hand us a handler — it still
 * lands on the course card rather than nowhere.
 */
function SectionJump({
  code,
  courseId,
  onClick,
}: {
  code: string;
  courseId: string;
  onClick?: () => void;
}) {
  const className =
    "rounded-sm text-[0.8125rem] font-medium text-ink underline decoration-warn-line underline-offset-2 transition-colors hover:text-accent";
  if (!onClick) {
    return (
      <a href={`#roadmap-card-${courseId}`} className={className}>
        {code}: Choose your section
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className={className}>
      {code}: Choose your section
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* What to add                                                                */
/* -------------------------------------------------------------------------- */

const PREF_ROWS: { key: keyof CalendarPrefs; label: string }[] = [
  { key: "classes", label: "Class meetings" },
  { key: "recitations", label: "Recitations & labs" },
  { key: "officeHours", label: "Office hours" },
  { key: "deadlines", label: "Deadlines & exams" },
  { key: "studySessions", label: "Study sessions" },
];

/** Defaults for anything the server did not say, so a stale shape still renders. */
function mergePrefs(raw: Partial<CalendarPrefs> | null | undefined): CalendarPrefs {
  const merged = { ...DEFAULT_CALENDAR_PREFS };
  for (const { key } of PREF_ROWS) {
    if (typeof raw?.[key] === "boolean") merged[key] = raw[key];
  }
  return merged;
}

/**
 * Five checkboxes standing between a syllabus and a calendar. They save one at
 * a time, immediately: a "Save preferences" button would be one more thing to
 * forget before pressing Sync, and the cost of a failed write is a checkbox
 * that flips back, which is exactly what happened.
 */
function CalendarPrefsSection() {
  const headingId = useId();
  const [prefs, setPrefs] = useState<CalendarPrefs | null>(null);
  const [saving, setSaving] = useState<keyof CalendarPrefs | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void apiGet<User | null>("/api/me").then((result) => {
      if (!live) return;
      // A 404, a signed-out session, a server without the field yet: the
      // honest answer in every case is the documented default set.
      setPrefs(mergePrefs(result.ok ? result.data?.calendarPrefs : null));
    });
    return () => {
      live = false;
    };
  }, []);

  async function toggle(key: keyof CalendarPrefs, value: boolean) {
    if (!prefs) return;
    const previous = prefs;
    setPrefs({ ...prefs, [key]: value });
    setSaving(key);
    setFailure(null);
    const result = await apiPatch<Partial<CalendarPrefs>>(
      "/api/me/calendar-prefs",
      { [key]: value },
    );
    setSaving(null);
    if (!result.ok) {
      // Rolled back rather than left looking saved: the next sync would follow
      // the server's copy, not the box on screen.
      setPrefs(previous);
      setFailure(result.detail ?? result.error);
      return;
    }
    setPrefs(mergePrefs({ ...previous, [key]: value, ...result.data }));
  }

  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <div>
        <h3 id={headingId} className="text-[0.875rem] font-semibold text-ink">
          What to add
        </h3>
        <p className="mt-1 text-[0.8125rem] leading-relaxed text-muted">
          Applies to the Google sync, the subscription feed and your Notion
          pages, and anything you switch off is removed from them on the next
          sync. Notion has no class meetings, so that one switch is calendars
          only.
        </p>
      </div>

      {!prefs ? (
        <LoadingRegion label="Loading what your calendar includes">
          <SkeletonRows rows={2} />
        </LoadingRegion>
      ) : (
        <ul className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
          {PREF_ROWS.map(({ key, label }) => (
            <li key={key}>
              <label className="flex items-start gap-2.5 text-[0.8125rem] leading-relaxed text-ink">
                <input
                  type="checkbox"
                  checked={prefs[key]}
                  disabled={saving === key}
                  onChange={(event) => void toggle(key, event.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[color:var(--color-accent)]"
                />
                {label}
              </label>
            </li>
          ))}
        </ul>
      )}

      {failure ? (
        <p
          role="alert"
          className="rounded-md border border-danger-line bg-danger-soft px-2.5 py-1.5 text-[0.75rem] leading-relaxed text-danger"
        >
          That didn&rsquo;t save — {failure}
        </p>
      ) : null}
    </section>
  );
}

function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: number;
  note?: string;
}) {
  return (
    <div className="rounded-md border border-line bg-surface px-2 py-3">
      <dt className="text-[0.6875rem] font-semibold tracking-[0.1em] text-muted uppercase">
        {label}
      </dt>
      <dd className="mt-1 font-mono text-[1.375rem] leading-none text-ink tabular-nums">
        {value}
      </dd>
      {note ? (
        <dd className="mt-1.5 text-[0.6875rem] leading-snug text-muted">{note}</dd>
      ) : null}
    </div>
  );
}

/** "45s", "2m 05s" — a countdown reads worse as a bare number of seconds. */
function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/* -------------------------------------------------------------------------- */
/* Subscription feed                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The Google sync above writes events into a calendar. This writes nothing:
 * it hands out a URL any calendar app can subscribe to and re-read forever,
 * which is the only route Apple Calendar and Outlook offer.
 */
function FeedSection({ demoMode }: { demoMode: boolean }) {
  const [state, setState] = useState<FeedState>({ kind: "loading" });
  const [pending, setPending] = useState<null | "create" | "reset">(null);
  const [failure, setFailure] = useState<{ error: string; detail?: string } | null>(
    null,
  );
  const [confirmingReset, setConfirmingReset] = useState(false);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const result = await apiGet<Partial<FeedInfo>>("/api/me/feed");
    if (!result.ok) {
      setState({ kind: "error", error: result.error, detail: result.detail });
      return;
    }
    setState({ kind: "ready", feed: normalizeFeed(result.data) });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function write(mode: "create" | "reset") {
    setPending(mode);
    setFailure(null);
    const result = await apiPost<Partial<FeedInfo>>(
      "/api/me/feed",
      mode === "reset" ? { reset: true } : {},
    );
    setPending(null);
    if (!result.ok) {
      // Same handling as the sync button: a 429 states its own wait, so the
      // envelope's message is the whole story.
      setFailure({ error: result.error, detail: result.detail });
      return;
    }
    setConfirmingReset(false);
    setState({ kind: "ready", feed: normalizeFeed(result.data) });
  }

  const feed = state.kind === "ready" ? state.feed : null;
  /**
   * The https form is what goes in the box, because Google Calendar's
   * "From URL" rejects a webcal: address outright -- handing it out was
   * breaking the one path built for people who do not connect Google.
   * webcal: stays on the Apple Calendar link, where it opens the app directly.
   */
  const address = feed?.url ?? feed?.webcal ?? null;

  return (
    <section
      aria-labelledby="sync-feed-heading"
      className="space-y-3 border-t border-line pt-4"
    >
      <div>
        <h3
          id="sync-feed-heading"
          className="text-[0.875rem] font-semibold text-ink"
        >
          Subscribe from any calendar
        </h3>
        <p className="mt-1 text-[0.8125rem] leading-relaxed text-muted">
          Apple Calendar, Outlook, Fantastical — anything that takes a
          subscription URL. The feed is read-only and refreshes itself, so
          deadlines, study sessions and class meetings stay current without
          another sync.
        </p>
      </div>

      {demoMode ? (
        <Note>
          You&rsquo;re on a sample semester, so this feed carries the sample
          courses. Upload your own syllabus and it updates. Sign in to keep it
          past this visit.
        </Note>
      ) : null}

      {state.kind === "loading" ? (
        <LoadingRegion label="Checking your calendar feed">
          <SkeletonRows rows={1} />
        </LoadingRegion>
      ) : state.kind === "error" ? (
        <ErrorState
          error={state.error}
          detail={state.detail}
          onRetry={() => void load()}
        />
      ) : !address ? (
        <div className="space-y-3">
          <p className="text-[0.8125rem] leading-relaxed text-ink-soft">
            You don&rsquo;t have a feed link yet. Creating one takes a second and
            nothing is published until you share the link.
          </p>
          <Button onClick={() => void write("create")} disabled={pending !== null}>
            {pending === "create" ? (
              <>
                <Spinner label="Creating your feed link" />
                Creating…
              </>
            ) : (
              <>
                <CalendarIcon width={16} height={16} />
                Create feed link
              </>
            )}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <FeedAddress address={address} />

          <div className="flex flex-wrap items-center gap-2">
            {/* A real navigation, not a fetch: Safari/macOS hand webcal: to
                Calendar, which is the whole point of the link. */}
            <a
              href={address}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-[0.8125rem] font-medium text-ink transition-colors hover:bg-raised"
            >
              <CalendarIcon width={15} height={15} />
              Open in Apple Calendar
            </a>
          </div>

          <p className="text-[0.75rem] leading-relaxed text-muted">
            Anyone with this link can read your schedule — treat it like a
            password, and reset it if it gets out.
          </p>

          <ResetControl
            confirming={confirmingReset}
            pending={pending === "reset"}
            onAsk={() => setConfirmingReset(true)}
            onCancel={() => setConfirmingReset(false)}
            onConfirm={() => void write("reset")}
          />
        </div>
      )}

      {failure ? (
        <ErrorState
          error={failure.error}
          detail={failure.detail}
          onRetry={() => setFailure(null)}
        />
      ) : null}
    </section>
  );
}

/** The URL plus its Copy button. Long, unbreakable text — it scrolls, never wraps. */
function FeedAddress({ address }: { address: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const timers = useRef<number[]>([]);
  const [confirm, setConfirm] = useState<
    null | { mode: "copied" | "selected"; fading: boolean }
  >(null);

  useEffect(
    () => () => {
      for (const timer of timers.current) window.clearTimeout(timer);
    },
    [],
  );

  function announce(mode: "copied" | "selected") {
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current = [];
    setConfirm({ mode, fading: false });
    timers.current.push(
      window.setTimeout(() => setConfirm({ mode, fading: true }), 1500),
      window.setTimeout(() => setConfirm(null), 2100),
    );
  }

  async function copy() {
    // Selecting the text is not a consolation prize: without the clipboard API
    // (an insecure origin, an old browser) it is exactly what the user needs
    // before pressing the shortcut themselves.
    const selectInstead = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
      announce("selected");
    };

    if (!navigator.clipboard?.writeText) {
      selectInstead();
      return;
    }
    try {
      await navigator.clipboard.writeText(address);
      announce("copied");
    } catch {
      selectInstead();
    }
  }

  return (
    <div>
      <div className="flex min-w-0 items-stretch gap-2">
        <input
          ref={inputRef}
          type="text"
          readOnly
          value={address}
          aria-label="Your calendar feed URL"
          onFocus={(event) => event.currentTarget.select()}
          className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-line bg-sunken/60 px-3 py-1.5 font-mono text-[0.75rem] text-ink-soft outline-none focus:border-accent-line"
        />
        <Button variant="secondary" size="sm" onClick={() => void copy()}>
          Copy
        </Button>
      </div>
      {/* Fixed slot: the confirmation must not shove the reset control down. */}
      <p
        role="status"
        aria-live="polite"
        className={`mt-1 h-4 text-[0.75rem] text-ok transition-opacity duration-500 ${
          confirm && !confirm.fading ? "opacity-100" : "opacity-0"
        }`}
      >
        {confirm?.mode === "selected"
          ? "Selected — press ⌘C to copy"
          : confirm
            ? "Copied"
            : ""}
      </p>
    </div>
  );
}

function ResetControl({
  confirming,
  pending,
  onAsk,
  onCancel,
  onConfirm,
}: {
  confirming: boolean;
  pending: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!confirming) {
    return (
      <Button variant="ghost" size="sm" onClick={onAsk}>
        Reset link
      </Button>
    );
  }

  return (
    <div className="space-y-2.5">
      <p className="text-[0.8125rem] leading-relaxed text-ink-soft">
        Reset the link? The old link stops working immediately, and every
        calendar already subscribed to it will need the new one.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={onConfirm} disabled={pending}>
          {pending ? (
            <>
              <Spinner label="Resetting your feed link" />
              Resetting…
            </>
          ) : (
            "Yes, reset it"
          )}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          Keep this link
        </Button>
      </div>
    </div>
  );
}
