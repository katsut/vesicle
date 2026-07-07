// Backlog OAuth 2.0 (authorization-code flow), per space.
//   1. send the user to authorizeUrl(...)              → Backlog asks them to grant access
//   2. Backlog redirects back to redirect_uri?code=…   → exchangeCode(...) for a bearer token
//   3. use the token as an OAuth `BacklogApiConfig` ({ host, token }) for project/webhook calls
//
// Register the OAuth app under the space's "Space settings → Integrations → Developer" to get the
// client id/secret and to whitelist the redirect URI. Endpoints are per-space (the host is in the URL).

export interface BacklogToken {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

export function authorizeUrl(host: string, clientId: string, redirectUri: string, state: string): string {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
  });
  return `https://${host}/OAuth2AccessRequest.action?${p.toString()}`;
}

export async function exchangeCode(
  host: string,
  opts: { clientId: string; clientSecret: string; code: string; redirectUri: string },
): Promise<BacklogToken> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });
  const r = await fetch(`https://${host}/api/v2/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`token exchange failed (${r.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text) as BacklogToken;
}

export async function refreshToken(
  host: string,
  opts: { clientId: string; clientSecret: string; refreshToken: string },
): Promise<BacklogToken> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });
  const r = await fetch(`https://${host}/api/v2/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`token refresh failed (${r.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text) as BacklogToken;
}
