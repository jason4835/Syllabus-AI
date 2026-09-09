import { Logo } from "@/components/icons";

/**
 * Shared across the landing page and the legal pages.
 *
 * Google's OAuth verification checks that the privacy policy is reachable and
 * linked from the app's homepage on the verified domain, so those two links
 * are load-bearing, not decoration -- keep them on every page that ships.
 */
export function SiteFooter({ variant = "landing" }: { variant?: "landing" | "plain" }) {
  return (
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
        <nav
          aria-label="Footer"
          className="flex flex-wrap gap-x-6 gap-y-2 text-[0.8125rem] text-muted"
        >
          <a href="/dashboard" className="rounded-sm hover:text-ink">
            Dashboard
          </a>
          {variant === "landing" ? (
            <>
              <a href="#how-it-works" className="rounded-sm hover:text-ink">
                How it works
              </a>
              <a href="#why" className="rounded-sm hover:text-ink">
                Why it holds up
              </a>
            </>
          ) : (
            <a href="/" className="rounded-sm hover:text-ink">
              Home
            </a>
          )}
          <a href="/privacy" className="rounded-sm hover:text-ink">
            Privacy
          </a>
          <a href="/terms" className="rounded-sm hover:text-ink">
            Terms
          </a>
          {/*
            AGPL-3.0 section 13: anyone interacting with a hosted instance
            must be able to get the source. This link is how that obligation
            is met, so keep it reachable on any deployment.
          */}
          <a
            href="https://github.com/jason4835/Syllabus-AI"
            className="rounded-sm hover:text-ink"
            target="_blank"
            rel="noreferrer noopener"
          >
            Source
          </a>
        </nav>
        <p className="text-[0.75rem] text-muted">
          Built for students who feel behind by week three.
          <br />
          &copy; 2026 Jason Paz &middot; AGPL-3.0
        </p>
      </div>
    </footer>
  );
}
