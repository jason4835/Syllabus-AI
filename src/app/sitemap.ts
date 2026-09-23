import type { MetadataRoute } from "next";

import { canonicalOrigin } from "@/lib/origin";

/**
 * The three pages worth indexing. Everything else is either gated or private.
 *
 * The legal pages are here deliberately rather than as an afterthought: Google's
 * OAuth verification checks that the privacy policy is reachable on the verified
 * domain, and an ad account's review does the same.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = canonicalOrigin();
  const lastModified = new Date("2026-09-22");
  return [
    { url: origin, lastModified, changeFrequency: "weekly", priority: 1 },
    { url: `${origin}/privacy`, lastModified, changeFrequency: "yearly", priority: 0.3 },
    { url: `${origin}/terms`, lastModified, changeFrequency: "yearly", priority: 0.3 },
  ];
}
