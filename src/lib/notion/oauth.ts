/**
 * Notion OAuth 2.0 -- consent URL and code exchange.
 *
 * Mirrors `@/lib/google/oauth` deliberately: same `is<Provider>Configured()`
 * gate, same "name the missing env var" failure mode, same shape of exchange
 * result. Two differences are Notion's, not ours:
 *
 * 1. **There is no refresh token.** A Notion access token does not expire; it
 *    dies only when the user removes the integration, which shows up as a 401
 *    on the next call. So unlike Google -- where we deliberately persist only
 *    the refresh token and mint access tokens on demand -- the long-lived
 *    bearer secret itself has to be stored. It never leaves the server and
 *    never reaches a log line.
 *
 * 2. **The consent screen is also the page picker.** Scopes are fixed by the
 *    integration's settings; what the user chooses at consent time is which
 *    pages we can see. `owner=user` is what makes it a per-user grant rather
 *    than an internal integration bound to one workspace admin.
 *
 * Server-only: this reads NOTION_CLIENT_SECRET.
 */

import { Client } from "@notionhq/client";

const AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize";
const DEFAULT_REDIRECT_URI = "http://localhost:3000/api/notion/callback";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Naming the variable matters: Notion answers a bad exchange with a bare
    // "invalid_client", which tells you nothing about which half is missing.
    throw new Error(
      `Missing required environment variable ${name}. Set it (or leave both Notion variables unset to run without the integration).`,
    );
  }
  return value;
}

function getRedirectUri(): string {
  return process.env.NOTION_REDIRECT_URI || DEFAULT_REDIRECT_URI;
}

/** True when a real Notion connection is possible; false hides the panel. */
export function isNotionConfigured(): boolean {
  return Boolean(process.env.NOTION_CLIENT_ID && process.env.NOTION_CLIENT_SECRET);
}

/**
 * Builds the consent URL.
 *
 * @param state CSRF token the caller must echo-check on the callback, exactly
 *              as the Google flow does.
 */
export function getNotionAuthUrl(state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", requireEnv("NOTION_CLIENT_ID"));
  url.searchParams.set("response_type", "code");
  // Per-user grant. Without it Notion issues an internal-integration token
  // scoped to whoever configured the integration, not to the student.
  url.searchParams.set("owner", "user");
  url.searchParams.set("redirect_uri", getRedirectUri());
  url.searchParams.set("state", state);
  return url.toString();
}

export interface NotionCodeExchangeResult {
  /** Bearer secret. Store it on the connection; never send it to the browser. */
  accessToken: string;
  workspaceId: string;
  workspaceName: string | null;
  botId: string | null;
}

/**
 * Swaps an authorization code for a workspace token.
 *
 * The SDK's `oauth.token` is a thin wrapper over
 * `POST https://api.notion.com/v1/oauth/token`; handing it `client_id` and
 * `client_secret` is what makes it send
 * `Authorization: Basic base64(client_id:client_secret)`, which is the only
 * auth Notion accepts on this endpoint. Doing it through the SDK rather than
 * hand-rolling `fetch` keeps the credential encoding in one audited place --
 * the same reason the Google flow leans on `googleapis` instead of building
 * its own token request.
 */
export async function exchangeNotionCode(code: string): Promise<NotionCodeExchangeResult> {
  const clientId = requireEnv("NOTION_CLIENT_ID");
  const clientSecret = requireEnv("NOTION_CLIENT_SECRET");

  // No `auth` on the client: this call authenticates with the integration's
  // credentials, not with a user token we do not have yet.
  const response = await new Client().oauth.token({
    grant_type: "authorization_code",
    code,
    // Notion re-validates the redirect against the one used for the authorize
    // step, so a mismatch here is a silent auth failure later.
    redirect_uri: getRedirectUri(),
    client_id: clientId,
    client_secret: clientSecret,
  });

  if (!response.access_token) {
    throw new Error("Notion did not return an access token for this authorization code.");
  }
  if (!response.workspace_id) {
    throw new Error("Notion did not return a workspace id for this authorization code.");
  }

  return {
    accessToken: response.access_token,
    workspaceId: response.workspace_id,
    workspaceName: response.workspace_name ?? null,
    botId: response.bot_id ?? null,
  };
}
