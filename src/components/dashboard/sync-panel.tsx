"use client";

import { useState } from "react";
import type { CalendarSyncResult } from "@/lib/types";
import { apiPost } from "@/components/api-client";
import { Panel } from "@/components/ui/panel";
import { Button, Spinner } from "@/components/ui/button";
import { ErrorState, Note } from "@/components/ui/states";
import { AlertIcon, CalendarIcon, CheckIcon } from "@/components/icons";

type State =
  | { kind: "idle" }
  | { kind: "syncing" }
  | { kind: "done"; result: CalendarSyncResult }
  | { kind: "error"; error: string; detail?: string };

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
          : "Push every deadline and study block to your Google Calendar."
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
            <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
              <Stat label="Created" value={state.result.created} />
              <Stat label="Updated" value={state.result.updated} />
              <Stat label="Skipped" value={state.result.skipped} />
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
      </div>
    </Panel>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-line bg-surface px-2 py-3">
      <dt className="text-[0.6875rem] font-semibold tracking-[0.1em] text-muted uppercase">
        {label}
      </dt>
      <dd className="mt-1 font-mono text-[1.375rem] leading-none text-ink tabular-nums">
        {value}
      </dd>
    </div>
  );
}
