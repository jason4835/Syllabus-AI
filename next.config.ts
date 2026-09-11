import type { NextConfig } from "next";

/**
 * Response headers for every route.
 *
 * The app sent none at all, which mattered most for framing: `/dashboard` could
 * be loaded in an iframe on any site, and while account deletion is gated
 * behind typing DELETE, "Reset feed link" and "Disconnect Notion" are single
 * clicks that a framed page can be tricked into receiving.
 *
 * The CSP is deliberately narrow because this app needs nothing wide: no
 * third-party scripts, no external stylesheets, no fonts beyond the system
 * stack, no embedded frames. `'unsafe-inline'` is present for styles only --
 * Next injects inline style attributes during hydration and there is no nonce
 * plumbing for them -- while scripts get `'self'` plus the inline-script nonce
 * Next manages itself. `'unsafe-eval'` is omitted; nothing here evals.
 */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    // Two years, with preload deliberately NOT claimed: preloading is effectively
    // irreversible and should be a decision made once the domain is settled.
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
  {
    // Nothing in the app uses any of these, so the answer is no rather than
    // "ask the user" -- a permission prompt from a syllabus planner is alarming.
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      // data: for the inlined SVG icons; https: so a Google profile picture
      // renders after sign-in.
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      // Same-origin only. Every outbound call this app makes is made by the
      // server, never by the page.
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  serverExternalPackages: ["pdf-parse"],
  /** Nothing gains from advertising the framework and its version. */
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
