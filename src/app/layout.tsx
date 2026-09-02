import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Syllabus AI — organize your semester in 60 seconds",
    template: "%s · Syllabus AI",
  },
  description:
    "Upload your syllabus PDFs. Syllabus AI extracts every assignment, exam and grading weight, builds a semester roadmap with a workload heatmap, and syncs it to your Google Calendar.",
  applicationName: "Syllabus AI",
  openGraph: {
    title: "Syllabus AI",
    description:
      "Upload your syllabus. Let AI organize your semester in 60 seconds.",
    type: "website",
  },
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
