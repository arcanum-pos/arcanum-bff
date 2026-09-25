// The session cookie (src/bff/cookie.ts).
import { describe, expect, it } from 'vitest';
import { buildSessionCookie } from '../src/bff/cookie';
import type { Env } from '../src/types';

const env = (over: Partial<Env>) => ({ SESSION_TTL: 604800, FRONTEND_URL: 'https://arcanum.test', ...over }) as unknown as Env;

describe('session cookie', () => {
  it('is SameSite=Lax, Secure and HttpOnly — never SameSite=None (the UI is same-origin; None would allow CSRF)', () => {
    const cookie = buildSessionCookie(env({}), 'abc');
    expect(cookie).toContain('session_id=abc');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).not.toMatch(/SameSite=None/i);
  });

  it('keeps Lax with a cookie domain, and in local development (without Secure on http)', () => {
    expect(buildSessionCookie(env({ COOKIE_DOMAIN: 'arcanum.test' }), 'abc')).toMatch(/Domain=arcanum\.test.*Secure|Secure.*Domain=arcanum\.test/);
    expect(buildSessionCookie(env({ COOKIE_DOMAIN: 'arcanum.test' }), 'abc')).toContain('SameSite=Lax');
    const dev = buildSessionCookie(env({ FRONTEND_URL: 'http://localhost:8787' }), 'abc');
    expect(dev).toContain('SameSite=Lax');
    expect(dev).not.toContain('Secure');
  });
});
