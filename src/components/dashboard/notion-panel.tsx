"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { SVGProps } from "react";
import type { Course, NotionSyncResult } from "@/lib/types";
import { apiPost } from "@/components/api-client";
import { Panel } from "@/components/ui/panel";
import { Button, LinkButton, Spinner } from "@/components/ui/button";
import { ErrorState, Note } from "@/components/ui/states";
import { LoadingRegion, SkeletonRows } from "@/components/ui/skeleton";
import { AlertIcon, CheckIcon } from "@/components/icons";
import { pluralize } from "@/components/format";

/**
 * Shape of `GET /api/notion/status`, declared here rather than in
 * `src/lib/types.ts` because it is a view model: the panel and the shell are
 * its only consumers, exactly like `UploadResult` next door.
 */
export interface NotionCandidate {
  id: string;
  title: string;
  url: string;
}

export interface NotionStatus {
  /** NOTION_CLIENT_ID + SECRET present on the server. */
  configured: boolean;
  connected: boolean;
  status: "connected" | "needs_parent" | "revoked" | null;
  workspaceName: string | null;
  /** The "Syllabus AI" hub page, once built. */
  hubUrl: string | null;
  needsParent: boolean;
  /** Pages the user shared during consent, when more than one came back. */
  candidates: NotionCandidate[];
  /** courseId -> Notion page URL, lifted into the shell for the roadmap. */
  coursePages: Record<string, string>;
}

type SyncResponse = NotionSyncResult & { dryRun: boolean };

/**
 * One action at a time -- the panel never runs two writes at once, so a single
 * union is both the "what is happening" and the "what came back".
 */
type Action =
  | { kind: "idle" }
  | { kind: "building"; pageId: string }
  /** `auto` marks the one sync the panel starts by itself, so it can say so. */
  | { kind: "syncing"; auto?: boolean }
  | { kind: "disconnecting" }
  | { kind: "synced"; result: SyncResponse }
  | { kind: "error"; error: string; detail?: string };

