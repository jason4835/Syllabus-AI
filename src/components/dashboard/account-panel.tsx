"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode, SVGProps } from "react";
import type {
  ApiResult,
  Assessment,
  Course,
  SemesterPlan,
  User,
} from "@/lib/types";
import { apiGet, apiPost } from "@/components/api-client";
import { Panel } from "@/components/ui/panel";
import { Button, LinkButton, Spinner } from "@/components/ui/button";
import { EmptyState, ErrorState, Note } from "@/components/ui/states";
import { LoadingRegion, SkeletonRows } from "@/components/ui/skeleton";
import { CheckIcon, GoogleMark } from "@/components/icons";
import { parseDate } from "@/components/format";

/**
 * "What do you know about me, and how do I leave?" — the three questions a
 * first user asked, in the order they asked them: what is stored, give me a
 * copy, now erase it. Read-only on purpose: the dashboard is not a settings
 * screen, and timezone is the only field the app can honestly correct (the
 * browser knows it; the server can only guess).
 */

interface CoursesPayload {
  courses: Course[];
  assessments: Assessment[];
}

/** Timezone is the one editable field, so it gets the only write state here. */
type ZoneState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; zone: string }
  | { kind: "unchanged" }
  | { kind: "error"; message: string };

type ExportState =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "done"; filename: string; omitted: string[] }
  | { kind: "error"; error: string; detail?: string };

/** One action at a time, exactly like the Notion panel's disconnect. */
type DeleteState =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "deleting" }
  | { kind: "error"; error: string; detail?: string };

