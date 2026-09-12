import type { SessionData, Env } from '../types';
import { getOAuthEndpoints } from '../types';
import type { SessionStore } from './session';

export function isTokenExpiringSoon(accessToken: string, secondsThreshold = 30): boolean {
  try {
    const payloadBase64 = accessToken.split('.')[1];
    let base64 = payloadBase64.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';

    const payload = JSON.parse(atob(base64)) as { exp?: number };
    const exp = (payload.exp ?? 0) * 1000;
    return Date.now() + secondsThreshold * 1000 >= exp;
  } catch {
    return true; // safer to refresh if we can't check
  }
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

  const { tokenEndpoint } = getOAuthEndpoints(env);

  try {
    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: env.OAUTH_CLIENT_ID,
        client_secret: env.OAUTH_CLIENT_SECRET,
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
