import type { Env } from '../types';

// SameSite=Lax: every screen is same-origin behind this BFF, so the cookie
// never needs to go along on cross-site requests — and Lax keeps other
// sites from making requests with it (CSRF). It is still sent on the
// top-level redirect back from the login provider, like oauth_state.
// (It used to be SameSite=None, from when the UI lived on another origin.)
export function buildSessionCookie(env: Env, sessionId: string): string {
  const isDevelopment = env.FRONTEND_URL?.includes('localhost') || env.FRONTEND_URL?.includes('127.0.0.1');
  const cookieBase = `session_id=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${env.SESSION_TTL}`;

  if (isDevelopment) return cookieBase;
  return env.COOKIE_DOMAIN ? `${cookieBase}; Domain=${env.COOKIE_DOMAIN}; Secure` : `${cookieBase}; Secure`;
}
