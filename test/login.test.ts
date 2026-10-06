// Login against the instance's identity provider (hosting plan phase 6):
// one provider per installation, resolved from arcanum-backend's
// /identity-provider/resolve (see vitest.config.ts's stub), and the browser
// always comes back to FRONTEND_URL — whichever hostname it started on.
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { SessionData } from '../src/types';

const BASE = 'https://arcanum.test'; // FRONTEND_URL in vitest.config.ts

function fakeJwt(payload: Record<string, unknown>): string {
  const part = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${part({ alg: 'none' })}.${part(payload)}.sig`;
}

function call(url: string, init?: RequestInit): Promise<Response> {
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const request = new Request(url, { redirect: 'manual', ...init });
  // /login is rate-limited per IP: a fresh one per call.
  if (!request.headers.has('CF-Connecting-IP')) request.headers.set('CF-Connecting-IP', `198.51.100.${Math.floor(Math.random() * 250)}-${crypto.randomUUID()}`);
  return worker.fetch(request, env, ctx);
}

// The login provider's token + userinfo endpoints (the bff calls them itself).
function mockProvider(claims: Record<string, unknown>, userinfo: Record<string, unknown> = {}) {
  const realFetch = globalThis.fetch;
  const seen: { url: string; body: string }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url === 'https://login.test/token') {
      seen.push({ url: request.url, body: new TextDecoder().decode(await request.arrayBuffer()) });
      return Response.json({ access_token: 'opaque', id_token: fakeJwt({ iss: 'https://login.test', ...claims }), expires_in: 3600 });
    }
    if (request.url === 'https://login.test/userinfo') return Response.json({ email: claims.email, name: 'Ann', ...userinfo });
    if (request.url === 'https://login.test/device/code') {
      seen.push({ url: request.url, body: new TextDecoder().decode(await request.arrayBuffer()) });
      return Response.json({ device_code: 'dc', user_code: 'ABCD', verification_uri_complete: 'https://login.test/activate?c=ABCD', expires_in: 600, interval: 5 });
    }
    return realFetch(input, init);
  });
  return seen;
}
afterEach(() => vi.restoreAllMocks());

// The browser's login state cookie from the last /login (sent back to /callback).
let stateCookie = '';
async function startLogin(url: string) {
  const res = await call(url);
  expect(res.status).toBe(302);
  stateCookie = res.headers.getSetCookie().find((c) => c.startsWith('oauth_state='))!.split(';')[0];
  return new URL(res.headers.get('Location')!);
}

const sessionCookieOf = (res: Response) => res.headers.getSetCookie().find((c) => /^(__Host-)?session_id=[^;]/.test(c))!.split(';')[0];
const callback = (state: string | null, cookie: string | null = stateCookie) =>
  call(`${BASE}/callback?code=c&state=${state}`, cookie ? { headers: { Cookie: cookie } } : {});

// A full browser login; returns the session cookie.
async function logIn(claims: Record<string, unknown>, userinfo?: Record<string, unknown>) {
  mockProvider(claims, userinfo);
  const authorize = await startLogin(`${BASE}/login?returnTo=/console`);
  const res = await callback(authorize.searchParams.get('state'));
  expect(res.status).toBe(302);
  return sessionCookieOf(res);
}

async function forwardedHeaders(cookie: string): Promise<Record<string, string>> {
  const res = await call(`${BASE}/api/organizations/memberships`, { headers: { Cookie: cookie } });
  const echo = (await res.json()) as { path: string; headers: Record<string, string> };
  expect(echo.path).toBe('/organizations/memberships');
  return echo.headers;
}

describe('/login', () => {
  it("redirects to the instance's provider with FRONTEND_URL/callback, whatever host the browser is on", async () => {
    for (const url of [`${BASE}/login`, 'https://pos.some-org.test/login', 'https://arcanum-bff.someone.workers.dev/login']) {
      const authorize = await startLogin(url);
      expect(`${authorize.origin}${authorize.pathname}`).toBe('https://login.test/authorize');
      expect(authorize.searchParams.get('client_id')).toBe('authcode-client');
      expect(authorize.searchParams.get('redirect_uri')).toBe(`${BASE}/callback`);
    }
  });

  it('comes back on FRONTEND_URL at returnTo, with a session', async () => {
    mockProvider({ sub: 'u1', email: 'ann@example.test' });
    const authorize = await startLogin('https://pos.some-org.test/login?returnTo=/console');
    const res = await callback(authorize.searchParams.get('state'));
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`${BASE}/console`);
    expect(sessionCookieOf(res)).toMatch(/^__Host-session_id=[0-9a-f]{64}$/);
  });

  it('the per-org login paths are gone', async () => {
    for (const path of ['/some-org/login', '/some-org/console']) {
      const res = await call(`${BASE}${path}`);
      expect(res.headers.get('Location') ?? '', path).not.toContain('login.test');
    }
  });
});

describe('email_verified reaches the backend', () => {
  it('false when the provider says unverified', async () => {
    const headers = await forwardedHeaders(await logIn({ sub: 'u2', email: 'guest@example.test', email_verified: false }));
    expect(headers['x-user-email']).toBe('guest@example.test');
    expect(headers['x-user-email-verified']).toBe('false');
    expect(headers['x-user-issuer']).toBe('https://login.test');
  });

  it('true when verified (also as the string some providers send)', async () => {
    expect((await forwardedHeaders(await logIn({ sub: 'u3', email: 'a@example.test', email_verified: true })))['x-user-email-verified']).toBe('true');
    vi.restoreAllMocks();
    expect((await forwardedHeaders(await logIn({ sub: 'u4', email: 'b@example.test', email_verified: 'true' })))['x-user-email-verified']).toBe('true');
  });

  it("from userinfo when the id_token doesn't carry it", async () => {
    const headers = await forwardedHeaders(await logIn({ sub: 'u5', email: 'c@example.test' }, { email_verified: false }));
    expect(headers['x-user-email-verified']).toBe('false');
  });

  it('absent when the provider sends no claim at all', async () => {
    const headers = await forwardedHeaders(await logIn({ sub: 'u6', email: 'd@example.test' }));
    expect(headers['x-user-email']).toBe('d@example.test');
    expect(headers['x-user-email-verified']).toBeUndefined();
  });

  it('a client cannot forge it', async () => {
    const cookie = await logIn({ sub: 'u7', email: 'e@example.test', email_verified: false });
    const res = await call(`${BASE}/api/organizations/memberships`, { headers: { Cookie: cookie, 'X-User-Email-Verified': 'true' } });
    expect(((await res.json()) as { headers: Record<string, string> }).headers['x-user-email-verified']).toBe('false');
  });
});

describe('/device', () => {
  it("starts the device grant with the instance's device client", async () => {
    const seen = mockProvider({});
    const res = await call(`${BASE}/device/start`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { userCode: string }).userCode).toBe('ABCD');
    expect(new URLSearchParams(seen[0].body).get('client_id')).toBe('device-client');
  });

  it('serves the QR page at /device only', async () => {
    expect(await (await call(`${BASE}/device`)).text()).toContain('frontends /device');
    const prefixed = await call(`${BASE}/some-org/device/start`, { method: 'POST' });
    expect(prefixed.status).not.toBe(200);
  });
});

describe('/logout', () => {
  it("signs out at the provider and returns to FRONTEND_URL — also for a session from before phase 6 (with an orgId)", async () => {
    const id = crypto.randomUUID().replace(/-/g, '');
    const old = { access_token: 'a', id_token: 'tok', refresh_token: null, email: '', name: '', expires_at: Date.now() / 1000 + 3600, issuer: 'https://login.test', authPurpose: 'authcode', orgId: 'pos.some-org.test' } satisfies SessionData & { orgId: string };
    await env.ARCANUM_SESSIONS.put(id, JSON.stringify(old));
    const res = await call(`${BASE}/logout`, { headers: { Cookie: `__Host-session_id=${id}` } });
    const location = new URL(res.headers.get('Location')!);
    expect(`${location.origin}${location.pathname}`).toBe('https://login.test/logout');
    expect(location.searchParams.get('post_logout_redirect_uri')).toBe(BASE);
    expect(location.searchParams.get('client_id')).toBe('authcode-client');
  });
});
