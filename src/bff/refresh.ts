import type { SessionData, Env } from '../types';
import { resolveIdpSettings } from '../types';
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

export async function refreshUserToken(
  sessionData: SessionData,
  sessionId: string,
  sessionStore: SessionStore,
  env: Env
): Promise<boolean> {
  const refreshToken = sessionData.refresh_token;
  if (!refreshToken) {
    console.error('No refresh token available');
    return false;
  }

  // Refresh must hit the same org's own token endpoint + client credentials
  // it originally logged in against — not the platform default's, once
  // per-org identity providers exist. `?? 'authcode'` covers a session
  // created before authPurpose existed: at the time, every flow used the
  // one primary client, exactly what 'authcode' still resolves to for an
  // org with no auth_code_client_id override configured.
  const idp = await resolveIdpSettings(sessionData.orgId, env, sessionData.authPurpose ?? 'authcode');

  try {
    const response = await fetch(idp.endpoints.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: idp.clientId,
        client_secret: idp.clientSecret,
      }),
    });

    if (!response.ok) {
      console.error('Refresh failed', await response.text());
      return false;
    }

    const tokens = (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number };

    await sessionStore.set(sessionId, {
      ...sessionData,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? sessionData.refresh_token,
      expires_at: Date.now() / 1000 + tokens.expires_in,
    } satisfies SessionData);

    return true;
  } catch (err) {
    console.error('Refresh request error', err);
    return false;
  }
}
