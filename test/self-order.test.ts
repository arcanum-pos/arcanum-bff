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
    for (const path of ['/bestel/abcdefghijklmnopqrstuvwxyz012345', '/volg/abcdefghijklmnopqrstuvwx', '/tafel/abcdefghjkmnpqrstuvw']) {
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
    // A table's QR (release C).
    expect(((await (await call('/api/public/tables/a-token')).json()) as { path: string }).path).toBe('/public/tables/a-token');
    const placed = await call('/api/public/self-order/the-code/orders', { method: 'POST', headers: { Origin: BASE, 'Content-Type': 'application/json' }, body: '{}' });
    expect(((await placed.json()) as { path: string }).path).toBe('/public/self-order/the-code/orders');
    const pay = await call('/api/public/orders/a-token/bancontact', { method: 'POST', headers: { Origin: BASE } });
    expect(((await pay.json()) as { path: string }).path).toBe('/public/orders/a-token/bancontact');
    const round = await call('/api/public/orders/a-token/orders', { method: 'POST', headers: { Origin: BASE }, body: '{}' });
    expect(((await round.json()) as { path: string }).path).toBe('/public/orders/a-token/orders');
    // A number for the "ready" SMS, and taking it back.
    const notify = await call('/api/public/orders/a-token/notify', { method: 'POST', headers: { Origin: BASE }, body: '{}' });
    expect(((await notify.json()) as { path: string }).path).toBe('/public/orders/a-token/notify');
    const unnotify = await call('/api/public/orders/a-token/notify', { method: 'DELETE', headers: { Origin: BASE } });
    expect(((await unnotify.json()) as { path: string; method?: string }).path).toBe('/public/orders/a-token/notify');
    // A browser for "ready" notifications (Web Push, release G').
    const push = await call('/api/public/orders/a-token/push', { method: 'POST', headers: { Origin: BASE }, body: '{}' });
    expect(((await push.json()) as { path: string }).path).toBe('/public/orders/a-token/push');
  });

  it("Web Push: the follow page's service worker, and a manifest that opens that order (iPhone home screen)", async () => {
    const sw = await call('/push-sw.js');
    expect(sw.status).toBe(200);
    expect(await sw.text()).toContain('/push-sw.js');
    const res = await call('/volg/abcdefghijklmnopqrstuvwx/manifest.webmanifest');
    expect(res.headers.get('Content-Type')).toBe('application/manifest+json');
    const manifest = (await res.json()) as { icons: { src: string }[] };
    expect(manifest).toMatchObject({ start_url: '/volg/abcdefghijklmnopqrstuvwx', scope: '/volg/abcdefghijklmnopqrstuvwx', display: 'standalone' });
    expect(manifest.icons.map((i) => i.src)).toContain('/icons/selforder-512.png');
    expect((await call('/volg/short/manifest.webmanifest', { headers: { Accept: 'text/html' } })).headers.get('Content-Type')).not.toBe('application/manifest+json');
  });

  it("a kassa's Tap to Pay phone: its page and manifest, and a payment's QR link — public; nothing more", async () => {
    const page = await call('/tap', { headers: { Accept: 'text/html' } });
    expect(page.status).toBe(200);
    expect(await page.text()).toBe('<html>frontends /tap.html</html>');
    const manifest = (await (await call('/tap/manifest.webmanifest')).json()) as { icons: { src: string }[] };
    expect(manifest).toMatchObject({ start_url: '/tap', scope: '/tap', display: 'standalone', name: 'Tap to Pay' });
    expect(manifest.icons.map((i) => i.src)).toContain('/icons/tap-192.png');
    const charge = await call('/api/public/tap/charge-1/token-1', { headers: { 'X-User-Sub': 'forged' } });
    expect(((await charge.json()) as { path: string }).path).toBe('/public/tap/charge-1/token-1');
    const back = await call('/api/public/tap/charge-1/token-1/return', { method: 'POST', headers: { Origin: BASE }, body: '{}' });
    expect(((await back.json()) as { path: string }).path).toBe('/public/tap/charge-1/token-1/return');
    expect((await call('/api/public/tap/charge-1')).status).toBe(404);
    expect((await call('/api/public/tap/a/b/c')).status).toBe(404);
  });

  it('only those public routes: anything else under /api/public is unknown, and orders only from this site', async () => {
    expect((await call('/api/public/organizations')).status).toBe(404);
    expect((await call('/api/public/self-order/x/y/z')).status).toBe(404);
    expect((await call('/api/public/tables/x/seat')).status).toBe(404);
    // The waiter screen is for the signed-in.
    expect((await call('/bediening', { headers: { Accept: 'text/html' } })).status).toBe(401);
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

describe('app icons', () => {
  it("every screen's icons and manifests, without a session (a browser fetches a manifest without cookies)", async () => {
    for (const path of ['/icons/kassa-180.png', '/icons/kassa.webmanifest', '/icons/arcanum-96.png']) {
      const res = await call(path);
      expect(res.status, path).toBe(200);
      expect(await res.text()).toBe(`<html>frontends ${path}</html>`);
    }
  });
});
