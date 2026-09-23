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
/**
 * PostHog's ingestion origin, or empty when analytics is not configured.
 *
 * Origin only -- a CSP source with a path is ignored by some browsers and
 * misleading in all of them, so anything after the host is stripped rather
 * than trusted to be absent.
 */
/** `next dev` sets this; `next build` sets "production". */
const isDev = process.env.NODE_ENV !== "production";

const analyticsHost = (() => {
  if (!(process.env.NEXT_PUBLIC_POSTHOG_KEY ?? "").trim()) return "";
  const configured =
    (process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "").trim() || "https://us.i.posthog.com";
  try {
    return new URL(configured).origin;
  } catch {
    return "https://us.i.posthog.com";
  }
})();

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
      /**
       * `'unsafe-eval'` IN DEVELOPMENT ONLY, and it is not optional there.
       *
       * Next's dev bundler evaluates modules with `eval` (that is how HMR swaps
       * a module without a reload). With the production policy applied locally,
       * every one of those throws a CSP EvalError and **React never hydrates**
       * -- the server-rendered HTML paints, then nothing is interactive, no
       * effect runs, and no fetch fires. It looks like a dashboard stuck on
       * "Loading…" forever rather than like a security header, which is what
       * makes it worth this comment: the symptom does not point at the cause.
       *
       * Production bundles contain no `eval`, so the deployed policy stays
       * strict. `NODE_ENV` is set by Next itself (`next dev` vs `next build`),
       * not by anything an attacker can influence.
       */
      `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      // data: for the inlined SVG icons; https: so a Google profile picture
      // renders after sign-in.
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      /**
       * Same-origin, plus PostHog's ingestion host and nothing else.
       *
       * This is the only outbound destination the PAGE has; everything else the
       * app talks to (OpenAI, Google, Notion, Stripe) is called by the server,
       * which no CSP applies to. Read from the same env var the analytics client
       * initialises with, so opening the policy and pointing the SDK somewhere
       * else cannot become two separate edits -- and so a deployment with no
       * PostHog key keeps the original, tighter `'self'` policy.
       *
       * Note what is NOT opened: no `script-src` entry, because posthog-js is
       * bundled from npm rather than loaded from a CDN, and
       * `disable_external_dependency_loading` in the client keeps it that way.
       */
      `connect-src 'self'${analyticsHost ? ` ${analyticsHost}` : ""}`,
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
