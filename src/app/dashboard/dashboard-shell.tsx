"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { Button } from "@/components/ui/button";
import { DemoBanner } from "@/components/dashboard/demo-banner";
import { UploadPanel } from "@/components/dashboard/upload-panel";
import type { UploadResult } from "@/components/dashboard/upload-panel";
import { UpcomingPanel } from "@/components/dashboard/upcoming-panel";
import { HeatmapPanel } from "@/components/dashboard/heatmap-panel";
import { RoadmapPanel } from "@/components/dashboard/roadmap-panel";
import { SyncPanel } from "@/components/dashboard/sync-panel";
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
  }, [loadIdentity, loadCourses, loadPlan]);

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
  }, [loadCourses, loadPlan]);

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
            ) : user ? (
              <span className="flex items-center gap-2 rounded-full border border-line bg-surface py-1 pr-3 pl-1">
                <span
                  aria-hidden="true"
                  className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-[0.6875rem] font-semibold text-accent-on"
                >
                  {(user.name ?? user.email ?? "?").slice(0, 1).toUpperCase()}
                </span>
                <span className="max-w-32 truncate text-[0.8125rem] text-ink-soft">
                  {user.name ?? user.email}
                </span>
              </span>
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
            courses={courses}
            assessments={assessments}
            accents={accents}
            onRetry={() => void loadPlan()}
          />

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] lg:items-start">
            <div className="space-y-6">
              <UpcomingPanel
                loading={coursesLoading}
                error={coursesError}
                courses={courses}
                assessments={assessments}
                accents={accents}
                onRetry={() => void loadCourses()}
              />
              <RoadmapPanel
                loading={coursesLoading}
                error={coursesError}
                courses={courses}
                assessments={assessments}
                accents={accents}
                onRetry={() => void loadCourses()}
              />
            </div>

            <div className="space-y-6">
              <UploadPanel
                demoMode={demoMode}
                accent={nextAccent}
                onUploaded={onUploaded}
              />
              <SyncPanel
                demoMode={demoMode}
                googleReady={config?.googleReady ?? false}
                hasCourses={courses.length > 0}
              />
              <ChatPanel openaiReady={config?.openaiReady ?? false} />
            </div>
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
