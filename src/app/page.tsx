import type { Metadata } from "next";
import { HeroPreview } from "@/components/landing/hero-preview";
import { LinkButton } from "@/components/ui/button";
import {
  ArrowRightIcon,
  CalendarIcon,
  ChatIcon,
  GoogleMark,
  Logo,
  RefreshIcon,
  SparkIcon,
  UploadIcon,
} from "@/components/icons";

export const metadata: Metadata = {
  title: "Syllabus AI — organize your semester in 60 seconds",
};

const STEPS = [
  {
    n: "01",
    icon: <UploadIcon width={20} height={20} />,
    title: "Upload",
    body: "Drop in every syllabus PDF you were handed during week one. One course or six.",
  },
  {
    n: "02",
    icon: <SparkIcon width={20} height={20} />,
    title: "AI extracts",
    body: "Assignments, exams, due dates and grading weights come out structured — with the source line kept for anything it is unsure about.",
  },
  {
    n: "03",
    icon: <CalendarIcon width={20} height={20} />,
    title: "Calendar synced",
    body: "Deadlines and suggested study blocks land in your Google Calendar, where you already look.",
  },
];

const DIFFERENTIATORS = [
  {
    icon: <RefreshIcon width={19} height={19} />,
    title: "Re-plans when the dates move",
    body: "A professor pushes the midterm a week. Your roadmap, study blocks and calendar events shift with it instead of quietly going stale.",
  },
  {
    icon: <CalendarIcon width={19} height={19} />,
    title: "A heatmap that warns you early",
    body: "Every week of the semester is scored by real workload, so the pile-up in week 11 is something you see in September — not the night before.",
  },
  {
    icon: <ChatIcon width={19} height={19} />,
    title: "Ask it in plain English",
    body: "“When should I start studying for Calc midterm?” It answers from your actual syllabi, weights and deadlines.",
  },
];

