// A paired station screen or customer display (arcanum-backend
// device-keys.ts): paired with its code alone, its key kept as an HttpOnly
// cookie — never in what the page's scripts see — and passed on as
// X-Device-Key only where a route allows it, never next to a session and
// never as a client sent it.
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { CloudflareKVSessionStore } from '../src/adapters/kv_session_store';

const BASE = 'https://arcanum.test';
const KEY = 'k'.repeat(43);
const COOKIE = `__Host-arcanum_device=${KEY}`;

function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  return worker.fetch(new Request(`${BASE}${path}`, { redirect: 'manual', ...init }), env, ctx);
}
const echoed = async (res: Response) => (await res.json()) as { path: string; search: string; headers: Record<string, string> };

afterEach(() => vi.restoreAllMocks());

describe('pairing with the code alone', () => {
  it('serves /pair without a session', async () => {
    const res = await call('/pair?code=ABCD-EFGH', { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>frontends /pair.html</html>');
  });

  it("turns the device's key into an HttpOnly cookie — and takes it out of the answer", async () => {
    const seen: Request[] = [];
    vi.spyOn(env.ARCANUM_BACKEND_SERVICE, 'fetch').mockImplementation(async (input: any, init?: any) => {
      seen.push(new Request(input, init));
      return Response.json({ terminalId: 't1', role: 'station', orgId: 'o1', deviceKey: KEY }, { status: 201 });
    });
    const res = await call('/api/public/pair', { method: 'POST', headers: { Origin: BASE, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'ABCD-EFGH' }) });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ terminalId: 't1', role: 'station', orgId: 'o1' });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('__Host-arcanum_device='))!;
    expect(cookie).toContain(`__Host-arcanum_device=${KEY}`);
    for (const part of ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Secure', 'Max-Age=315360000']) expect(cookie).toContain(part);
    expect(new URL(seen[0].url).pathname).toBe('/public/pair');
    // Pairing only from this site.
    expect((await call('/api/public/pair', { method: 'POST', headers: { Origin: 'https://evil.test' }, body: '{}' })).status).toBe(403);
  });

  it('a refused code: no cookie', async () => {
    vi.spyOn(env.ARCANUM_BACKEND_SERVICE, 'fetch').mockResolvedValue(Response.json({ code: 'pairing_needs_login' }, { status: 401 }));
    const res = await call('/api/public/pair', { method: 'POST', headers: { Origin: BASE }, body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

describe('a paired device afterwards', () => {
  it("passes its key on to the backend's API (which decides what it may reach)", async () => {
    const res = await call('/api/organizations/o1/stations/s1/tickets', { headers: { Cookie: COOKIE } });
    const body = await echoed(res);
    expect(body.path).toBe('/organizations/o1/stations/s1/tickets');
    expect(body.headers['x-device-key']).toBe(KEY);
    expect(body.headers['x-user-sub']).toBeUndefined();
    expect(body.headers.cookie).toBeUndefined();
    // The customer display's payment status too.
    expect((await echoed(await call('/api/bancontact/sumup/status/c1', { headers: { Cookie: COOKIE } }))).headers['x-device-key']).toBe(KEY);
  });

  it("its notification token: asked of the backend with its key (devicehub doesn't know keys)", async () => {
    const body = await echoed(await call('/api/devices/ws-token?terminal_id=t1', { headers: { Cookie: COOKIE } }));
    expect(body.path).toBe('/organizations/device-ws-token');
    expect(body.search).toBe('?terminal_id=t1');
    expect(body.headers['x-device-key']).toBe(KEY);
  });

  it('opens its own page and the start page — not the console', async () => {
    for (const path of ['/station.html', '/display.html', '/']) {
      const res = await call(path, { headers: { Cookie: COOKIE, Accept: 'text/html' } });
      expect(res.status, path).toBe(200);
    }
    const console = await call('/console', { headers: { Cookie: COOKIE, Accept: 'text/html' } });
    expect(console.status).toBe(401);
    expect(await console.text()).toBe('<html>frontends /login-prompt.html</html>');
    // Nor a kassa page.
    expect((await call('/kassa.html', { headers: { Cookie: COOKIE, Accept: 'text/html' } })).status).toBe(401);
  });

  it("a key a client made up in a header counts for nothing; a person's session never carries one", async () => {
    // A header, no cookie: not signed in.
    expect((await call('/api/organizations/o1/stations/s1/tickets', { headers: { 'X-Device-Key': KEY } })).status).toBe(401);
    // A cookie and a forged header: the cookie's key, the header dropped.
    const forged = await echoed(await call('/api/organizations/o1/stations/s1/tickets', { headers: { Cookie: COOKIE, 'X-Device-Key': 'f'.repeat(43) } }));
    expect(forged.headers['x-device-key']).toBe(KEY);
    // A person signed in on the same browser: their session, no device key.
    const id = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
    await new CloudflareKVSessionStore(env.ARCANUM_SESSIONS, env).set(id, {
      access_token: 'opaque',
      id_token: 'x.eyJzdWIiOiJ1MSJ9.sig',
      refresh_token: null,
      email: 'ann@example.test',
      name: 'Ann',
      expires_at: Date.now() / 1000 + 3600,
      issuer: 'https://login.test',
      authPurpose: 'authcode',
    } as any);
    const person = await echoed(await call('/api/organizations/o1/stations/s1/tickets', { headers: { Cookie: `__Host-session_id=${id}; ${COOKIE}` } }));
    expect(person.headers['x-device-key']).toBeUndefined();
    expect(person.headers['x-user-sub']).toBe('u1');
  });

  it('only where a route allows it: the installer stays closed', async () => {
    const res = await call('/installer/api/status', { headers: { Cookie: COOKIE } });
    expect(res.status).toBe(401);
  });
});
