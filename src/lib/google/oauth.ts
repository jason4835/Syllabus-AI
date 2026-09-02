/**
 * Google OAuth 2.0 -- consent URL, code exchange, and long-lived client reuse.
 *
 * The app only ever holds a *refresh* token (in the user store). Access tokens
 * are minted on demand and never persisted, so a leaked database row expires
 * the moment the user revokes the grant rather than an hour later.
 *
 * Server-only. Nothing in here may be imported from a client component: it
 * reads GOOGLE_CLIENT_SECRET.
 */

import { google } from "googleapis";
import { store } from "@/lib/store";

/**
 * Derived from `google.auth.OAuth2` rather than imported from
 * google-auth-library so we depend only on the package listed in package.json.
 */
export type GoogleOAuth2Client = InstanceType<typeof google.auth.OAuth2>;

/**
 * `openid`/`email`/`profile` identify the student; `calendar` is the
 * read-write scope -- `calendar.events` alone would not let us create the
 * dedicated "Syllabus AI" calendar.
 */
const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar",
];

const DEFAULT_REDIRECT_URI = "http://localhost:3000/api/auth/callback";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Name the variable: "invalid_client" from Google is a miserable way to
    // discover you forgot one.
    throw new Error(
      `Missing required environment variable ${name}. Set it (or run in demo mode with no Google credentials at all).`,
    );
  }
  return value;
}

function getRedirectUri(): string {
  return process.env.GOOGLE_REDIRECT_URI || DEFAULT_REDIRECT_URI;
}

/** True when a real Google sign-in is possible; false means the app is in demo mode. */
export function isGoogleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function createClient(): GoogleOAuth2Client {
  return new google.auth.OAuth2(
    requireEnv("GOOGLE_CLIENT_ID"),
    requireEnv("GOOGLE_CLIENT_SECRET"),
    getRedirectUri(),
  );
}

/**
 * Builds the consent URL.
 *
 * `access_type: "offline"` plus `prompt: "consent"` is the only combination
 * that reliably returns a refresh token: without the forced prompt, Google
 * omits it on every grant after the first, and the user ends up with an
 * account that can never sync again.
 *
 * @param state CSRF token the caller must echo-check on the callback.
 */
export function getAuthUrl(state: string): string {
  return createClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    include_granted_scopes: true,
    state,
  });
}

export interface GoogleProfile {
  /** Google's stable user id. Safe to key on; email is not (it can change). */
  sub: string;
  email: string;
  name: string | null;
  picture: string | null;
}

export interface CodeExchangeResult {
  profile: GoogleProfile;
  /** Null when Google declined to reissue one -- the caller must keep any token it already has. */
  refreshToken: string | null;
  accessToken: string;
}

/** Swaps an authorization code for tokens and the signed-in user's profile. */
export async function exchangeCode(code: string): Promise<CodeExchangeResult> {
  const client = createClient();
  const { tokens } = await client.getToken(code);

  if (!tokens.access_token) {
    throw new Error("Google did not return an access token for this authorization code.");
  }
  if (!tokens.id_token) {
    throw new Error("Google did not return an id_token -- was the 'openid' scope requested?");
  }

  // Verify rather than merely decode: the id_token is what tells us *who* this
  // is, so an unverified signature would be an identity hole.
  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: requireEnv("GOOGLE_CLIENT_ID"),
  });
  const payload = ticket.getPayload();

  if (!payload?.sub || !payload.email) {
    throw new Error("Google id_token is missing the subject or email claim.");
  }

  return {
    profile: {
      sub: payload.sub,
      email: payload.email,
      name: payload.name ?? null,
      picture: payload.picture ?? null,
    },
    refreshToken: tokens.refresh_token ?? null,
    accessToken: tokens.access_token,
  };
}

/**
 * Returns a client already primed with the user's refresh token and a fresh
 * access token.
 *
 * Google occasionally rotates refresh tokens; if it hands us a new one we
 * write it straight back, otherwise the next sync would authenticate with a
 * token Google has already retired.
 */
export async function getAuthedClient(userId: string): Promise<GoogleOAuth2Client> {
  if (!isGoogleConfigured()) {
    throw new Error(
      "Google is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). Calendar sync is unavailable.",
    );
  }

  const user = await store.getUser(userId);
  if (!user) throw new Error(`No user found for id ${userId}.`);

  const refreshToken = user.googleRefreshToken;
  if (!refreshToken) {
    throw new Error(
      `User ${userId} has not granted Google Calendar access. Send them through /api/auth/google first.`,
    );
  }

  const client = createClient();
  client.setCredentials({ refresh_token: refreshToken });

  // Forces a refresh when there is no live access token, which is always the
  // case here since we never persist them.
  await client.getAccessToken();

  const rotated = client.credentials.refresh_token;
  if (rotated && rotated !== refreshToken) {
    await store.upsertUser({ ...user, googleRefreshToken: rotated });
  }

  return client;
}
