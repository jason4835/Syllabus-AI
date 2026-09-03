"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  SVGProps,
} from "react";
import type {
  Assessment,
  Course,
  SemesterPlan,
  User,
} from "@/lib/types";
import { apiGet, apiPost } from "@/components/api-client";
import type { AppConfig } from "@/components/api-client";
import { accentVar, buildAccentMap } from "@/components/course-accents";
import { Logo, RefreshIcon } from "@/components/icons";
import { Button, Spinner } from "@/components/ui/button";
import { DemoBanner } from "@/components/dashboard/demo-banner";
import { AccountPanel } from "@/components/dashboard/account-panel";
import { UploadPanel } from "@/components/dashboard/upload-panel";
import type { UploadResult } from "@/components/dashboard/upload-panel";
import { UpcomingPanel } from "@/components/dashboard/upcoming-panel";
import { HeatmapPanel } from "@/components/dashboard/heatmap-panel";
import { RoadmapPanel } from "@/components/dashboard/roadmap-panel";
import { SyncPanel } from "@/components/dashboard/sync-panel";
import { NotionPanel } from "@/components/dashboard/notion-panel";
import type { NotionStatus } from "@/components/dashboard/notion-panel";
import { ChatPanel } from "@/components/dashboard/chat-panel";

interface Failure {
  error: string;
  detail?: string;
}

interface CoursesPayload {
  courses: Course[];
  assessments: Assessment[];
}