export function NotionPanel({
  status,
  loading,
  error,
  hasCourses,
  courses,
  justConnected = false,
  onStatus,
  onReload,
}: {
  status: NotionStatus | null;
  loading: boolean;
  error?: { error: string; detail?: string };
  hasCourses: boolean;
  /** Needed whole, not just counted: the nudge names how many are missing. */
  courses: Course[];
  /**
   * True on the `?notion=connected` return, which the shell detects. Connecting
   * and then having to find a Sync button is a step the user did not ask for,
   * so that one arrival backfills by itself.
   */
  justConnected?: boolean;
  /** `POST /api/notion/parent` answers with a fresh status -- adopt it. */
  onStatus: (status: NotionStatus) => void;
  onReload: () => void;
}) {
  const radioName = useId();
  const [action, setAction] = useState<Action>({ kind: "idle" });
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // A rate-limited sync must not be re-triggerable until the window rolls over,
  // so the countdown ticks the component once a second while one is running.
  useEffect(() => {
    if (cooldownUntil === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [cooldownUntil]);

  const failedRef = useRef<(result: { error: string; detail?: string }) => void>(
    () => {},
  );

  const cooldownLeft =
    cooldownUntil === null ? 0 : Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
  const busy =
    action.kind === "building" ||
    action.kind === "syncing" ||
    action.kind === "disconnecting";

  const onReloadRef = useRef(onReload);
  onReloadRef.current = onReload;

  function failed(result: { error: string; detail?: string }) {
    setAction({ kind: "error", error: result.error, detail: result.detail });
    // The shared client hands back the envelope, not the response headers, so
    // `Retry-After` is unreachable here. The 429 body states the wait in words
    // ("Try again in 40 seconds."), which is the same number -- read it there.
    const seconds = parseWait(`${result.error} ${result.detail ?? ""}`);
    if (seconds !== null) {
      setNow(Date.now());
      setCooldownUntil(Date.now() + seconds * 1000);
    }
  }
  failedRef.current = failed;

  const sync = useCallback(
    async (auto = false) => {
      setAction({ kind: "syncing", auto });
      const result = await apiPost<SyncResponse>("/api/notion/sync", {});
      if (!result.ok) {
        failedRef.current(result);
        return;
      }
      setAction({ kind: "synced", result: result.data });
      onReloadRef.current();
    },
    [],
  );

  async function chooseParent(pageId: string) {
    setAction({ kind: "building", pageId });
    const result = await apiPost<NotionStatus>("/api/notion/parent", { pageId });
    if (!result.ok) {
      failed(result);
      return;
    }
    setAction({ kind: "idle" });
    onStatus(result.data);
  }

  async function disconnect() {
    setAction({ kind: "disconnecting" });
    const result = await apiPost<{ disconnected: boolean }>(
      "/api/notion/disconnect",
    );
    if (!result.ok) {
      failed(result);
      return;
    }
    setConfirmingDisconnect(false);
    setAction({ kind: "idle" });
    onReload();
  }

  const configured = status?.configured ?? false;
  const revoked = status?.status === "revoked";
  const needsParent = (status?.needsParent ?? false) || status?.status === "needs_parent";
  const connected = (status?.connected ?? false) && !revoked && !needsParent;

  // A course with no page in `coursePages` has never reached Notion. That is
  // the whole definition of "behind", and both the auto-backfill and the
  // standing nudge below are read off it.
  const pages = status?.coursePages;
  const missing = courses.filter((course) => !pages?.[course.id]).length;

  // Ref, not state: the arrival must backfill exactly once, and StrictMode
  // runs this effect twice.
  const backfilled = useRef(false);

  useEffect(() => {
    if (backfilled.current) return;
    if (!justConnected || !connected || missing === 0) return;
    backfilled.current = true;
    void sync(true);
  }, [justConnected, connected, missing, sync]);

  return (
    <Panel
      id="notion"
      title="Notion"
      icon={<NotionIcon width={17} height={17} />}
      description={
        connected
          ? "Keep a Notion hub of courses, assignments and study sessions in step with your semester."
          : "Build a Notion hub of your courses, deadlines and study sessions."
      }
    >
      {loading && !status ? (
        <LoadingRegion label="Checking your Notion connection">
          <SkeletonRows rows={2} />
        </LoadingRegion>
      ) : error ? (
        <ErrorState error={error.error} detail={error.detail} onRetry={onReload} />
      ) : (
        <div className="space-y-4">
          {!configured ? (
            <UnconfiguredState />
          ) : revoked ? (
            <RevokedState />
          ) : needsParent ? (
            <ParentPicker
              candidates={status?.candidates ?? []}
              radioName={radioName}
              selected={selected}
              onSelect={setSelected}
              building={action.kind === "building"}
              onConfirm={(pageId) => void chooseParent(pageId)}
              onRecheck={onReload}
            />
          ) : connected ? (
            <ConnectedHeader
              workspaceName={status?.workspaceName ?? null}
              hubUrl={status?.hubUrl ?? null}
            />
          ) : (
            <ConnectState />
          )}

          {/* Sync exists whenever there is something to sync against: a real
              connection, or an unconfigured server where it is a dry run. */}
          {connected || !configured ? (
            <>
              {/* Persistent, not a one-off toast: courses uploaded after a
                  sync would otherwise sit outside Notion with nothing saying
                  so. It disappears the moment every course has a page. */}
              {connected && missing > 0 && action.kind !== "syncing" ? (
                <Note tone="warn">
                  {pluralize(missing, "course")}{" "}
                  {missing === 1 ? "isn’t" : "aren’t"} in Notion yet —{" "}
                  <button
                    type="button"
                    onClick={() => void sync()}
                    disabled={busy || cooldownLeft > 0}
                    className="rounded-sm font-medium text-accent underline decoration-accent-line underline-offset-2 transition-colors hover:text-ink disabled:no-underline disabled:opacity-55"
                  >
                    Sync now
                  </button>
                </Note>
              ) : null}

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  onClick={() => void sync()}
                  disabled={busy || !hasCourses || cooldownLeft > 0}
                >
                  {action.kind === "syncing" ? (
                    <>
                      <Spinner label="Syncing to Notion" />
                      {action.auto
                        ? `Syncing your ${pluralize(missing, "course")} to Notion…`
                        : "Syncing…"}
                    </>
                  ) : (
                    <>
                      <NotionIcon width={16} height={16} />
                      {configured ? "Sync to Notion" : "Preview the sync"}
                    </>
                  )}
                </Button>
                {!hasCourses ? (
                  <p className="text-[0.8125rem] text-muted">
                    Upload a syllabus first — there is nothing to sync yet.
                  </p>
                ) : cooldownLeft > 0 ? (
                  <p className="text-[0.8125rem] text-muted" role="status">
                    Rate limited — {pluralize(cooldownLeft, "second")} to go.
                  </p>
                ) : null}
              </div>

              {connected ? (
                <p className="text-[0.75rem] leading-relaxed text-muted">
                  Tip: add a Calendar view to Assignments or Study Sessions for
                  the semester at a glance — Notion&rsquo;s API cannot create
                  views, so that one click is yours.
                </p>
              ) : null}
            </>
          ) : null}

          {action.kind === "error" ? (
            <ErrorState
              error={action.error}
              detail={action.detail}
              onRetry={() => setAction({ kind: "idle" })}
            />
          ) : null}

          {/* Tied to the states that offer a sync: a summary hanging under
              "Connect Notion" after the connection went away would be a report
              about a workspace this panel no longer speaks to. */}
          {action.kind === "synced" && (connected || !configured) ? (
            <SyncSummary result={action.result} />
          ) : null}

          {connected ? (
            <DisconnectControl
              confirming={confirmingDisconnect}
              pending={action.kind === "disconnecting"}
              onAsk={() => setConfirmingDisconnect(true)}
              onCancel={() => setConfirmingDisconnect(false)}
              onConfirm={() => void disconnect()}
            />
          ) : null}
        </div>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* States                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Not an error: a server without Notion credentials is a perfectly valid way to
 * run this app, so it reads like the demo banner rather than a failure.
 */
function UnconfiguredState() {
  return (
    <Note>
      Notion isn&rsquo;t set up on this server, so sync is a dry run — it reports
      exactly what <em>would</em> be created without touching a workspace. To go
      live, set{" "}
      <code className="rounded-sm bg-surface px-1 py-0.5 font-mono text-[0.75rem] text-ink">
        NOTION_CLIENT_ID
      </code>{" "}
      and{" "}
      <code className="rounded-sm bg-surface px-1 py-0.5 font-mono text-[0.75rem] text-ink">
        NOTION_CLIENT_SECRET
      </code>{" "}
      and restart the server.
    </Note>
  );
}

function ConnectState() {
  return (
    <div className="space-y-3">
      <p className="text-[0.875rem] leading-relaxed text-ink-soft">
        Connect Notion and you&rsquo;ll pick one page in your workspace for the
        Syllabus AI hub to live under — a page per course, every deadline and
        every study session, built underneath it.
      </p>
      {/* A redirect, not a fetch: this has to be a real navigation. */}
      <LinkButton href="/api/notion/auth">
        <NotionIcon width={16} height={16} />
        Connect Notion
      </LinkButton>
    </div>
  );
}

function RevokedState() {
  return (
    <div className="space-y-3">
      <Note tone="warn">
        Notion access was removed — the integration was revoked in your
        workspace, so nothing can be synced until you reconnect. Your pages are
        untouched.
      </Note>
      <LinkButton href="/api/notion/auth">
        <NotionIcon width={16} height={16} />
        Reconnect Notion
      </LinkButton>
    </div>
  );
}

function ConnectedHeader({
  workspaceName,
  hubUrl,
}: {
  workspaceName: string | null;
  hubUrl: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-sunken/60 px-3.5 py-3">
      <p className="flex min-w-0 items-center gap-2 text-[0.875rem] text-ink">
        <span className="shrink-0 text-ok">
          <CheckIcon width={15} height={15} />
        </span>
        <span className="min-w-0 truncate">
          Connected to{" "}
          <span className="font-medium">
            {workspaceName || "your Notion workspace"}
          </span>
        </span>
      </p>
      {hubUrl ? (
        <ExternalLink href={hubUrl}>Open in Notion</ExternalLink>
      ) : null}
    </div>
  );
}

function ParentPicker({
  candidates,
  radioName,
  selected,
  onSelect,
  building,
  onConfirm,
  onRecheck,
}: {
  candidates: NotionCandidate[];
  radioName: string;
  selected: string | null;
  onSelect: (pageId: string) => void;
  building: boolean;
  onConfirm: (pageId: string) => void;
  onRecheck: () => void;
}) {
  if (candidates.length === 0) {
    return (
      <div className="space-y-3">
        <Note>
          Notion is connected, but no page was shared with the integration —
          every page we create needs a parent. In Notion, open the page the hub
          should live under, hit <strong>Share</strong>, and invite the{" "}
          <strong>Syllabus AI</strong> integration. Then check again.
        </Note>
        <Button variant="secondary" onClick={onRecheck}>
          Check again
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <fieldset disabled={building} className="min-w-0">
        <legend className="mb-2 text-[0.875rem] leading-relaxed text-ink-soft">
          Pick the page the Syllabus AI hub should live under.
        </legend>
        <ul className="space-y-2">
          {candidates.map((candidate) => (
            <li
              key={candidate.id}
              className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
                selected === candidate.id
                  ? "border-accent bg-accent-soft"
                  : "border-line bg-surface hover:bg-raised"
              }`}
            >
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
                <input
                  type="radio"
                  name={radioName}
                  value={candidate.id}
                  checked={selected === candidate.id}
                  onChange={() => onSelect(candidate.id)}
                  className="h-4 w-4 shrink-0 accent-[color:var(--color-accent)]"
                />
                <span className="min-w-0 truncate text-[0.875rem] text-ink">
                  {candidate.title || "Untitled page"}
                </span>
              </label>
              {candidate.url ? (
                <a
                  href={candidate.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label={`Open “${candidate.title || "Untitled page"}” in Notion`}
                  className="shrink-0 rounded-sm text-[0.75rem] text-muted transition-colors hover:text-ink"
                >
                  open ↗
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={() => selected && onConfirm(selected)}
          disabled={building || !selected}
        >
          {building ? (
            <>
              <Spinner label="Building your hub" />
              Building your hub…
            </>
          ) : (
            "Use this page"
          )}
        </Button>
        {building ? (
          <p className="text-[0.8125rem] text-muted">
            Creating the hub and its three databases — this takes a few seconds.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function DisconnectControl({
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
      <div className="border-t border-line pt-3">
        <Button variant="ghost" size="sm" onClick={onAsk}>
          Disconnect Notion
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2.5 border-t border-line pt-3">
      <p className="text-[0.8125rem] leading-relaxed text-ink-soft">
        Disconnect Notion? Everything already in Notion stays exactly where it
        is — this only drops the connection here, and nothing in your workspace
        is deleted.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={onConfirm} disabled={pending}>
          {pending ? (
            <>
              <Spinner label="Disconnecting" />
              Disconnecting…
            </>
          ) : (
            "Yes, disconnect"
          )}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          Keep it connected
        </Button>
      </div>
    </div>
  );
}

function SyncSummary({ result }: { result: SyncResponse }) {
  return (
    <div className="rise rounded-lg border border-line bg-sunken/60 p-4">
      <p className="flex items-center gap-1.5 text-[0.8125rem] font-semibold text-ok">
        <CheckIcon width={15} height={15} />
        {result.dryRun ? "Dry run complete" : "Sync complete"}
      </p>
      <dl className="mt-3 grid grid-cols-1 gap-2 text-center sm:grid-cols-3">
        <Stat
          label="Created"
          value={total(result.created)}
          breakdown={breakdown(result.created)}
        />
        <Stat
          label="Updated"
          value={total(result.updated)}
          breakdown={breakdown(result.updated)}
        />
        <Stat label="Skipped" value={result.skipped} breakdown="already current" />
      </dl>
      {result.hubUrl ? (
        <p className="mt-3 text-[0.75rem] text-muted">
          <ExternalLink href={result.hubUrl}>Open the hub in Notion</ExternalLink>
        </p>
      ) : null}
      {result.errors.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {result.errors.map((message, index) => (
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
  );
}

function Stat({
  label,
  value,
  breakdown,
}: {
  label: string;
  value: number;
  breakdown: string;
}) {
  return (
    <div className="rounded-md border border-line bg-surface px-2 py-3">
      <dt className="text-[0.6875rem] font-semibold tracking-[0.1em] text-muted uppercase">
        {label}
      </dt>
      <dd className="mt-1 font-mono text-[1.375rem] leading-none text-ink tabular-nums">
        {value}
      </dd>
      <dd className="mt-1.5 text-[0.6875rem] leading-snug text-muted">
        {breakdown}
      </dd>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

type Counts = NotionSyncResult["created"];

function total(counts: Counts): number {
  return counts.courses + counts.assignments + counts.sessions;
}

function breakdown(counts: Counts): string {
  return [
    `${counts.courses} ${counts.courses === 1 ? "course" : "courses"}`,
    `${counts.assignments} ${counts.assignments === 1 ? "assignment" : "assignments"}`,
    `${counts.sessions} ${counts.sessions === 1 ? "session" : "sessions"}`,
  ].join(" · ");
}

/**
 * Reads the wait out of a rate-limit message ("Try again in 40 seconds.",
 * "The limit resets in 3 minutes."). Returns null for anything else, so an
 * ordinary failure never locks the button.
 */
function parseWait(message: string): number | null {
  const match = /in (?:about )?(\d+) (second|minute|hour)s?/i.exec(message);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2].toLowerCase();
  const seconds = unit === "hour" ? 3600 : unit === "minute" ? 60 : 1;
  return amount * seconds;
}

/** External links always open in a new tab; the dashboard stays put. */
function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1 rounded-md border border-line-strong bg-surface px-2.5 py-1 text-[0.8125rem] font-medium text-ink transition-colors hover:bg-raised"
    >
      {children}
      <span aria-hidden="true">↗</span>
    </a>
  );
}

/** Notion's mark is trademarked, so this is a neutral "notebook page" glyph. */
function NotionIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 3v18" />
      <path d="M11.5 8v8" />
      <path d="M11.5 8l5 8" />
      <path d="M16.5 8v8" />
    </svg>
  );
}
