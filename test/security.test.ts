// The security review's fixes (2026-10): login CSRF, no KV writes before a
// login succeeds, sessions encrypted at rest, the __Host- session cookie
// (old cookies moved over), no bearer-token way in, a parallel refresh, the
// backend allowlist, security headers, and logout from another site.
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { CloudflareKVSessionStore } from '../src/adapters/kv_session_store';
import type { SessionData } from '../src/types';

const BASE = 'https://arcanum.test';

function fakeJwt(payload: Record<string, unknown>): string {
  const part = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${part({ alg: 'none' })}.${part(payload)}.sig`;
}

function call(url: string, init?: RequestInit, ip = `198.51.100.${Math.floor(Math.random() * 250)}-${crypto.randomUUID()}`): Promise<Response> {
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const request = new Request(url, { redirect: 'manual', ...init });
  if (!request.headers.has('CF-Connecting-IP')) request.headers.set('CF-Connecting-IP', ip);
  return worker.fetch(request, env, ctx);
}

const outbound: string[] = [];
function mockProvider(opts: { refresh?: (body: URLSearchParams) => Response | Promise<Response> } = {}) {
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    outbound.push(request.url);
    if (request.url === 'https://login.test/token') {
      const body = new URLSearchParams(await request.text());
      if (body.get('grant_type') === 'refresh_token' && opts.refresh) return opts.refresh(body);
      if (body.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') return Response.json({ error: 'authorization_pending' }, { status: 400 });
      return Response.json({ access_token: 'opaque-access', refresh_token: 'rt-1', id_token: fakeJwt({ iss: 'https://login.test', sub: 'u1', email: 'ann@example.test' }), expires_in: 3600 });
    }
    if (request.url === 'https://login.test/userinfo') return Response.json({ email: 'ann@example.test', name: 'Ann' });
    if (request.url === 'https://login.test/device/code') return Response.json({ device_code: 'the-device-code', user_code: 'ABCD', verification_uri_complete: 'https://login.test/device?user_code=ABCD', expires_in: 600, interval: 5 });
    return realFetch(input, init);
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  outbound.length = 0;
});

const kvKeys = async () => (await env.ARCANUM_SESSIONS.list()).keys.map((k) => k.name);
const stateOf = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith('oauth_state='))!.split(';')[0];
const sessionOf = (res: Response) => res.headers.getSetCookie().find((c) => /^(__Host-)?session_id=[^;]/.test(c))?.split(';')[0];

async function login(): Promise<string> {
  mockProvider();
  const start = await call(`${BASE}/login`);
  const state = new URL(start.headers.get('Location')!).searchParams.get('state');
  const res = await call(`${BASE}/callback?code=c&state=${state}`, { headers: { Cookie: stateOf(start) } });
  return sessionOf(res)!;
}

// A session in KV the way the bff writes it.
async function storeSession(data: Partial<SessionData> = {}) {
  const id = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const session: SessionData = {
    access_token: 'opaque-access',
    id_token: fakeJwt({ sub: 'u9', email: 'zoe@example.test' }),
    refresh_token: 'rt-old',
    email: 'zoe@example.test',
    name: 'Zoe',
    expires_at: Date.now() / 1000 + 3600,
    issuer: 'https://login.test',
    authPurpose: 'authcode',
    ...data,
  };
  await new CloudflareKVSessionStore(env.ARCANUM_SESSIONS, env).set(id, session);
  return id;
}

describe('login', () => {
  it('starts without writing to KV, and the callback only goes on for the browser that started it (no login CSRF)', async () => {
    mockProvider();
    const before = await kvKeys();
    const start = await call(`${BASE}/login?returnTo=/console`);
    expect(await kvKeys()).toEqual(before);
    const cookie = start.headers.getSetCookie().find((c) => c.startsWith('oauth_state='))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const state = new URL(start.headers.get('Location')!).searchParams.get('state')!;

    // An attacker's code + state, opened in a browser without that login's cookie (or with another login's).
    expect((await call(`${BASE}/callback?code=c&state=${state}`)).status).toBe(400);
    const other = await call(`${BASE}/login`);
    expect((await call(`${BASE}/callback?code=c&state=${state}`, { headers: { Cookie: stateOf(other) } })).status).toBe(400);
    // A tampered cookie.
    const tampered = stateOf(start).replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    expect((await call(`${BASE}/callback?code=c&state=${state}`, { headers: { Cookie: tampered } })).status).toBe(400);

    const ok = await call(`${BASE}/callback?code=c&state=${state}`, { headers: { Cookie: stateOf(start) } });
    expect(ok.status).toBe(302);
    expect(ok.headers.get('Location')).toBe(`${BASE}/console`);
    // The state cookie is cleared, the session cookie set.
    expect(ok.headers.getSetCookie().some((c) => /^oauth_state=;.*Max-Age=0/.test(c))).toBe(true);
    expect(sessionOf(ok)).toMatch(/^__Host-session_id=[0-9a-f]{64}$/);
  });

  it('the session is __Host-, Secure, HttpOnly, SameSite=Lax — and stored encrypted: no token readable in KV', async () => {
    const cookie = await login();
    const id = cookie.split('=')[1];
    const raw = (await env.ARCANUM_SESSIONS.get(id))!;
    expect(raw.startsWith('v1.')).toBe(true);
    expect(raw).not.toContain('opaque-access');
    expect(raw).not.toContain('rt-1');
    expect(raw).not.toContain('ann@example.test');
    // Copied under another id it doesn't open.
    await env.ARCANUM_SESSIONS.put('f'.repeat(64), raw);
    expect((await call(`${BASE}/whoami`, { headers: { Cookie: `__Host-session_id=${'f'.repeat(64)}` } })).status).toBe(401);
    expect((await call(`${BASE}/whoami`, { headers: { Cookie: cookie } })).status).toBe(200);
  });
});

describe('the old session_id cookie', () => {
  it('is never read any more (a sibling subdomain could plant one) — and a browser that still sends it gets it cleared', async () => {
    const id = 'a'.repeat(64);
    await env.ARCANUM_SESSIONS.put(id, JSON.stringify({ access_token: 'x', id_token: fakeJwt({ sub: 'old', email: 'old@example.test' }), refresh_token: null, email: 'old@example.test', name: '', expires_at: Date.now() / 1000 + 3600, issuer: 'https://login.test', authPurpose: 'authcode' }));
    const res = await call(`${BASE}/whoami`, { headers: { Cookie: `session_id=${id}` } });
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toEqual(['session_id=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure']);
    // Not moved over to the new name.
    expect(res.headers.getSetCookie().some((c) => c.startsWith('__Host-session_id='))).toBe(false);
    // A browser with the current cookie only: nothing to clear.
    expect((await call(`${BASE}/whoami`, { headers: { Cookie: `__Host-session_id=${await storeSession()}` } })).headers.getSetCookie()).toEqual([]);
  });
});

describe('no bearer-token way in', () => {
  it('an Authorization header is not a session — and causes no call to the login provider', async () => {
    mockProvider();
    expect((await call(`${BASE}/whoami`, { headers: { Authorization: 'Bearer some-token-from-another-installation' } })).status).toBe(401);
    expect((await call(`${BASE}/api/organizations/memberships`, { headers: { Authorization: 'Bearer x' } })).status).toBe(401);
    expect((await call(`${BASE}/installer/api/status`, { headers: { Authorization: 'Bearer x', Accept: 'application/json' } })).status).toBe(401);
    expect(outbound).toEqual([]);
  });
});

describe('device login', () => {
  it('starts without writing to KV; the poll id is signed (a changed one is refused); starts are rate-limited per IP', async () => {
    mockProvider();
    const before = await kvKeys();
    const ip = `203.0.113.${Math.floor(Math.random() * 250)}`;
    const res = await call(`${BASE}/device/start`, { method: 'POST' }, ip);
    expect(res.status).toBe(200);
    const { pollId } = (await res.json()) as { pollId: string };
    expect(await kvKeys()).toEqual(before);
    expect(pollId).not.toContain('the-device-code'); // carried, but not as plain text
    expect(((await (await call(`${BASE}/device/poll?id=${encodeURIComponent(pollId)}`)).json()) as { status: string }).status).toBe('pending');
    const forged = pollId.replace(/^[^.]+/, btoa(JSON.stringify({ dc: 'someone-elses', k: 'device-poll', exp: 9e9 })).replace(/=+$/, ''));
    expect(((await (await call(`${BASE}/device/poll?id=${encodeURIComponent(forged)}`)).json()) as { status: string }).status).toBe('error');
    // A login's state cookie can't stand in for a poll id.
    const start = await call(`${BASE}/login`);
    const stateValue = stateOf(start).split('=')[1];
    expect(((await (await call(`${BASE}/device/poll?id=${encodeURIComponent(stateValue)}`)).json()) as { status: string }).status).toBe('error');

    let limited = false;
    for (let i = 0; i < 8 && !limited; i++) limited = (await call(`${BASE}/device/start`, { method: 'POST' }, ip)).status === 429;
    expect(limited).toBe(true);
  });
});

describe('token refresh', () => {
  it("when another request of this browser refreshed first, the refused refresh doesn't sign it out", async () => {
    const id = await storeSession({ expires_at: Date.now() / 1000 + 5, refresh_token: 'rt-old' });
    mockProvider({
      // The provider refuses the old token — the parallel request already used it and stored the new pair.
      refresh: async () => {
        await new CloudflareKVSessionStore(env.ARCANUM_SESSIONS, env).set(id, {
          access_token: 'fresh', id_token: fakeJwt({ sub: 'u9', email: 'zoe@example.test' }), refresh_token: 'rt-new', email: 'zoe@example.test', name: 'Zoe', expires_at: Date.now() / 1000 + 3600, issuer: 'https://login.test', authPurpose: 'authcode',
        } satisfies SessionData);
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      },
    });
    expect((await call(`${BASE}/whoami`, { headers: { Cookie: `__Host-session_id=${id}` } })).status).toBe(200);
  });

  it('a refused refresh with nothing newer still signs out', async () => {
    const id = await storeSession({ expires_at: Date.now() / 1000 + 5 });
    mockProvider({ refresh: () => Response.json({ error: 'invalid_grant' }, { status: 400 }) });
    expect((await call(`${BASE}/whoami`, { headers: { Cookie: `__Host-session_id=${id}` } })).status).toBe(401);
  });
});

describe('the backend behind /api/bancontact', () => {
  it('only the payment and ledger paths the screens use are forwarded', async () => {
    const cookie = `__Host-session_id=${await storeSession()}`;
    for (const path of ['/payments', '/transactions', '/sumup/charge', '/sumup/confirm', '/sumup/readers', '/sumup/readers/rdr_1', '/sumup/status/abc123']) {
      const res = await call(`${BASE}/api/bancontact${path}`, { headers: { Cookie: cookie } });
      expect(((await res.json()) as { path: string }).path, path).toBe(path);
    }
    for (const path of ['/identity-provider/resolve', '/internal/demo-orgs', '/organizations/x/members', '/sumup/status/a/b', '/sumup/readers/a/b', '']) {
      expect((await call(`${BASE}/api/bancontact${path}`, { headers: { Cookie: cookie } })).status, path || '(bare)').toBe(404);
    }
  });
});

describe('arcanum-devicehub behind /api/devices', () => {
  it("only a device's own notification token is forwarded; the registry goes through the backend", async () => {
    const cookie = `__Host-session_id=${await storeSession()}`;
    const token = await call(`${BASE}/api/devices/ws-token?terminal_id=t1`, { headers: { Cookie: cookie } });
    expect(token.status).not.toBe(404);
    for (const path of ['/register', '/by-org/org-1', '/remove', '/link', '/unlink', '/reset', '/unlinked?role=cfd&org_id=o', '/t1', '/t1/linked?role=cfd', '']) {
      const res = await call(`${BASE}/api/devices${path}`, { method: path === '/register' || path === '/remove' ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: BASE } });
      expect(res.status, path || '(bare)').toBe(404);
    }
  });
});

describe('the former SumUp simulator page', () => {
  it('sends a browser that still opens it back to the chooser', async () => {
    const cookie = `__Host-session_id=${await storeSession()}`;
    const res = await call(`${BASE}/simulator.html`, { headers: { Cookie: cookie, Accept: 'text/html' }, redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`${BASE}/`);
  });
});

describe('security headers', () => {
  it('on pages and API answers: no framing, nosniff, a referrer policy, HSTS', async () => {
    for (const res of [await call(`${BASE}/console`, { headers: { Accept: 'text/html' } }), await call(`${BASE}/health`), await call(`${BASE}/api/organizations/x`)]) {
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
      expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
    }
  });
});

describe('logout', () => {
  it("a link on another site doesn't sign anyone out; our own pages do", async () => {
    mockProvider();
    const id = await storeSession();
    const cross = await call(`${BASE}/logout`, { headers: { Cookie: `__Host-session_id=${id}`, 'Sec-Fetch-Site': 'cross-site' } });
    expect(cross.headers.get('Location')).toBe(BASE);
    expect(await env.ARCANUM_SESSIONS.get(id)).not.toBeNull();
    const own = await call(`${BASE}/logout`, { headers: { Cookie: `__Host-session_id=${id}`, 'Sec-Fetch-Site': 'same-origin' } });
    expect(own.status).toBe(302);
    expect(await env.ARCANUM_SESSIONS.get(id)).toBeNull();
    expect(own.headers.getSetCookie().filter((c) => /Max-Age=0/.test(c)).map((c) => c.split('=')[0]).sort()).toEqual(['__Host-session_id', 'session_id']);
  });
});

describe('writes only from this very site (same-site CSRF)', () => {
  const post = (path: string, headers: Record<string, string>, url = BASE) =>
    call(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'text/plain', ...headers }, body: '{"name":"x"}' });

  it('refuses a write from a sibling subdomain (same site, other origin) — to the API and to the installer', async () => {
    const cookie = `__Host-session_id=${await storeSession()}`;
    for (const headers of [{ Origin: 'https://www.arcanum.test' }, { 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Site': 'cross-site' }] as Record<string, string>[]) {
      expect((await post('/api/organizations/org-1/members', { Cookie: cookie, ...headers })).status, JSON.stringify(headers)).toBe(403);
      expect((await post('/installer/api/step', { Cookie: cookie, ...headers })).status, JSON.stringify(headers)).toBe(403);
    }
  });

  it('lets this site write — on FRONTEND_URL or the address the browser is on (workers.dev) — and reads from anywhere', async () => {
    const cookie = `__Host-session_id=${await storeSession()}`;
    const own = await post('/api/organizations/org-1/members', { Cookie: cookie, Origin: BASE, 'Sec-Fetch-Site': 'same-origin' });
    expect(((await own.json()) as { path: string }).path).toBe('/organizations/org-1/members');
    const workersDev = 'https://arcanum-bff.someone.workers.dev';
    expect((await post('/api/organizations/org-1/members', { Cookie: cookie, Origin: workersDev }, workersDev)).status).not.toBe(403);
    // No Origin, no Sec-Fetch-Site: not a browser — no CSRF to stop.
    expect((await post('/api/organizations/org-1/members', { Cookie: cookie })).status).not.toBe(403);
    // A read from elsewhere is no change (and the cookie isn't sent cross-site anyway).
    expect((await call(`${BASE}/api/organizations/memberships`, { headers: { Cookie: cookie, Origin: 'https://www.arcanum.test' } })).status).not.toBe(403);
  });

  it("the payment providers' callbacks (server to server) aren't affected", async () => {
    const res = await post('/api/callback/bancontact', { Origin: 'https://provider.example' });
    expect(((await res.json()) as { path: string }).path).toBe('/callback/bancontact');
  });
});

describe('no credentials to the Workers behind that do without', () => {
  it('the API: identity headers only — no session cookie, no access token, nothing a client put in Authorization', async () => {
    const cookie = `__Host-session_id=${await storeSession({ access_token: 'secret-access-token' })}`;
    const res = await call(`${BASE}/api/organizations/memberships`, { headers: { Cookie: cookie, Authorization: 'Bearer i-am-the-internal-key' } });
    const echo = (await res.json()) as { headers: Record<string, string> };
    expect(echo.headers.authorization).toBeUndefined();
    expect(echo.headers.cookie).toBeUndefined();
    expect(echo.headers['x-user-sub']).toBe('u9');
  });

  it('the screens and the notification socket get no cookie either', async () => {
    const cookie = `__Host-session_id=${await storeSession()}`;
    const frontends = vi.spyOn(env.ARCANUM_FRONTENDS_SERVICE!, 'fetch');
    await call(`${BASE}/console`, { headers: { Cookie: cookie, Accept: 'text/html' } });
    const sent = new Headers(((frontends.mock.calls[0] as unknown[])[1] as RequestInit).headers);
    expect(sent.get('cookie')).toBeNull();
    const devicehub = vi.spyOn(env.ARCANUM_DEVICEHUB_SERVICE, 'fetch').mockResolvedValue(new Response('ok'));
    await call(`${BASE}/devices/connect?token=t`, { headers: { Cookie: cookie } });
    expect((devicehub.mock.calls[0][0] as Request).headers.get('cookie')).toBeNull();
  });
});

describe('a refused sign-in', () => {
  it('tells the browser nothing about why (that goes to the log)', async () => {
    const res = await call(`${BASE}/callback?code=c&state=forged`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Aanmelden is mislukt. Probeer opnieuw.' });
  });
});
