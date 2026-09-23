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
 * Exactly what the consent screen asks for, and the whole of it.
 *
 * `openid`/`email`/`profile` identify the student; `calendar` is the
 * read-write scope -- `calendar.events` alone would not let us create the
 * dedicated "Syllabus Center" calendar.
 *
 * THIS LIST MUST MATCH THE APPROVED SCOPES IN THE CLOUD CONSOLE, exactly.
 * Google's answer to "my app is verified but users still see the unverified
 * warning" is that the OAuth request carries a scope the project was not
 * approved for -- so a scope added here and not there re-breaks a verified
 * app, silently, for every new user. `GOOGLE_CONSOLE_SCOPES` below is the same
 * list spelled the way the Console spells it, for comparing the two; `/admin`
 * prints it, and docs/DEPLOY.md section 3d is the checklist.
 */
export const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar",
] as const;

/**
 * The same four scopes as they appear in Google Auth Platform > Data Access.
 *
 * The Console does not use the short aliases: `email` and `profile` are listed
 * under their full `userinfo.*` URLs, which is exactly the mismatch that leaves
 * someone staring at an approved-looking scope list wondering why the warning
 * is still there. Paired with the alias so the comparison is a diff, not a
 * memory test.
 */
export const GOOGLE_CONSOLE_SCOPES: readonly { requested: string; console: string }[] = [
  { requested: "openid", console: "openid" },
  { requested: "email", console: "https://www.googleapis.com/auth/userinfo.email" },
  { requested: "profile", console: "https://www.googleapis.com/auth/userinfo.profile" },
  {
    requested: "https://www.googleapis.com/auth/calendar",
    console: "https://www.googleapis.com/auth/calendar",
  },
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
 * No `include_granted_scopes`. That flag is for incremental authorization --
 * asking for one more scope later and keeping the earlier ones -- and this app
 * has nothing incremental about it: `SCOPES` is fixed and requested in full on
 * every sign-in, so the flag could only ever widen the request, never narrow
 * it. Widening is the exact thing that puts the "Google hasn't verified this
 * app" screen back in front of users: a returning student who once granted
 * this client a scope the project is no longer approved for would have it
 * folded back into the request. Asking for precisely the four declared scopes
 * keeps the request identical to what the Console approved.
 *
 * @param state CSRF token the caller must echo-check on the callback.
 */
export function getAuthUrl(state: string): string {
  return createClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [...SCOPES],
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
  /**
   * The email must be one Google has verified, because the callback matches an
   * existing account by email (`getUserByEmail`). An unverified claim is a
   * string the identity's owner chose, so accepting it would let someone who
   * controls a Workspace domain mint an identity carrying another user's
   * address and be handed that account. The signature and audience are already
   * checked above, which is why this is the remaining gap rather than the whole
   * problem.
   */
  if (payload.email_verified !== true) {
    throw new Error(
      "Google has not verified that email address, so it cannot be used to sign in.",
    );
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