export default function LandingPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 border-b border-line bg-paper/85 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <a
            href="/"
            className="flex items-center gap-2.5 rounded-md font-serif text-[1.0625rem] font-semibold tracking-tight text-ink"
          >
            <Logo />
            Syllabus AI
          </a>
          <nav aria-label="Primary" className="flex items-center gap-1.5 sm:gap-2">
            <LinkButton href="/dashboard" variant="ghost" size="sm">
              Demo
            </LinkButton>
            <LinkButton href="/api/auth/google" variant="primary" size="sm">
              <GoogleMark />
              <span className="hidden sm:inline">Sign in with Google</span>
              <span className="sm:hidden">Sign in</span>
            </LinkButton>
          </nav>
        </div>
      </header>

      <main id="main" className="flex-1">
        {/* ---------------------------------------------------------- Hero */}
        <section className="ruled border-b border-line">
          <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:items-center lg:gap-14 lg:py-24">
            <div className="max-w-xl">
              <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-accent-line bg-accent-soft px-3 py-1 text-[0.75rem] font-medium tracking-wide text-accent">
                <SparkIcon width={14} height={14} />
                For students carrying five syllabi and no plan
              </p>
              <h1 className="text-[2.125rem] leading-[1.08] font-semibold tracking-[-0.02em] text-balance text-ink sm:text-hero lg:text-[3.125rem]">
                Upload your syllabus. Let AI organize your semester in 60
                seconds.
              </h1>
              <p className="mt-5 max-w-lg text-[1.0625rem] leading-relaxed text-ink-soft">
                Every assignment, exam and grading weight gets pulled out of your
                PDFs and turned into a semester plan. It syncs to your calendar
                and keeps adjusting all term — a living study system instead of
                six documents you never open again.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <LinkButton href="/api/auth/google" size="lg">
                  <GoogleMark />
                  Sign in with Google
                </LinkButton>
                <LinkButton href="/dashboard" variant="secondary" size="lg">
                  Try the demo
                  <ArrowRightIcon width={16} height={16} />
                </LinkButton>
              </div>
              <p className="mt-4 text-[0.8125rem] text-muted">
                The demo runs on sample syllabi — no account, no calendar access.
              </p>
            </div>

            <div className="lg:pl-4">
              <HeroPreview />
            </div>
          </div>
        </section>

        {/* -------------------------------------------------- How it works */}
        <section
          aria-labelledby="how-it-works"
          className="border-b border-line bg-surface"
        >
          <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 sm:py-18">
            <p className="text-[0.6875rem] font-semibold tracking-[0.14em] text-muted uppercase">
              How it works
            </p>
            <h2 id="how-it-works" className="mt-2 max-w-lg text-display text-ink">
              Three steps, then it runs itself.
            </h2>

            <ol className="mt-10 grid gap-6 sm:grid-cols-3 sm:gap-5">
              {STEPS.map((step, index) => (
                <li key={step.n} className="relative">
                  <div className="flex h-full flex-col rounded-xl border border-line bg-paper p-5">
                    <div className="mb-4 flex items-center justify-between">
                      <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-soft text-accent">
                        {step.icon}
                      </span>
                      <span className="font-mono text-[0.75rem] tracking-widest text-line-strong">
                        {step.n}
                      </span>
                    </div>
                    <h3 className="text-[1.0625rem] text-ink">{step.title}</h3>
                    <p className="mt-1.5 text-[0.875rem] leading-relaxed text-muted">
                      {step.body}
                    </p>
                  </div>
                  {index < STEPS.length - 1 ? (
                    <span
                      aria-hidden="true"
                      className="absolute top-1/2 -right-3.5 hidden text-line-strong sm:block"
                    >
                      <ArrowRightIcon width={16} height={16} />
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ----------------------------------------------- Differentiators */}
        <section aria-labelledby="why" className="border-b border-line">
          <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 sm:py-18">
            <div className="max-w-2xl">
              <p className="text-[0.6875rem] font-semibold tracking-[0.14em] text-muted uppercase">
                Why it holds up
              </p>
              <h2 id="why" className="mt-2 text-display text-ink">
                A calendar full of due dates is not a plan.
              </h2>
              <p className="mt-4 text-[1rem] leading-relaxed text-ink-soft">
                Anything can list deadlines. The useful part is knowing which
                weeks will hurt, what to start early, and what to do when the
                schedule changes underneath you.
              </p>
            </div>

            <ul className="mt-10 grid gap-4 md:grid-cols-3">
              {DIFFERENTIATORS.map((item) => (
                <li
                  key={item.title}
                  className="panel flex flex-col p-5"
                >
                  <span className="mb-3.5 flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-raised text-accent">
                    {item.icon}
                  </span>
                  <h3 className="text-[1.0625rem] leading-snug text-ink">
                    {item.title}
                  </h3>
                  <p className="mt-2 text-[0.875rem] leading-relaxed text-muted">
                    {item.body}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* --------------------------------------------------------- Close */}
        <section className="bg-surface">
          <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6">
            <div className="flex flex-col items-start gap-6 rounded-2xl border border-line bg-paper p-7 sm:p-10 md:flex-row md:items-center md:justify-between">
              <div className="max-w-lg">
                <h2 className="text-[1.5rem] leading-tight text-ink">
                  Start with the syllabus you were dreading.
                </h2>
                <p className="mt-2 text-[0.9375rem] leading-relaxed text-muted">
                  Sixty seconds from PDF to a semester you can actually see.
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                <LinkButton href="/api/auth/google" size="lg">
                  <GoogleMark />
                  Sign in with Google
                </LinkButton>
                <LinkButton href="/dashboard" variant="secondary" size="lg">
                  Try the demo
                </LinkButton>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line bg-paper">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-center gap-2.5">
            <Logo />
            <div>
              <p className="font-serif text-[0.9375rem] font-semibold text-ink">
                Syllabus AI
              </p>
              <p className="text-[0.75rem] text-muted">
                A study system that keeps up with the semester.
              </p>
            </div>
          </div>
          <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2 text-[0.8125rem] text-muted">
            <a href="/dashboard" className="rounded-sm hover:text-ink">
              Dashboard
            </a>
            <a href="#how-it-works" className="rounded-sm hover:text-ink">
              How it works
            </a>
            <a href="#why" className="rounded-sm hover:text-ink">
              Why it holds up
            </a>
          </nav>
          <p className="text-[0.75rem] text-muted">
            Built for students who feel behind by week three.
          </p>
        </div>
      </footer>
    </div>
  );
}
