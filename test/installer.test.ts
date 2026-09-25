// /installer/* — arcanum-installer behind this BFF (src/bff/installer.ts).
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import type { SessionData } from '../src/types';

const BASE = 'https://arcanum.test';

function fakeJwt(payload: Record<string, unknown>): string {
  const part = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${part({ alg: 'none' })}.${part(payload)}.sig`;
}

// A signed-in browser: a session in KV exactly as /callback stores it.
async function signIn(): Promise<string> {
  const id = crypto.randomUUID().replace(/-/g, '');
  const session: SessionData = {
    access_token: 'opaque-access-token',
    id_token: fakeJwt({ sub: 'google-123', email: 'admin@example.test', name: 'Admin' }),
    refresh_token: null,
    email: 'admin@example.test',
    name: 'Admin',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    orgId: 'default',
    issuer: 'https://accounts.google.com',
    authPurpose: 'authcode',
  };
  await env.ARCANUM_SESSIONS.put(id, JSON.stringify(session));
  return `session_id=${id}`;
}

interface Echo {
  path: string;
  search: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

// The worker with a changed env — for installations without the installer.
async function fetchWith(overrides: Partial<Cloudflare.Env>, path: string, init?: RequestInit): Promise<Response> {
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  return worker.fetch(new Request(`${BASE}${path}`, init), { ...env, ...overrides }, ctx);
}

describe('without the installer (the shared platform)', () => {
  for (const [what, overrides] of [
    ['no binding', { ARCANUM_INSTALLER_SERVICE: undefined }],
    ['no key', { INSTALLER_INTERNAL_KEY: undefined }],
    ['an empty key', { INSTALLER_INTERNAL_KEY: '' }],
  ] as const) {
    it(`${what}: /installer does not exist`, async () => {
      const cookie = await signIn();
      for (const path of ['/installer', '/installer/', '/installer/api/status']) {
        const res = await fetchWith(overrides, path, { headers: { Cookie: cookie, Accept: 'text/html' } });
        expect(res.status, path).toBe(404);
      }
      const version = (await (await fetchWith(overrides, '/version')).json()) as { installer: boolean };
      expect(version.installer).toBe(false);
    });
  }
});

describe('with the installer', () => {
  it('/version says so', async () => {
    const version = (await (await SELF.fetch(`${BASE}/version`)).json()) as { installer: boolean; source_url: string };
    expect(version.installer).toBe(true);
    expect(version.source_url).toBe('https://github.com/arcanum-pos');
  });

  it('/installer redirects to /installer/ (keeping the query)', async () => {
    const res = await SELF.fetch(`${BASE}/installer?x=1`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`${BASE}/installer/?x=1`);
  });

  it('signed out: the page gets the login prompt, served at its own path', async () => {
    const res = await SELF.fetch(`${BASE}/installer/`, { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(401);
    // login-prompt.html reads its returnTo off the URL — /installer/ here.
    expect(await res.text()).toBe('<html>frontends /login-prompt.html</html>');
  });

  it('signed out: API calls get a 401, nothing is forwarded', async () => {
    const res = await SELF.fetch(`${BASE}/installer/api/status`, { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(res.headers.get('X-Installer')).toBeNull();
  });

  it('signed in: forwards the page with the prefix stripped', async () => {
    const res = await SELF.fetch(`${BASE}/installer/`, { headers: { Cookie: await signIn(), Accept: 'text/html' } });
    expect(res.status).toBe(299);
    const echo = (await res.json()) as Echo;
    expect(echo.path).toBe('/');
    expect(echo.method).toBe('GET');
  });

  it('signed in: forwards API calls with method, query, body and identity', async () => {
    const res = await SELF.fetch(`${BASE}/installer/api/steps/verify?x=1`, {
      method: 'POST',
      headers: { Cookie: await signIn(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ go: true }),
    });
    const echo = (await res.json()) as Echo;
    expect(echo).toMatchObject({ path: '/api/steps/verify', search: '?x=1', method: 'POST', body: '{"go":true}' });
    expect(echo.headers['x-installer-key']).toBe('test-installer-key');
    expect(echo.headers['x-user-email']).toBe('admin@example.test');
    expect(echo.headers['x-user-sub']).toBe('google-123');
    expect(echo.headers['x-user-issuer']).toBe('https://accounts.google.com');
    expect(echo.headers['x-user-name']).toBe('Admin');
    // The session cookie stays with the BFF.
    expect(echo.headers.cookie).toBeUndefined();
  });

  it('drops a client-supplied key and identity', async () => {
    const res = await SELF.fetch(`${BASE}/installer/api/status`, {
      headers: {
        Cookie: await signIn(),
        'X-Installer-Key': 'forged',
        'X-User-Email': 'boss@evil.test',
        'X-User-Sub': 'forged-sub',
        'X-User-Roles': 'admin',
      },
    });
    const echo = (await res.json()) as Echo;
    expect(echo.headers['x-installer-key']).toBe('test-installer-key');
    expect(echo.headers['x-user-email']).toBe('admin@example.test');
    expect(echo.headers['x-user-sub']).toBe('google-123');
    expect(echo.headers['x-user-roles']).toBeUndefined();
  });

  it('passes the installer response through unchanged', async () => {
    const res = await SELF.fetch(`${BASE}/installer/api/status`, { headers: { Cookie: await signIn() } });
    expect(res.status).toBe(299);
    expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'");
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(res.headers.get('X-Installer')).toBe('echo');
  });

  it("forwards installer paths that end in a file extension (step ids like assets:…-01.json) — the scanner filter doesn't apply", async () => {
    const res = await SELF.fetch(`${BASE}/installer/api/steps/assets%3Aarcanum-frontends-assets-01.json`, {
      method: 'POST',
      headers: { Cookie: await signIn(), 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(299);
    expect(((await res.json()) as Echo).path).toBe('/api/steps/assets%3Aarcanum-frontends-assets-01.json');
    // Signed out it's still a 401, not forwarded; elsewhere the filter still holds.
    expect((await SELF.fetch(`${BASE}/installer/api/steps/x.json`, { method: 'POST' })).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/wp-config.json`)).status).toBe(404);
  });

  it('/installerx is not the installer', async () => {
    const res = await SELF.fetch(`${BASE}/installerx`, { headers: { Cookie: await signIn() } });
    expect(res.headers.get('X-Installer')).toBeNull();
  });
});

describe('existing routes', () => {
  it('/health', async () => {
    const res = await SELF.fetch(`${BASE}/health`);
    expect(await res.json()).toEqual({ status: 'healthy' });
  });

  it('the console still goes to arcanum-frontends', async () => {
    const res = await SELF.fetch(`${BASE}/console`, { headers: { Cookie: await signIn() } });
    expect(await res.text()).toBe('<html>frontends /console</html>');
  });
});
