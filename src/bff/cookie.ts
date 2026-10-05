import type { Env } from '../types';

// The session cookie. SameSite=Lax: every screen is same-origin behind this
// BFF, so the cookie never needs to go along on cross-site requests — and
// Lax keeps other sites from making requests with it (CSRF). It is still
// sent on the top-level redirect back from the login provider.
//
// Named __Host-session_id: the browser then only accepts it Secure, for
// Path=/ and without a Domain — no other (sub)domain can plant or overwrite
// it. Plain session_id where that can't hold: local development over http,
// or a COOKIE_DOMAIN shared with another subdomain. A browser that still
// has the old session_id keeps its session: it's read too, and moved over
// to the new name on its next response (index.ts).

export const LEGACY_SESSION_COOKIE = 'session_id';

export function isDevelopment(env: Env): boolean {
  return Boolean(env.FRONTEND_URL?.includes('localhost') || env.FRONTEND_URL?.includes('127.0.0.1'));
}

export function sessionCookieName(env: Env): string {
  return isDevelopment(env) || env.COOKIE_DOMAIN ? LEGACY_SESSION_COOKIE : '__Host-session_id';
}

export function buildSessionCookie(env: Env, sessionId: string): string {
  const cookieBase = `${sessionCookieName(env)}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${env.SESSION_TTL}`;
  if (isDevelopment(env)) return cookieBase;
  return env.COOKIE_DOMAIN ? `${cookieBase}; Domain=${env.COOKIE_DOMAIN}; Secure` : `${cookieBase}; Secure`;
}

// Both names, cleared (logout).
export function clearSessionCookies(env: Env): string[] {
  const secure = isDevelopment(env) ? '' : '; Secure';
  const cleared = [`${LEGACY_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`];
  if (sessionCookieName(env) !== LEGACY_SESSION_COOKIE) cleared.push(`${sessionCookieName(env)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`);
  return cleared;
}

export function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=') || null;
  }
  return null;
}

// The session id: the current cookie name first, else the old one.
export function sessionIdFrom(request: Request, env: Env): string | null {
  return cookieValue(request, sessionCookieName(env)) ?? cookieValue(request, LEGACY_SESSION_COOKIE);
}

// The login's own short-lived cookie (bff/auth.ts): its signed state.
export const LOGIN_STATE_COOKIE = 'oauth_state';

export function loginStateCookie(env: Env, value: string, maxAge: number): string {
  return `${LOGIN_STATE_COOKIE}=${value}; Path=/callback; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isDevelopment(env) ? '' : '; Secure'}`;
}
