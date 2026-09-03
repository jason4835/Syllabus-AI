import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

/**
 * Absolute base for OG/Twitter image URLs. Unfurlers (iMessage, Slack, X,
 * LinkedIn, Discord) drop relative `og:image` values, so this has to resolve —
 * `APP_URL` when the host sets it, the Railway origin otherwise.
 */
const metadataBase = new URL(
  (process.env.APP_URL ?? "").trim().replace(/\/+$/, "") ||
    "https://syllabus-ai-production.up.railway.app",
);

const DESCRIPTION =
  "Upload your syllabus PDFs. Syllabus AI extracts every assignment, exam and grading weight, builds a semester roadmap with a workload heatmap, and syncs it to your Google Calendar.";

export const metadata: Metadata = {
  metadataBase,
  title: {
    default: "Syllabus AI — organize your semester in 60 seconds",
    template: "%s · Syllabus AI",
  },
  description: DESCRIPTION,
  applicationName: "Syllabus AI",
  openGraph: {
    title: "Syllabus AI — organize your semester in 60 seconds",
    description: DESCRIPTION,
    siteName: "Syllabus AI",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Syllabus AI — organize your semester in 60 seconds",
    description: DESCRIPTION,
  },
  // Icons come from the `icon.svg` / `apple-icon.tsx` file conventions.
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf8f3" },
    { media: "(prefers-color-scheme: dark)", color: "#14150f" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-accent-on"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
