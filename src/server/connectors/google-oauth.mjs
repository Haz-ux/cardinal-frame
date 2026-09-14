/**
 * Shared Google OAuth2 helper used by the Gmail and Google Calendar connectors.
 *
 * Only talks to https://accounts.google.com (authorize) and
 * https://oauth2.googleapis.com/token (token exchange/refresh). Tokens are
 * never logged. getValidAccessToken() auto-refreshes a minute before expiry
 * and persists refreshed tokens via the caller's `save` callback (which the
 * registry wires to encrypted storage).
 */

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FETCH_TIMEOUT_MS = 15000;
const REFRESH_SKEW_MS = 60_000; // refresh 60s before actual expiry

function postForm(url, params) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

/**
 * Build the Google consent-screen URL. Caller must store `state` on the
 * connector row before redirecting the browser to this URL (CSRF protection).
 */
export function buildAuthorizeUrl({ clientId, redirectUri, scopes, state }) {
  if (!clientId) throw new Error('clientId is required');
  if (!redirectUri) throw new Error('redirectUri is required');
  if (!state) throw new Error('state is required');
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', (scopes || []).join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('access_type', 'offline'); // ask for a refresh_token
  url.searchParams.set('prompt', 'consent');     // force re-consent so offline access is re-granted
  url.searchParams.set('include_granted_scopes', 'true');
  return url.toString();
}

/**
 * Exchange an authorization code for tokens.
 * Returns { access_token, refresh_token, expires_at (ms epoch), scope, token_type }.
 */
export async function exchangeCodeForTokens({ clientId, clientSecret, redirectUri, code }) {
  if (!clientId || !clientSecret || !redirectUri || !code) {
    throw new Error('clientId, clientSecret, redirectUri and code are all required');
  }
  const res = await postForm(GOOGLE_TOKEN_URL, {
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.error_description || data.error || `HTTP ${res.status}`;
    throw new Error(`Google token exchange failed: ${detail}`);
  }
  return normalizeTokens(data);
}

/**
 * Refresh an expired access token. Returns the same normalized token shape.
 */
export async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('clientId, clientSecret and refreshToken are all required');
  }
  const res = await postForm(GOOGLE_TOKEN_URL, {
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.error_description || data.error || `HTTP ${res.status}`;
    throw new Error(`Google token refresh failed: ${detail}`);
  }
  return normalizeTokens(data, refreshToken);
}

function normalizeTokens(data, existingRefreshToken) {
  return {
    access_token: data.access_token,
    // Google only returns refresh_token on the first grant; keep the old one.
    refresh_token: data.refresh_token || existingRefreshToken || null,
    expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : null,
    scope: data.scope || null,
    token_type: data.token_type || 'Bearer',
  };
}

/**
 * Return a valid access token for a Google connector.
 *
 * connectorState = { config: { oauth_client_id, ... }, secrets: { oauth_client: {...}, tokens: {...} } }
 * opts.save(newSecrets) — async; persists updated tokens (registry wires this to encrypted storage).
 *
 * Throws a plain Error (message only, no token material) when credentials
 * are missing or the refresh fails.
 */
export async function getValidAccessToken(connectorState, opts = {}) {
  const secrets = connectorState?.secrets || {};
  const tokens = secrets.tokens || {};
  const client = secrets.oauth_client || {};

  if (!tokens.access_token) {
    throw new Error('Google OAuth tokens are not configured — complete the OAuth flow first');
  }
  // Not (near) expiry → reuse.
  if (tokens.expires_at && Date.now() < tokens.expires_at - REFRESH_SKEW_MS) {
    return tokens.access_token;
  }
  // Expiry unknown or near → refresh.
  if (!tokens.refresh_token) {
    throw new Error('Google access token expired and no refresh token is stored — re-run the OAuth flow');
  }
  const clientId = client.client_id || connectorState?.config?.oauth_client_id;
  const clientSecret = client.client_secret;
  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth client credentials are not configured');
  }
  const refreshed = await refreshAccessToken({ clientId, clientSecret, refreshToken: tokens.refresh_token });
  const newSecrets = {
    ...secrets,
    oauth_client: client,
    tokens: { ...tokens, ...refreshed },
  };
  if (typeof opts.save === 'function') {
    await opts.save(newSecrets);
  }
  return refreshed.access_token;
}
