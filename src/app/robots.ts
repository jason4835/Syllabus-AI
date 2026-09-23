import type { MetadataRoute } from "next";

import { canonicalOrigin } from "@/lib/origin";

/**
 * Keeps crawlers off everything behind the front door.
 *
 * This is not about secrecy -- `/dashboard` and `/admin` are already gated, and
 * a crawler gets nothing from them. It is about cost. A visitor with no cookie
 * who reaches `/dashboard` is handed a sandbox: a `users` row, a term, three
 * sample courses and their assessments, parsed on the spot. That is the right
 * trade for a person deciding whether to sign up and pure waste for a bot, and
 * once an ad campaign is pointing traffic at the domain, the crawlers arrive in
 * numbers. Honest ones read this file; the dishonest ones are what the IP
 * budget in `@/lib/ratelimit` is for.
 *
 * `/api/` is disallowed for the same reason, plus one of its own: a crawled
 * `/api/feed/<token>.ics` would put a student's whole semester into a search
 * index. The token is unguessable and never linked, so this is belt and braces.
 */
export default function robots(): MetadataRoute.Robots {
  const origin = canonicalOrigin();
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/privacy", "/terms"],
      disallow: ["/dashboard", "/admin", "/api/"],
    },
    sitemap: `${origin}/sitemap.xml`,
  };
}
