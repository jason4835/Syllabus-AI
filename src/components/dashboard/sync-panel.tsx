"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CalendarSyncResult } from "@/lib/types";
import { apiGet, apiPost } from "@/components/api-client";
import { Panel } from "@/components/ui/panel";
import { Button, Spinner } from "@/components/ui/button";
import { ErrorState, Note } from "@/components/ui/states";
import { LoadingRegion, SkeletonRows } from "@/components/ui/skeleton";
import { AlertIcon, CalendarIcon, CheckIcon } from "@/components/icons";

type State =
  | { kind: "idle" }
  | { kind: "syncing" }
  | { kind: "done"; result: CalendarSyncResult }
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
}: {
  demoMode: boolean;
  googleReady: boolean;
  hasCourses: boolean;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });

  async function sync() {
    setState({ kind: "syncing" });
    const result = await apiPost<CalendarSyncResult>("/api/sync", {});
    if (!result.ok) {
      // 429 arrives as an ordinary envelope whose message states the wait, so
      // it reads correctly here with no special case.
      setState({ kind: "error", error: result.error, detail: result.detail });
      return;
    }
    setState({ kind: "done", result: result.data });
  }

  return (
    <Panel
      id="sync"
      title="Calendar sync"
      icon={<CalendarIcon width={17} height={17} />}
      description={
        demoMode
          ? "Dry run — nothing is written to a real calendar."
          : "Push every deadline, study block and class meeting to your calendar."
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

        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={() => void sync()}
            disabled={state.kind === "syncing" || !hasCourses}
          >
            {state.kind === "syncing" ? (
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
          {!hasCourses ? (
            <p className="text-[0.8125rem] text-muted">
              Upload a syllabus first — there is nothing to sync yet.
            </p>
          ) : null}
        </div>

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
            onRetry={() => void sync()}
          />
        ) : null}

        {state.kind === "done" ? (
          <div className="rise rounded-lg border border-line bg-sunken/60 p-4">
            <p className="flex items-center gap-1.5 text-[0.8125rem] font-semibold text-ok">
              <CheckIcon width={15} height={15} />
              {demoMode ? "Dry run complete" : "Sync complete"}
            </p>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
              <Stat label="Created" value={state.result.created} />
              <Stat label="Updated" value={state.result.updated} />
              <Stat label="Skipped" value={state.result.skipped} />
              <Stat
                label="Class schedules"
                value={state.result.classSeries ?? 0}
                note="one per meeting pattern"
              />
            </dl>
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
          </div>
        ) : null}

        <FeedSection demoMode={demoMode} />
      </div>
    </Panel>
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
  const address = feed?.webcal ?? feed?.url ?? null;

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
          deadlines, study blocks and class meetings stay current without
          another sync.
        </p>
      </div>

      {demoMode ? (
        <Note>
          This is the shared demo feed — everyone trying the demo subscribes to
          the same one. Sign in and it becomes yours alone.
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
