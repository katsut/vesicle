// Google OAuth 2.0 (authorization-code flow) for the Drive connector.
//   1. send the user to authorizeUrl(...)                 → Google asks them to grant read access
//   2. Google redirects back to redirect_uri?code=…       → exchangeCode(...) for a token pair
//   3. use the access token as a Drive `GdriveApiConfig` ({ token }) for files/changes calls
//
// Unlike Backlog, the endpoints are central (accounts.google.com / oauth2.googleapis.com — no
// per-tenant host), and Google does NOT rotate the refresh token on refresh: the refresh response
// usually omits `refresh_token`, so the caller must keep the stored one when the field is absent.
// `access_type=offline` + `prompt=consent` force a refresh token on the initial grant.

export interface GoogleToken {
  access_token: string;
  /** present on the initial code exchange; usually ABSENT on refresh — keep the stored one */
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Read-only Drive scope — metadata, permissions, and (later) content, no writes. */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: DRIVE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTH_URL}?${p.toString()}`;
}

export async function exchangeCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<GoogleToken> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`token exchange failed (${r.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text) as GoogleToken;
}

export async function refreshToken(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<GoogleToken> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`token refresh failed (${r.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text) as GoogleToken;
}