export function DashboardShell() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [user, setUser] = useState<User | null>(null);

  const [courses, setCourses] = useState<Course[]>([]);
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [plan, setPlan] = useState<SemesterPlan | null>(null);

  const [coursesLoading, setCoursesLoading] = useState(true);
  const [planLoading, setPlanLoading] = useState(true);
  const [configLoading, setConfigLoading] = useState(true);

  const [coursesError, setCoursesError] = useState<Failure | undefined>();
  const [planError, setPlanError] = useState<Failure | undefined>();

  // Notion status is fetched here, not in the panel, because the roadmap needs
  // its `coursePages` map too and one mount must mean one request.
  const [notionStatus, setNotionStatus] = useState<NotionStatus | null>(null);
  const [notionLoading, setNotionLoading] = useState(true);
  const [notionError, setNotionError] = useState<Failure | undefined>();
  const notionRef = useRef<HTMLDivElement>(null);
  const notionInFlight = useRef<Promise<void> | null>(null);
  const [pendingNotionScroll, setPendingNotionScroll] = useState(false);
  const [notionJustConnected, setNotionJustConnected] = useState(false);

  const accountRef = useRef<HTMLDivElement>(null);

  /**
   * Which course the roadmap has open in its editor, and where the cursor
   * lands. It lives here because the heatmap opens it too: "Set term dates" is
   * a link in one panel that has to open a form in another.
   */
  const [editingCourseId, setEditingCourseId] = useState<string | null>(null);
  const [editFocusField, setEditFocusField] = useState<"code" | "startDate">(
    "code",
  );

  /**
   * "Account" in the header menu is a jump, not a route -- the panel is already
   * on this page. Focus moves with the scroll so a keyboard user carries on from
   * the panel rather than from the top of the document.
   */
  const showAccount = useCallback(() => {
    const target = accountRef.current;
    if (!target) return;
    // Focus first, then scroll: focusing mid-flight cancels a smooth scroll in
    // Chrome, and the panel is far enough down the page for that to be the
    // difference between arriving and not moving at all.
    target.focus({ preventScroll: true });
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const loadCourses = useCallback(async () => {
    setCoursesLoading(true);
    const result = await apiGet<CoursesPayload>("/api/courses");
    if (result.ok) {
      setCourses(result.data.courses ?? []);
      setAssessments(result.data.assessments ?? []);
      setCoursesError(undefined);
    } else {
      setCoursesError({ error: result.error, detail: result.detail });
    }
    setCoursesLoading(false);
  }, []);

  const loadPlan = useCallback(async () => {
    setPlanLoading(true);
    const result = await apiGet<SemesterPlan>("/api/plan");
    if (result.ok) {
      setPlan(result.data);
      setPlanError(undefined);
    } else {
      setPlanError({ error: result.error, detail: result.detail });
    }
    setPlanLoading(false);
  }, []);

  /**
   * Callers overlap on the OAuth return (the mount load and the
   * `?notion=connected` refetch fire in the same tick), so an in-flight request
   * is shared rather than duplicated. Returning to a settled state re-fetches
   * normally.
   */
  const loadNotion = useCallback((): Promise<void> => {
    if (notionInFlight.current) return notionInFlight.current;
    setNotionLoading(true);
    const request = (async () => {
      const result = await apiGet<NotionStatus>("/api/notion/status");
      if (result.ok) {
        setNotionStatus(result.data);
        setNotionError(undefined);
      } else {
        setNotionError({ error: result.error, detail: result.detail });
      }
      setNotionLoading(false);
    })().finally(() => {
      notionInFlight.current = null;
    });
    notionInFlight.current = request;
    return request;
  }, []);

  const loadIdentity = useCallback(async () => {
    setConfigLoading(true);
    const [configResult, meResult] = await Promise.all([
      apiGet<AppConfig>("/api/config"),
      apiGet<User | null>("/api/me"),
    ]);
    if (configResult.ok) setConfig(configResult.data);
    if (meResult.ok) setUser(meResult.data);
    setConfigLoading(false);
  }, []);

  useEffect(() => {
    void loadIdentity();
    void loadCourses();
    void loadPlan();
    void loadNotion();
  }, [loadIdentity, loadCourses, loadPlan, loadNotion]);

  // StrictMode runs effects twice; the OAuth return must be handled once.
  const notionReturnHandled = useRef(false);

  /**
   * `/api/notion/callback` sends the user back to `?notion=connected`. Pick the
   * newly built connection up, put the panel in front of them, then strip the
   * param so a refresh is not read as a second return from OAuth.
   */
  useEffect(() => {
    if (notionReturnHandled.current) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("notion") !== "connected") return;
    notionReturnHandled.current = true;

    void loadNotion();
    setPendingNotionScroll(true);
    // The panel backfills courses that are not in Notion yet, but only on this
    // arrival -- a plain reload of the dashboard must not start a sync.
    setNotionJustConnected(true);

    params.delete("notion");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
    );
  }, [loadNotion]);

  /**
   * The Notion panel sits below the heatmap and roadmap, whose heights only
   * settle once courses and the plan arrive. Scrolling before then aims at a
   * moving target -- a smooth scroll is computed once, so the page grows out
   * from under it and lands nowhere near the panel.
   */
  useEffect(() => {
    if (!pendingNotionScroll) return;
    if (coursesLoading || planLoading || notionLoading) return;
    setPendingNotionScroll(false);
    notionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [pendingNotionScroll, coursesLoading, planLoading, notionLoading]);

  // Ref, not state: the guard must survive React's StrictMode double-effect,
  // and re-rendering on it would be pointless -- nothing visible depends on it.
  const timezoneReported = useRef(false);

  /**
   * The server cannot know which zone a student's "23:59" means, so the browser
   * tells it. Strictly a background correction: it never blocks a render and a
   * failure (including a 404 before the route ships) is silent, because a user
   * can do nothing useful with the news that their zone did not save.
   */
  useEffect(() => {
    if (!user || timezoneReported.current) return;

    let browserZone: string;
    try {
      browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return;
    }
    if (!browserZone || browserZone === user.timezone) return;

    timezoneReported.current = true;
    void apiPost<User>("/api/me/timezone", { timezone: browserZone }).then(
      (result) => {
        if (result.ok) setUser(result.data);
      },
    );
  }, [user]);

  const refreshAll = useCallback(() => {
    void loadCourses();
    void loadPlan();
    // An upload can create Notion pages, so the "Open in Notion" links on the
    // roadmap come from the same refresh as the courses they hang off.
    void loadNotion();
  }, [loadCourses, loadPlan, loadNotion]);

  const accents = useMemo(() => buildAccentMap(courses), [courses]);
  const nextAccent = accentVar(courses.length);

  const onUploaded = useCallback(
    (result: UploadResult) => {
      // Optimistically fold the new course in, then reconcile with the server.
      setCourses((current) =>
        current.some((course) => course.id === result.course.id)
          ? current
          : [...current, result.course],
      );
      setAssessments((current) => {
        const known = new Set(current.map((item) => item.id));
        return [...current, ...result.assessments.filter((item) => !known.has(item.id))];
      });
      refreshAll();
    },
    [refreshAll],
  );

  /**
   * A confirmed or edited item comes back from the server already final, so
   * it replaces its row in place -- no refetch of every course. The plan is
   * refetched because a moved date moves study blocks and week loads.
   */
  const onAssessmentChanged = useCallback(
    (updated: Assessment) => {
      setAssessments((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      void loadPlan();
    },
    [loadPlan],
  );

  /**
   * A saved course comes back final. The plan is refetched because the term
   * window is what the heatmap numbers its weeks from -- new dates, new week 1.
   */
  const onCourseChanged = useCallback(
    (updated: Course) => {
      setCourses((current) =>
        current.map((course) => (course.id === updated.id ? updated : course)),
      );
      void loadPlan();
    },
    [loadPlan],
  );

  const onAssessmentAdded = useCallback(
    (added: Assessment) => {
      setAssessments((current) =>
        current.some((item) => item.id === added.id)
          ? current
          : [...current, added],
      );
      void loadPlan();
    },
    [loadPlan],
  );

  const onAssessmentDeleted = useCallback(
    (id: string) => {
      setAssessments((current) => current.filter((item) => item.id !== id));
      void loadPlan();
    },
    [loadPlan],
  );

  /**
   * A replace is a swap, not an addition: the old course and everything that
   * hung off it are gone on the server, so they go from the page in the same
   * update rather than lingering until the refetch lands.
   */
  const onCourseReplaced = useCallback(
    (oldCourseId: string, result: UploadResult) => {
      setCourses((current) => [
        ...current.filter((course) => course.id !== oldCourseId),
        ...(current.some((course) => course.id === result.course.id)
          ? []
          : [result.course]),
      ]);
      setAssessments((current) => {
        const kept = current.filter((item) => item.courseId !== oldCourseId);
        const known = new Set(kept.map((item) => item.id));
        return [...kept, ...result.assessments.filter((item) => !known.has(item.id))];
      });
      if (editingCourseId === oldCourseId) setEditingCourseId(null);
      refreshAll();
    },
    [refreshAll, editingCourseId],
  );

  /**
   * The heatmap does not know which course to blame for a guessed term window,
   * and with one course there is no question: send them to the first one.
   */
  const onSetTermDates = useCallback(() => {
    const target = courses[0];
    if (!target) return;
    setEditFocusField("startDate");
    setEditingCourseId(target.id);
  }, [courses]);

  const onEditCourse = useCallback((courseId: string | null) => {
    setEditFocusField("code");
    setEditingCourseId(courseId);
  }, []);

  const demoMode = config?.demoMode ?? false;
  const weeks = plan?.weeks ?? [];

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 border-b border-line bg-paper/85 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <a
            href="/"
            className="flex items-center gap-2.5 rounded-md font-serif text-[1.0625rem] font-semibold tracking-tight text-ink"
          >
            <Logo />
            <span className="hidden sm:inline">Syllabus AI</span>
          </a>
          <div className="flex items-center gap-2 sm:gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={refreshAll}
              aria-label="Refresh courses and plan"
            >
              <RefreshIcon width={15} height={15} />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
            {configLoading ? (
              <span className="skeleton h-7 w-24 rounded-full" aria-hidden="true" />
            ) : user || demoMode ? (
              <UserMenu
                name={demoMode ? "Demo Student" : (user?.name ?? user?.email ?? "You")}
                email={user?.email ?? null}
                demoMode={demoMode}
                onAccount={showAccount}
              />
            ) : (
              <a
                href="/api/auth/google"
                className="rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-[0.8125rem] font-medium text-ink transition-colors hover:bg-raised"
              >
                Sign in
              </a>
            )}
          </div>
        </div>
      </header>

      <main
        id="main"
        className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-8"
      >
        <div className="mb-6">
          <h1 className="text-display text-ink">Your semester</h1>
          <p className="mt-1.5 max-w-2xl text-[0.9375rem] leading-relaxed text-muted">
            {courses.length > 0
              ? `${courses.length} ${courses.length === 1 ? "course" : "courses"}, ${assessments.length} graded ${assessments.length === 1 ? "item" : "items"}, mapped across ${weeks.length || "—"} weeks.`
              : "Upload a syllabus to build your roadmap, heatmap and calendar."}
          </p>
        </div>

        {config && demoMode ? (
          <div className="mb-6">
            <DemoBanner config={config} />
          </div>
        ) : null}

        <div className="space-y-6">
          <HeatmapPanel
            loading={planLoading}
            error={planError}
            weeks={weeks}
            term={plan?.term ?? null}
            courses={courses}
            assessments={assessments}
            accents={accents}
            onRetry={() => void loadPlan()}
            onSetTermDates={courses.length > 0 ? onSetTermDates : undefined}
          />

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] lg:items-start">
            <div className="space-y-6">
              <UpcomingPanel
                loading={coursesLoading}
                error={coursesError}
                courses={courses}
                assessments={assessments}
                accents={accents}
                onAssessmentChanged={onAssessmentChanged}
                onAssessmentDeleted={onAssessmentDeleted}
                onRetry={() => void loadCourses()}
              />
              <RoadmapPanel
                loading={coursesLoading}
                error={coursesError}
                courses={courses}
                assessments={assessments}
                accents={accents}
                onAssessmentChanged={onAssessmentChanged}
                onAssessmentAdded={onAssessmentAdded}
                onAssessmentDeleted={onAssessmentDeleted}
                onCourseChanged={onCourseChanged}
                editingCourseId={editingCourseId}
                editFocusField={editFocusField}
                onEditCourse={onEditCourse}
                coursePages={notionStatus?.coursePages ?? {}}
                onRetry={() => void loadCourses()}
              />
            </div>

            <div className="space-y-6">
              <UploadPanel
                demoMode={demoMode}
                accent={nextAccent}
                onUploaded={onUploaded}
                onAssessmentChanged={onAssessmentChanged}
                onCourseReplaced={onCourseReplaced}
              />
              <SyncPanel
                demoMode={demoMode}
                googleReady={config?.googleReady ?? false}
                hasCourses={courses.length > 0}
              />
              <div ref={notionRef}>
                <NotionPanel
                  status={notionStatus}
                  loading={notionLoading}
                  error={notionError}
                  hasCourses={courses.length > 0}
                  courses={courses}
                  justConnected={notionJustConnected}
                  onStatus={setNotionStatus}
                  onReload={() => void loadNotion()}
                />
              </div>
              <ChatPanel openaiReady={config?.openaiReady ?? false} />
            </div>
          </div>

          {/* Last on the page on purpose: it is the thing you go looking for,
              not the thing you work in. `scroll-mt` clears the sticky header
              when the menu jumps here. */}
          <div ref={accountRef} tabIndex={-1} className="scroll-mt-20 outline-none">
            <AccountPanel
              user={user}
              loading={configLoading}
              demoMode={demoMode}
              notionConnected={
                (notionStatus?.connected ?? false) &&
                notionStatus?.status !== "revoked"
              }
              notionWorkspace={notionStatus?.workspaceName ?? null}
              onUser={setUser}
            />
          </div>
        </div>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto w-full max-w-7xl px-4 py-6 text-[0.75rem] text-muted sm:px-6">
          {plan?.generatedAt ? (
            <>Plan generated {new Date(plan.generatedAt).toLocaleString()}. </>
          ) : null}
          Syllabus AI keeps your roadmap in step with the semester.
        </div>
      </footer>
    </div>
  );
}


