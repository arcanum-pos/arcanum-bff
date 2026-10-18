// Self-ordering guests (DOMAIN_MODEL.md "Self-ordering and station
// screens"): their pages, their API and their follow socket work without a
// session — and nothing else opens up with them.
import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import worker, { asConsole, asDevice } from '../src/index';

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
    expect(manifest).toMatchObject({ start_url: '/volg/abcdefghijklmnopqrstuvwx', scope: '/', display: 'standalone' });
    expect(manifest.icons.map((i) => i.src)).toContain('/icons/selforder-512.png');
    // The organisation's own icon, when the page knows it.
    const own = (await (await call('/volg/abcdefghijklmnopqrstuvwx/manifest.webmanifest?icon=org-1/selforder')).json()) as { icons: { src: string }[] };
    expect(own.icons[0].src).toBe('/icons/org/org-1/selforder-192.png');
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
  // The head of arcanum-frontends' pair.html, as built.
  const PAIR_HTML = `<!doctype html><html lang="nl"><head><meta charset="UTF-8" />
    <link rel="icon" type="image/png" sizes="96x96" href="/icons/arcanum-96.png" />
    <link rel="apple-touch-icon" href="/icons/arcanum-180.png" />
    <link rel="manifest" href="/icons/arcanum.webmanifest" />
    <meta name="apple-mobile-web-app-title" content="Arcanum" />
    <title>Toestel koppelen</title></head><body></body></html>`;
  const page = () => new Response(PAIR_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(PAIR_HTML.length) } });

  it("a pairing link's page comes with that device's icon, name and manifest in its HTML (Safari's Add to Dock reads only that)", async () => {
    const res = await asDevice(page(), new URLSearchParams({ code: 'K7PM4XQ2', role: 'pos', name: 'Kassa "1" <b>' }));
    const html = await res.text();
    expect(html).toContain('<link rel="icon" type="image/png" sizes="96x96" href="/icons/kassa-96.png" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="/icons/kassa-180.png" />');
    expect(html).toContain('<link rel="manifest" href="/pair/manifest.webmanifest?role=pos&amp;name=Kassa+%221%22+%3Cb%3E" />');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Kassa &quot;1&quot; &lt;b&gt;" />');
    expect(html).toContain('<title>Kassa &quot;1&quot; &lt;b&gt;</title>');
    expect(res.headers.get('Content-Length')).toBeNull();
    // No device in the link (typed, an older QR): the page as it is.
    expect(await (await asDevice(page(), new URLSearchParams({ code: 'K7PM4XQ2' }))).text()).toBe(PAIR_HTML);
    expect(await (await asDevice(page(), new URLSearchParams({ role: 'admin' }))).text()).toBe(PAIR_HTML);
  });

  it("an organisation's own icons: its own when it has one, else the default — without a session", async () => {
    const own = await call('/icons/org/org-own/kassa-180.png');
    expect(own.status).toBe(200);
    expect(await own.text()).toBe('own /public/icons/org-own/kassa/180');
    expect(own.headers.get('Cache-Control')).toBe('public, max-age=300');
    // None of its own: the default set's file (a prep station's: the station's).
    expect(await (await call('/icons/org/org-plain/display-512.png')).text()).toBe('<html>frontends /icons/display-512.png</html>');
    expect(await (await call('/icons/org/org-plain/station-st_1-96.png')).text()).toBe('<html>frontends /icons/station-96.png</html>');
    expect(await (await call('/icons/org/org-plain/pickup-192.png')).text()).toBe('<html>frontends /icons/station-192.png</html>');
    // Not a page that takes an icon, or a size that isn't made.
    expect((await call('/icons/org/org-own/start-180.png')).status).toBe(404);
    expect((await call('/icons/org/org-own/kassa-64.png')).status).toBe(404);
    const manifest = (await (await call('/icons/org/org-own/station-st_1.webmanifest?name=Keuken')).json()) as { name: string; scope: string; start_url?: string; icons: { src: string; purpose: string }[] };
    expect(manifest).toMatchObject({ name: 'Keuken', scope: '/', display: 'standalone' });
    expect(manifest.start_url).toBeUndefined();
    expect(manifest.icons).toEqual([
      { src: '/icons/org/org-own/station-st_1-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/org/org-own/station-st_1-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ]);
    expect(((await (await call('/icons/org/org-own/waiter.webmanifest')).json()) as { name: string }).name).toBe('Bediening');
  });

  it("a pairing link with the org's icon (`icon=<org>/<slot>`): the page is sent with that organisation's icons", async () => {
    const html = await (await asDevice(page(), new URLSearchParams({ code: 'K7PM4XQ2', role: 'station', name: 'Keuken', icon: 'org-1/station-st_1' }))).text();
    expect(html).toContain('href="/icons/org/org-1/station-st_1-96.png"');
    expect(html).toContain('<link rel="apple-touch-icon" href="/icons/org/org-1/station-st_1-180.png" />');
    expect(html).toContain('<link rel="manifest" href="/icons/org/org-1/station-st_1.webmanifest?name=Keuken" />');
    // A made-up one: the default set.
    expect(await (await asDevice(page(), new URLSearchParams({ role: 'station', name: 'Keuken', icon: 'org-1/../x' }))).text()).toContain('href="/icons/station-180.png"');
  });

  it("a Tap to Pay phone's link with the org's icon: its page and manifest", async () => {
    const manifest = (await (await call('/tap/manifest.webmanifest?icon=org-1/tap')).json()) as { start_url: string; icons: { src: string }[] };
    expect(manifest.start_url).toBe('/tap');
    expect(manifest.icons[0].src).toBe('/icons/org/org-1/tap-192.png');
  });

  it("the console is sent with the icon of the organisation its cookie names; no cookie, or a made-up one: as it is", async () => {
    const withCookie = (cookie: string) => new Request('https://arcanum.test/console', { headers: { Cookie: cookie } });
    const html = await (await asConsole(page(), withCookie('session=x; arcanum-console-org=org-1'))).text();
    expect(html).toContain('<link rel="apple-touch-icon" href="/icons/org/org-1/console-180.png" />');
    expect(html).toContain('<link rel="manifest" href="/icons/org/org-1/console.webmanifest?name=Console" />');
    expect(await (await asConsole(page(), withCookie('session=x'))).text()).toBe(PAIR_HTML);
    expect(await (await asConsole(page(), withCookie('arcanum-console-org=../evil'))).text()).toBe(PAIR_HTML);
    // Its default when the org has none: the console's own set.
    expect(await (await call('/icons/org/org-plain/console-180.png')).text()).toBe('<html>frontends /icons/admin-180.png</html>');
  });

  it('/pair is served through it, without a session', async () => {
    const res = await call('/pair?code=K7PM4XQ2&role=pos&name=Kassa%201', { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>frontends /pair.html</html>');
  });

  it("a pairing link's manifest: that device's name and icon, without a session — the name only as data", async () => {
    const res = await call('/pair/manifest.webmanifest?role=pos&name=Kassa%201');
    expect(res.headers.get('Content-Type')).toBe('application/manifest+json');
    const manifest = (await res.json()) as { name: string; start_url?: string; scope: string; icons: { src: string }[] };
    expect(manifest).toMatchObject({ name: 'Kassa 1', short_name: 'Kassa 1', scope: '/', display: 'standalone' });
    expect(manifest.start_url).toBeUndefined();
    expect(manifest.icons.map((i) => i.src)).toContain('/icons/kassa-192.png');
    const odd = (await (await call(`/pair/manifest.webmanifest?role=nope&name=${encodeURIComponent('"}<x>'.padEnd(80, 'x'))}`)).json()) as { name: string; icons: { src: string }[] };
    expect(odd.name).toHaveLength(60);
    expect(odd.icons[0].src).toBe('/icons/arcanum-192.png');
    expect(((await (await call('/pair/manifest.webmanifest?role=station')).json()) as { name: string }).name).toBe('Station');
  });

  it("every screen's icons and manifests, without a session (a browser fetches a manifest without cookies)", async () => {
    for (const path of ['/icons/kassa-180.png', '/icons/kassa.webmanifest', '/icons/arcanum-96.png']) {
      const res = await call(path);
      expect(res.status, path).toBe(200);
      expect(await res.text()).toBe(`<html>frontends ${path}</html>`);
    }
  });
});
