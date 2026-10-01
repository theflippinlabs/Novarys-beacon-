import { env } from "@/lib/env";
import { hmac, randomToken, safeEqual } from "@/lib/security/crypto";
import { AuthExpiredError, ProviderHttpError } from "./types";

/**
 * Google OAuth 2.0 (authorization code, offline access) for Search Console.
 * The only connection step left to an operator: create an OAuth client in
 * Google Cloud and set GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET.
 */
export const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const OAUTH_CALLBACK_PATH = "/api/integrations/google/callback";

export type GoogleOAuthClient = { clientId: string; clientSecret: string; redirectUri: string };

/** The configured OAuth client, or null when the environment does not provide one. */
export function googleOAuthClient(): GoogleOAuthClient | null {
  const e = env();
  if (!e.GOOGLE_OAUTH_CLIENT_ID || !e.GOOGLE_OAUTH_CLIENT_SECRET) return null;
  return { clientId: e.GOOGLE_OAUTH_CLIENT_ID, clientSecret: e.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri: `${e.BEACON_BASE_URL.replace(/\/$/, "")}${OAUTH_CALLBACK_PATH}` };
}

export function authorizationUrl(client: GoogleOAuthClient, state: string): string {
  const qs = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: "code",
    scope: GSC_SCOPE,
    access_type: "offline",
    // Force the consent screen so Google returns a refresh token on reconnect too.
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_ENDPOINT}?${qs}`;
}

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };

async function tokenRequest(body: Record<string, string>, fetchImpl: typeof fetch): Promise<TokenResponse> {
  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: TokenResponse = {};
  try {
    json = JSON.parse(text) as TokenResponse;
  } catch {
    // keep empty
  }
  if (!res.ok) {
    if (json.error === "invalid_grant" || res.status === 401) throw new AuthExpiredError(`Google authorisation expired or was revoked (${json.error ?? res.status}). Reconnect Search Console.`);
    throw new ProviderHttpError("google-oauth", res.status, json.error ? `${json.error}${json.error_description ? `: ${json.error_description}` : ""}` : "token request failed");
  }
  return json;
}

/** Exchange an authorization code for tokens (server side, never exposed to the browser). */
export async function exchangeCode(client: GoogleOAuthClient, code: string, fetchImpl: typeof fetch = fetch) {
  const json = await tokenRequest({ grant_type: "authorization_code", code, client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: client.redirectUri }, fetchImpl);
  if (!json.access_token) throw new Error("Google did not return an access token.");
  return { accessToken: json.access_token, refreshToken: json.refresh_token ?? null, scopes: (json.scope ?? "").split(/\s+/).filter(Boolean) };
}

/** A fresh access token from the stored refresh token (automatic refresh on every sync). */
export async function refreshAccessToken(client: GoogleOAuthClient, refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const json = await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: client.clientId, client_secret: client.clientSecret }, fetchImpl);
  if (!json.access_token) throw new Error("Google did not return an access token.");
  return json.access_token;
}

export type SearchConsoleSite = { siteUrl: string; permissionLevel: string };

/** Properties the authorised Google account can read (webmasters `sites.list`). */
export async function listSearchConsoleSites(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<SearchConsoleSite[]> {
  const res = await fetchImpl("https://www.googleapis.com/webmasters/v3/sites", { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new ProviderHttpError("search-console", res.status, await res.text());
  const json = (await res.json()) as { siteEntry?: SearchConsoleSite[] };
  return (json.siteEntry ?? []).filter((s) => s.permissionLevel !== "siteUnverifiedUser").map((s) => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel }));
}

// ── Signed state (CSRF protection, bound to organisation and user) ─────────
export type OAuthState = { o: string; u: string; p: string; n: string; e: number };

const STATE_TTL_MS = 10 * 60_000;

export function signOAuthState(input: { organizationId: string; userId: string; productId: string }, now = Date.now()): string {
  const payload: OAuthState = { o: input.organizationId, u: input.userId, p: input.productId, n: randomToken(12), e: now + STATE_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${hmac(body, "google-oauth-state")}`;
}

/** Verify signature, expiry and that the state belongs to the signed-in user and organisation. */
export function verifyOAuthState(state: string | null | undefined, expected: { organizationId: string; userId: string }, now = Date.now()): OAuthState | null {
  if (!state || state.length > 2000) return null;
  const [body, sig] = state.split(".");
  if (!body || !sig || !safeEqual(sig, hmac(body, "google-oauth-state"))) return null;
  let payload: OAuthState;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OAuthState;
  } catch {
    return null;
  }
  if (typeof payload.e !== "number" || payload.e < now) return null;
  if (payload.o !== expected.organizationId || payload.u !== expected.userId) return null;
  if (typeof payload.p !== "string" || !/^[0-9a-f-]{36}$/i.test(payload.p)) return null;
  return payload;
}
