/**
 * The one number that says which Terms a student agreed to.
 *
 * Recorded on the user row at sign-in (`terms_accepted_at`, `terms_version`)
 * and copied into every Stripe Checkout Session's metadata, so "did they
 * agree, and to what" is answerable from the database and from the Stripe
 * Dashboard independently. Bump it when the Terms materially change; the
 * next sign-in re-records under the new version.
 *
 * Kept as the "Last updated" date shown on /terms, so the two cannot drift.
 */
export const TERMS_VERSION = "2026-09-22";
