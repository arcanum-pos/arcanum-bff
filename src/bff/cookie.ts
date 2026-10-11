import type { Env } from '../types';

// The session cookie. SameSite=Lax: every screen is same-origin behind this
// BFF, so the cookie never needs to go along on cross-site requests — and
// Lax keeps other sites from making requests with it (CSRF). It is still
// sent on the top-level redirect back from the login provider.
//
// Named __Host-session_id: the browser then only accepts it Secure, for
// Path=/ and without a Domain — no other (sub)domain can plant or overwrite
// it. Plain session_id only where that can't hold: local development over
// http, or a COOKIE_DOMAIN shared with another subdomain. Elsewhere an old
// session_id is never read (a sibling subdomain could plant one): a browser
// that still sends it is signed out, and it's cleared (index.ts).

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

// The session id — under this installation's cookie name only.
export function sessionIdFrom(request: Request, env: Env): string | null {
  return cookieValue(request, sessionCookieName(env));
}

// A station screen's or customer display's own key (arcanum-backend
// device-keys.ts): set when it's paired with its code alone (/pair), kept
// until the device is removed in the console — so ten years, and HttpOnly:
// the page's scripts never see it. __Host- like the session cookie, where it
// can be. Signing out a person leaves it alone: the device stays paired.
export function deviceCookieName(env: Env): string {
  return isDevelopment(env) || env.COOKIE_DOMAIN ? 'arcanum_device' : '__Host-arcanum_device';
}

export function buildDeviceCookie(env: Env, key: string): string {
  const base = `${deviceCookieName(env)}=${key}; Path=/; HttpOnly; SameSite=Lax; Max-Age=315360000`;
  if (isDevelopment(env)) return base;
  return env.COOKIE_DOMAIN ? `${base}; Domain=${env.COOKIE_DOMAIN}; Secure` : `${base}; Secure`;
}

export function deviceKeyFrom(request: Request, env: Env): string | null {
  const key = cookieValue(request, deviceCookieName(env));
  return key && /^[A-Za-z0-9_-]{20,100}$/.test(key) ? key : null;
}

// The login's own short-lived cookie (bff/auth.ts): its signed state.
export const LOGIN_STATE_COOKIE = 'oauth_state';

export function loginStateCookie(env: Env, value: string, maxAge: number): string {
  return `${LOGIN_STATE_COOKIE}=${value}; Path=/callback; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isDevelopment(env) ? '' : '; Secure'}`;
}
