import type { ReactNode } from "react";
import { Logo } from "@/components/icons";
import { SiteFooter } from "@/components/site-footer";

/**
 * Chrome for the privacy and terms pages. Deliberately plain: these are read
 * by a Google reviewer and by a student deciding whether to trust the app, and
 * both are better served by legible prose than by product styling.
 */
export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-paper">
      <header className="border-b border-line">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-2.5 px-4 py-4 sm:px-6">
          <a href="/" className="flex items-center gap-2.5 rounded-sm">
            <Logo />
            <span className="font-serif text-[1.0625rem] font-semibold text-ink">
              Syllabus Center
            </span>
          </a>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
        <h1 className="font-serif text-[2rem] leading-tight font-semibold text-ink sm:text-[2.5rem]">
          {title}
        </h1>
        <p className="mt-2 text-[0.8125rem] text-muted">Last updated {updated}</p>
        <div className="legal mt-8">{children}</div>
      </main>

      <SiteFooter variant="plain" />
    </div>
  );
}
