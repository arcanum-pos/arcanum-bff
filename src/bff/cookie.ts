import type { Env } from '../types';

export function buildSessionCookie(env: Env, sessionId: string): string {
  const isDevelopment = env.FRONTEND_URL?.includes('localhost') || env.FRONTEND_URL?.includes('127.0.0.1');
  const cookieBase = `session_id=${sessionId}; Path=/; HttpOnly; Max-Age=${env.SESSION_TTL}`;

  if (isDevelopment) return cookieBase;
  return env.COOKIE_DOMAIN
    ? `${cookieBase}; Domain=${env.COOKIE_DOMAIN}; Secure; SameSite=None`
    : `${cookieBase}; Secure; SameSite=None`;
}