export function AccountPanel({
  user,
  loading,
  demoMode,
  notionConnected,
  notionWorkspace,
  onUser,
}: {
  user: User | null;
  loading: boolean;
  demoMode: boolean;
  notionConnected: boolean;
  notionWorkspace: string | null;
  /** `POST /api/me/timezone` answers with a fresh user — adopt it upstream. */
  onUser: (user: User) => void;
}) {
  const confirmId = useId();
  const warningId = useId();
  const triggerId = useId();

  const [zone, setZone] = useState<ZoneState>({ kind: "idle" });
  const [exported, setExported] = useState<ExportState>({ kind: "idle" });
  const [deletion, setDeletion] = useState<DeleteState>({ kind: "idle" });
  const [removeCalendar, setRemoveCalendar] = useState(false);
  const [typed, setTyped] = useState("");

  // Focus has to land in the confirm region when it opens and come back to the
  // trigger when it closes, or a keyboard user is dropped at the top of the page.
  // The trigger is found by id rather than ref because the shared `Button` takes
  // no ref, and widening it for one focus call is not worth the blast radius.
  const typedRef = useRef<HTMLInputElement>(null);

  const deleting = deletion.kind === "deleting";
  const armed = typed.trim() === "DELETE";

  /**
   * Focus follows the confirm region: into the typed-confirmation field when it
   * opens, back to the trigger when it closes. An effect rather than a callback
   * because the element being focused only exists after the commit.
   */
  const confirmOpen = deletion.kind !== "idle";
  const wasOpen = useRef(false);
  useEffect(() => {
    if (confirmOpen && !wasOpen.current) typedRef.current?.focus();
    else if (!confirmOpen && wasOpen.current)
      document.getElementById(triggerId)?.focus();
    wasOpen.current = confirmOpen;
  }, [confirmOpen, triggerId]);

  /**
   * Re-reports the browser's zone. Deadlines are stored as floating local
   * times, so a stale zone quietly moves every calendar event — which is why
   * this affordance exists at all rather than a read-only row.
   */
  async function correctZone() {
    let browserZone: string;
    try {
      browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      setZone({ kind: "error", message: "This browser will not report a zone." });
      return;
    }
    if (!browserZone) {
      setZone({ kind: "error", message: "This browser will not report a zone." });
      return;
    }
    if (browserZone === user?.timezone) {
      setZone({ kind: "unchanged" });
      return;
    }
    setZone({ kind: "saving" });
    const result = await apiPost<User>("/api/me/timezone", {
      timezone: browserZone,
    });
    if (!result.ok) {
      setZone({ kind: "error", message: result.error });
      return;
    }
    onUser(result.data);
    setZone({ kind: "saved", zone: result.data.timezone ?? browserZone });
  }

  /**
   * Everything the app holds, in one file, built in the browser — no export
   * endpoint to add and nothing new for the server to leak. A route that has
   * not shipped (or is mid-deploy) is recorded as omitted rather than failing
   * the whole download; a partial copy still beats none.
   */
  async function download() {
    setExported({ kind: "working" });
    const [coursesResult, planResult, meResult] = await Promise.all([
      apiGet<CoursesPayload>("/api/courses"),
      apiGet<SemesterPlan>("/api/plan"),
      apiGet<User | null>("/api/me"),
    ]);

    const omitted: string[] = [];
    if (!coursesResult.ok) omitted.push("courses");
    if (!planResult.ok) omitted.push("plan");
    if (!meResult.ok) omitted.push("profile");

    if (omitted.length === 3) {
      setExported({
        kind: "error",
        error: "Could not gather your data",
        detail: coursesResult.ok ? undefined : coursesResult.error,
      });
      return;
    }

    const me = meResult.ok ? meResult.data : null;
    const payload = {
      app: "Syllabus AI",
      exportedAt: new Date().toISOString(),
      profile: me ? redactUser(me) : null,
      courses: coursesResult.ok ? coursesResult.data.courses : null,
      assessments: coursesResult.ok ? coursesResult.data.assessments : null,
      plan: planResult.ok ? planResult.data : null,
      omitted,
    };

    const filename = `syllabus-ai-export-${localDateStamp()}.json`;
    saveJson(payload, filename);
    setExported({ kind: "done", filename, omitted });
  }

  function askToDelete() {
    setTyped("");
    setRemoveCalendar(false);
    setDeletion({ kind: "confirming" });
  }

  function cancelDelete() {
    setDeletion({ kind: "idle" });
    setTyped("");
  }

  async function confirmDelete() {
    setDeletion({ kind: "deleting" });
    const result = await deleteAccount(removeCalendar);
    if (!result.ok) {
      // A 403 (the demo account) arrives in the same envelope as everything
      // else, so the server's own wording is what gets shown — it knows why.
      setDeletion({
        kind: "error",
        error: result.error,
        detail: result.detail,
      });
      return;
    }
    // Stay in the pending state through the navigation: the account is gone,
    // so re-rendering this panel against it would be a lie for one frame.
    window.location.assign("/?deleted=1");
  }

  return (
    <Panel
      id="account"
      title="Account"
      icon={<PersonIcon width={17} height={17} />}
      description="What Syllabus AI knows about you, how to take a copy, and how to erase it."
    >
      {loading && !user ? (
        <LoadingRegion label="Loading your account">
          <SkeletonRows rows={3} />
        </LoadingRegion>
      ) : !user ? (
        <EmptyState
          icon={<PersonIcon width={22} height={22} />}
          title="You are not signed in"
          body="Sign in with Google and your account details, your data and the delete controls all live here."
          action={
            <LinkButton href="/api/auth/google" size="sm">
              <GoogleMark />
              Sign in with Google
            </LinkButton>
          }
        />
      ) : (
        <div className="space-y-6">
          <Section title="Your info">
            <dl className="divide-y divide-line rounded-lg border border-line bg-sunken/60">
              <Row label="Name">{user.name || "—"}</Row>
              <Row label="Email">{user.email || "—"}</Row>
              <Row label="Timezone">
                <span className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
                  <span className="font-mono text-[0.8125rem]">
                    {user.timezone || "Not set yet"}
                  </span>
                  <button
                    type="button"
                    onClick={() => void correctZone()}
                    disabled={zone.kind === "saving"}
                    className="rounded-sm text-[0.75rem] text-muted underline decoration-line-strong underline-offset-2 transition-colors hover:text-ink disabled:no-underline"
                  >
                    {zone.kind === "saving" ? "checking…" : "not right?"}
                  </button>
                </span>
              </Row>
              <Row label="Member since">{formatMemberSince(user.createdAt)}</Row>
              <Row label="Google Calendar">
                {/* A boolean, deliberately: the token itself is never rendered,
                    logged or exported, only the fact that one exists. */}
                <Connection
                  connected={user.googleRefreshToken !== null}
                  connectedLabel="Connected"
                />
              </Row>
              <Row label="Notion">
                <Connection
                  connected={notionConnected}
                  connectedLabel={notionWorkspace || "Connected"}
                />
              </Row>
            </dl>
            {zone.kind !== "idle" && zone.kind !== "saving" ? (
              <p role="status" className="mt-2 text-[0.75rem] text-muted">
                {zone.kind === "saved"
                  ? `Timezone updated to ${zone.zone}. Calendar times will follow it from now on.`
                  : zone.kind === "unchanged"
                    ? "That is already your browser's zone — nothing to change."
                    : zone.message}
              </p>
            ) : null}
          </Section>

          <Section title="Your data">
            <p className="text-[0.875rem] leading-relaxed text-ink-soft">
              Syllabus AI stores your courses, the deadlines it extracted from
              each syllabus, the study plan built from them, and the links to
              the calendar events and Notion pages it created for you.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void download()}
                disabled={exported.kind === "working"}
              >
                {exported.kind === "working" ? (
                  <>
                    <Spinner label="Gathering your data" />
                    Gathering…
                  </>
                ) : (
                  <>
                    <DownloadIcon width={15} height={15} />
                    Download my data
                  </>
                )}
              </Button>
              <p className="text-[0.75rem] text-muted">
                One JSON file, built in your browser. No access tokens are
                included.
              </p>
            </div>
            {exported.kind === "done" ? (
              <p
                role="status"
                className="mt-2 flex flex-wrap items-center gap-1.5 text-[0.75rem] text-muted"
              >
                <span className="text-ok">
                  <CheckIcon width={13} height={13} />
                </span>
                Saved as{" "}
                <code className="rounded-sm bg-raised px-1 py-0.5 font-mono text-ink-soft">
                  {exported.filename}
                </code>
                {exported.omitted.length > 0
                  ? ` — the server did not answer for ${exported.omitted.join(", ")}, so that part is empty.`
                  : null}
              </p>
            ) : exported.kind === "error" ? (
              <div className="mt-3">
                <ErrorState
                  error={exported.error}
                  detail={exported.detail}
                  onRetry={() => void download()}
                />
              </div>
            ) : null}
          </Section>

          <Section title="Delete account">
            {demoMode ? (
              <Note>
                This is the shared demo account, so it can&rsquo;t be deleted —
                there is nothing personal in it to remove. On a real account,
                this is where you erase everything, permanently.
              </Note>
            ) : deletion.kind === "confirming" ||
              deletion.kind === "deleting" ||
              deletion.kind === "error" ? (
              <div className="rise space-y-3.5 rounded-lg border border-danger-line bg-danger-soft px-3.5 py-3.5">
                <p
                  id={warningId}
                  className="text-[0.875rem] leading-relaxed text-ink"
                >
                  This deletes your account and everything in it: every course,
                  every deadline extracted from your syllabi, your semester
                  plan, and the links to the calendar events and Notion pages
                  Syllabus AI created. <strong>It cannot be undone.</strong>
                </p>
                <p className="text-[0.8125rem] leading-relaxed text-ink-soft">
                  Your Notion pages are never touched — they stay in your
                  workspace exactly as they are.
                </p>

                <label className="flex items-start gap-2.5 text-[0.8125rem] leading-relaxed text-ink">
                  <input
                    type="checkbox"
                    checked={removeCalendar}
                    onChange={(event) => setRemoveCalendar(event.target.checked)}
                    disabled={deleting}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-[color:var(--color-accent)]"
                  />
                  Also remove the Syllabus AI calendar from Google
                </label>

                <div>
                  <label
                    htmlFor={confirmId}
                    className="block text-[0.8125rem] font-medium text-ink"
                  >
                    Type <span className="font-mono">DELETE</span> to confirm
                  </label>
                  <input
                    id={confirmId}
                    ref={typedRef}
                    value={typed}
                    onChange={(event) => setTyped(event.target.value)}
                    disabled={deleting}
                    aria-describedby={warningId}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="DELETE"
                    className="mt-1.5 w-full max-w-56 rounded-lg border border-line-strong bg-surface px-3 py-2 font-mono text-[0.875rem] text-ink placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-60"
                  />
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void confirmDelete()}
                    disabled={!armed || deleting}
                  >
                    {deleting ? (
                      <>
                        <Spinner label="Deleting your account" />
                        Deleting…
                      </>
                    ) : (
                      <span className="text-danger">
                        Delete my account permanently
                      </span>
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={cancelDelete}
                    disabled={deleting}
                  >
                    Keep my account
                  </Button>
                </div>

                {deletion.kind === "error" ? (
                  <ErrorState error={deletion.error} detail={deletion.detail} />
                ) : null}
              </div>
            ) : (
              <div className="space-y-2.5">
                <p className="text-[0.875rem] leading-relaxed text-ink-soft">
                  Erase your account and every course, deadline, plan and
                  connection stored with it. Your Notion pages stay where they
                  are.
                </p>
                <Button
                  id={triggerId}
                  variant="secondary"
                  size="sm"
                  onClick={askToDelete}
                >
                  <span className="text-danger">Delete my account</span>
                </Button>
              </div>
            )}
          </Section>
        </div>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                     */
/* -------------------------------------------------------------------------- */

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-[0.6875rem] font-semibold tracking-[0.12em] text-muted uppercase">
        {title}
      </h3>
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5 px-3.5 py-2.5">
      <dt className="text-[0.8125rem] text-muted">{label}</dt>
      {/* `break-words` rather than truncate: a long email is worth reading in
          full, and at 375px it wraps instead of pushing the row sideways. */}
      <dd className="min-w-0 break-words text-right text-[0.875rem] text-ink">
        {children}
      </dd>
    </div>
  );
}

function Connection({
  connected,
  connectedLabel,
}: {
  connected: boolean;
  connectedLabel: string;
}) {
  if (!connected) {
    return <span className="text-[0.875rem] text-muted">Not connected</span>;
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="shrink-0 text-ok">
        <CheckIcon width={14} height={14} />
      </span>
      {connectedLabel}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The shared client speaks GET and POST; this is the only DELETE the UI ever
 * issues, so it is parsed here rather than widening `api-client`. Forgiving for
 * the same reason that client is: a route that has not shipped yet answers with
 * Next's HTML 404, and that has to read as an ordinary failure, not a crash.
 */
async function deleteAccount(
  removeGoogleCalendar: boolean,
): Promise<ApiResult<{ deleted: boolean; googleCalendarRemoved: boolean }>> {
  let response: Response;
  try {
    response = await fetch("/api/me", {
      method: "DELETE",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ confirm: "DELETE", removeGoogleCalendar }),
    });
  } catch {
    return {
      ok: false,
      error: "Could not reach the server",
      detail: "Nothing was deleted. Check your connection and try again.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text()) as unknown;
  } catch {
    return {
      ok: false,
      error: `Delete failed (${response.status})`,
      detail: "Your account is untouched.",
    };
  }

  const record = parsed as Record<string, unknown> | null;
  if (record && record.ok === false && typeof record.error === "string") {
    return {
      ok: false,
      error: record.error,
      detail: typeof record.detail === "string" ? record.detail : undefined,
    };
  }
  if (record && record.ok === true && response.ok) {
    return {
      ok: true,
      data: record.data as { deleted: boolean; googleCalendarRemoved: boolean },
    };
  }
  return { ok: false, error: "The server sent an unexpected response shape" };
}

/**
 * An allowlist, not a spread-and-delete: a new field on `User` has to be added
 * here deliberately instead of leaking into a file that leaves the machine.
 * `googleRefreshToken` is a bearer secret and never travels — only the fact
 * that one exists.
 */
function redactUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture,
    timezone: user.timezone,
    createdAt: user.createdAt,
    googleCalendarConnected: user.googleRefreshToken !== null,
  };
}

/** `YYYY-MM-DD` in the user's own zone — a file named for their today. */
function localDateStamp(now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function formatMemberSince(value: string | null | undefined): string {
  const date = parseDate(value ?? null);
  if (!date) return "—";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** Blob + object URL: the export never round-trips through the server. */
function saveJson(payload: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking in the same tick cancels the download in Safari; one turn of the
  // event loop is enough for the browser to have taken the blob.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/* -------------------------------------------------------------------------- */
/* Icons — local, like the Notion panel's, rather than growing the shared set  */
/* for two glyphs used in one place.                                           */
/* -------------------------------------------------------------------------- */

function Glyph({ children, ...props }: SVGProps<SVGSVGElement>) {
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
      {children}
    </svg>
  );
}

export function PersonIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="8" r="3.75" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </Glyph>
  );
}

function DownloadIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Glyph {...props}>
      <path d="M12 4v12m0 0 4-4m-4 4-4-4" />
      <path d="M4 18v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1" />
    </Glyph>
  );
}
