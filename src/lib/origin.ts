/**
 * The app's public origin, for the places that have no request to read it from.
 *
 * `publicOrigin(req)` in `@/lib/api` is the one to use inside a route handler:
 * it can fall back to the request's own headers. `robots.ts`, `sitemap.ts` and
 * the root layout's metadata are generated without a request in hand, so they
 * need this instead.
 *
 * The production domain is the fallback rather than localhost, because the
 * consequence of getting it wrong differs by direction: a sitemap that points
 * at localhost is worthless to a crawler, while one that points at the real
 * domain is correct even when generated somewhere else.
 */
const PRODUCTION_ORIGIN = "https://syllabuscenter.com";

export function canonicalOrigin(): string {
  const explicit = (process.env.APP_URL ?? "").trim().replace(/\/+$/, "");
  return explicit || PRODUCTION_ORIGIN;
}
