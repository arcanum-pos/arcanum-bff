// Self-ordering guests (DOMAIN_MODEL.md "Self-ordering and station
// screens"): their pages, their API and their follow socket work without a
// session — and nothing else opens up with them.
import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

const BASE = 'https://arcanum.test';

function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  return worker.fetch(new Request(`${BASE}${path}`, { redirect: 'manual', ...init }), env, ctx);
}

describe('self-ordering without a session', () => {
  it('serves the guest pages (/bestel/…, /volg/…) — not the login prompt', async () => {
    for (const path of ['/bestel/abcdefghijklmnopqrstuvwxyz012345', '/volg/abcdefghijklmnopqrstuvwx']) {
      const res = await call(path, { headers: { Accept: 'text/html' } });
      expect(res.status, path).toBe(200);
      expect(await res.text()).toBe('<html>frontends /selforder.html</html>');
    }
  });

  it('forwards the public API to the backend, with no identity — even one a client made up', async () => {
    const res = await call('/api/public/self-order/the-code', { headers: { 'X-User-Sub': 'forged', 'X-User-Issuer': 'https://evil.test' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; headers: Record<string, string> };
    expect(body.path).toBe('/public/self-order/the-code');
    expect(body.headers['x-user-sub']).toBeUndefined();
    expect(body.headers['x-user-issuer']).toBeUndefined();
    expect(((await (await call('/api/public/orders/a-token')).json()) as { path: string }).path).toBe('/public/orders/a-token');
    const placed = await call('/api/public/self-order/the-code/orders', { method: 'POST', headers: { Origin: BASE, 'Content-Type': 'application/json' }, body: '{}' });
    expect(((await placed.json()) as { path: string }).path).toBe('/public/self-order/the-code/orders');
  });

  it('only those public routes: anything else under /api/public is unknown, and orders only from this site', async () => {
    expect((await call('/api/public/organizations')).status).toBe(404);
    expect((await call('/api/public/self-order/x/y/z')).status).toBe(404);
    expect((await call('/api/public/self-order/the-code/orders', { method: 'POST', headers: { Origin: 'https://evil.test' }, body: '{}' })).status).toBe(403);
    // The signed-in API stays signed-in.
    expect((await call('/api/organizations/x/tabs')).status).toBe(401);
  });

  it("forwards a follow page's socket to devicehub's order hub, without cookies", async () => {
    const seen: Request[] = [];
    const spy = vi.spyOn(env.ARCANUM_DEVICEHUB_SERVICE, 'fetch').mockImplementation(async (input: any, init?: any) => {
      seen.push(new Request(input, init));
      return new Response('ok');
    });
    await call('/orders/connect?ticket=abc.def', { headers: { Cookie: 'arcanum_session=x' } });
    spy.mockRestore();
    expect(new URL(seen[0].url).pathname + new URL(seen[0].url).search).toBe('/orders/connect?ticket=abc.def');
    expect(seen[0].headers.get('Cookie')).toBeNull();
  });
});