/* -------------------------------------------------------------------------- */
/* Header user menu                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The chip used to be decoration. A first user asked, reasonably, how to log
 * out and how to see what we hold on them -- so it became the one place both
 * live. A real menu, not a popover of links: `aria-haspopup`, roving focus,
 * Escape and click-outside, because it sits in the header of every screen.
 */
function UserMenu({
  name,
  email,
  demoMode,
  onAccount,
}: {
  name: string;
  email: string | null;
  demoMode: boolean;
  onAccount: () => void;
}) {
  const menuId = useId();
  const labelId = useId();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  /**
   * Escape and Tab-away hand focus back to the trigger; a click elsewhere does
   * not, because the pointer has already chosen where focus should be.
   */
  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    }
    function onFocusIn(event: FocusEvent) {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [open]);

  // Opening a menu puts you in it -- otherwise a keyboard user opens a panel
  // they then have to Tab into blind.
  useEffect(() => {
    if (!open) return;
    menuRef.current
      ?.querySelector<HTMLElement>('[role="menuitem"]')
      ?.focus();
  }, [open]);

  function moveFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (current + 1) % items.length
            : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  async function logOut() {
    setPending(true);
    await apiPost("/api/auth/logout");
    // Navigate whatever came back: if the cookie was cleared we must leave, and
    // if it was not, the landing page re-reads the session as the one source of
    // truth rather than this component guessing.
    window.location.assign("/");
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="flex items-center gap-2 rounded-full border border-line bg-surface py-1 pr-2 pl-1 transition-colors hover:bg-raised"
      >
        <span
          aria-hidden="true"
          className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-[0.6875rem] font-semibold text-accent-on"
        >
          {name.slice(0, 1).toUpperCase()}
        </span>
        <span className="max-w-24 truncate text-[0.8125rem] text-ink-soft sm:max-w-32">
          {name}
        </span>
        <ChevronIcon
          className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`}
          width={13}
          height={13}
        />
      </button>

      {open ? (
        <div
          id={menuId}
          className="rise absolute right-0 z-50 mt-2 w-60 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-line bg-surface shadow-lift"
        >
          {/* Identity, not a control: it answers "who am I signed in as?" which
              is half of why the menu gets opened at all. */}
          <div className="border-b border-line px-3 py-2.5">
            <p id={labelId} className="truncate text-[0.8125rem] font-medium text-ink">
              {name}
            </p>
            {email ? (
              <p className="truncate text-[0.75rem] text-muted">{email}</p>
            ) : null}
          </div>

          <div
            ref={menuRef}
            role="menu"
            aria-labelledby={labelId}
            onKeyDown={moveFocus}
            className="py-1"
          >
            <MenuItem
              onClick={() => {
                setOpen(false);
                onAccount();
              }}
            >
              Account
            </MenuItem>
            {demoMode ? (
              <MenuItem onClick={() => window.location.assign("/")}>
                Exit demo
              </MenuItem>
            ) : (
              <MenuItem disabled={pending} onClick={() => void logOut()}>
                {pending ? (
                  <>
                    <Spinner label="Logging out" />
                    Logging out…
                  </>
                ) : (
                  "Log out"
                )}
              </MenuItem>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MenuItem({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-2 text-left text-[0.8125rem] text-ink-soft transition-colors hover:bg-raised hover:text-ink disabled:cursor-not-allowed disabled:opacity-55"
    >
      {children}
    </button>
  );
}

/** Local: one glyph, used once, not worth growing the shared icon set. */
function ChevronIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
