import type { SessionData, Env } from '../types';
import { resolveIdpSettings } from './idp';
import type { SessionStore } from './session';

// Takes SessionData's own `expires_at` (set from the token response's `expires_in`
// at login/refresh time — see auth.ts/device.ts/refresh.ts) rather than decoding
// access_token as a JWT: since this app never sends an `audience` param, Auth0
// issues an *opaque* access token here, not a JWT. Decoding it as one always threw,
// and the old catch-and-assume-expired fallback meant every single authenticated
// request forced a token refresh (and a KV write) — this is almost certainly what
// was driving the Workers KV write quota, not attack traffic.
export function isTokenExpiringSoon(expiresAt: number, secondsThreshold = 30): boolean {
  return Date.now() / 1000 + secondsThreshold >= expiresAt;
}

// 'refused': the provider said no (or there's nothing to refresh with) -
// the session ends. 'unreachable': no answer from the provider (offline, a
// local box without internet - OFFLINE.md, or the provider down) - the
// session stays as it is and is refreshed once the provider answers again.
export type RefreshOutcome = 'ok' | 'refused' | 'unreachable';

// After an unreachable provider, this isolate/process doesn't ask again for
// a minute: every request would otherwise wait for the same timeout.
const RETRY_AFTER_MS = 60_000;
const TIMEOUT_MS = 5_000;
let unreachableUntil = 0;

export function resetRefreshBackoff() {
  unreachableUntil = 0;
}

export async function refreshUserToken(
  sessionData: SessionData,
  sessionId: string,
  sessionStore: SessionStore,
  env: Env
): Promise<RefreshOutcome> {
  const refreshToken = sessionData.refresh_token;
  if (!refreshToken) {
    console.error('No refresh token available');
    return 'refused';
  }
  if (Date.now() < unreachableUntil) return 'unreachable';
  const unreachable = (why: unknown): RefreshOutcome => {
    console.error('Login provider unreachable for a token refresh', why);
    unreachableUntil = Date.now() + RETRY_AFTER_MS;
    return 'unreachable';
  };

  // Refresh must use the same client the session was created with (a
  // provider like Google has one per flow). `?? 'authcode'` covers a session
  // created before authPurpose existed: at the time, every flow used the
  // one primary client, exactly what 'authcode' still resolves to without
  // an auth_code_client_id override configured.
  let response: Response;
  try {
    const idp = await resolveIdpSettings(env, sessionData.authPurpose ?? 'authcode');
    response = await fetch(idp.endpoints.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: idp.clientId,
        client_secret: idp.clientSecret,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return unreachable(err);
  }

  // A 5xx or a rate limit is the provider not answering, not a refusal.
  if (response.status >= 500 || response.status === 429) return unreachable(`HTTP ${response.status}`);
  if (!response.ok) {
    console.error('Refresh failed', await response.text());
    return 'refused';
  }

  try {
    const tokens = (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    await sessionStore.set(sessionId, {
      ...sessionData,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? sessionData.refresh_token,
      expires_at: Date.now() / 1000 + tokens.expires_in,
    } satisfies SessionData);
    return 'ok';
  } catch (err) {
    console.error('Refresh response error', err);
    return 'refused';
  }
}
