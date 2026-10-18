import type { Env } from './types';
import { CloudflareKVSessionStore } from './adapters/kv_session_store';
import { AuthRoutesHandler } from './bff/authroutes';
import { DeviceRoutesHandler } from './bff/deviceroutes';
import { authresult } from './bff/authresult';
import { processWhoAmi } from './bff/whoami';
import { forwardToInstaller, installerAvailable, isInstallerPath } from './bff/installer';
import { Router, isKnownApiRoute, routeAllowsDevice, routeRequiresAuth } from './routes/router';
import { buildDeviceCookie, cookieValue, deviceKeyFrom, isDevelopment, LEGACY_SESSION_COOKIE, sessionCookieName } from './bff/cookie';

// See LICENSE (AGPL-3.0-or-later) and the /version route below.
const DEFAULT_SOURCE_URL = 'https://github.com/arcanum-pos';
import { UIFrontendProxy } from './services/uiProxy';
import { iconRef, orgIconRoute, orgIconUrl, orgManifestUrl, type IconRef } from './bff/org-icons';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let response: Response;
    try {
      response = await handle(request, env, ctx);
    } catch (err) {
      // Anything unexpected (the login provider unreachable, a backend error):
      // a plain 502 and a log line, not the runtime's own error page.
      console.error('Unexpected error', err);
      response = new Response('Er ging iets mis. Probeer het zo meteen opnieuw.', { status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    // A WebSocket upgrade (/devices/connect) is passed on untouched.
    if (response.status === 101 || response.webSocket) return response;
    return finish(request, env, response);
  },
};

// Security headers on everything this BFF answers (without overriding what
// an upstream set itself, like the installer's own CSP), and an old
// session_id cookie cleared where it's no longer the name (bff/cookie.ts).
function finish(request: Request, env: Env, upstream: Response): Response {
  const response = new Response(upstream.body, upstream);
  const h = response.headers;
  const setIfAbsent = (name: string, value: string) => {
    if (!h.has(name)) h.set(name, value);
  };
  setIfAbsent('X-Content-Type-Options', 'nosniff');
  setIfAbsent('Referrer-Policy', 'strict-origin-when-cross-origin');
  // No screen is ever meant to be shown inside another site's frame (clickjacking).
  setIfAbsent('X-Frame-Options', 'DENY');
  const csp = h.get('Content-Security-Policy');
  if (!csp) h.set('Content-Security-Policy', "frame-ancestors 'none'");
  else if (!/frame-ancestors/.test(csp)) h.set('Content-Security-Policy', `${csp}; frame-ancestors 'none'`);
  if (!isDevelopment(env)) setIfAbsent('Strict-Transport-Security', 'max-age=31536000');

  if (sessionCookieName(env) !== LEGACY_SESSION_COOKIE && cookieValue(request, LEGACY_SESSION_COOKIE) !== null && !(h.get('Set-Cookie') ?? '').startsWith(`${LEGACY_SESSION_COOKIE}=`)) {
    h.append('Set-Cookie', `${LEGACY_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`);
  }
  return response;
}

async function handle(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return corsResponse(new Response(null, { status: 204 }), request, env);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/health') {
      return corsResponse(jsonResponse({ status: 'healthy' }), request, env);
    }

    if (path === '/version') {
      return corsResponse(
        jsonResponse({
          version: env.CF_VERSION_METADATA?.id ?? 'local',
          git_commit: env.GIT_COMMIT_SHA,
          // The installed release, shown in the console footer; null = deployed from main.
          release: env.ARCANUM_VERSION || null,
          // Where this installation's users get its source code (AGPL-3.0 §13)
          // — the console/kassa "Broncode" links read it from here. An
          // installation running a modified version must point it at its own.
          source_url: env.SOURCE_URL || DEFAULT_SOURCE_URL,
          // Whether /installer is reachable — the console shows its link.
          installer: installerAvailable(env),
        }),
        request,
        env
      );
    }

    // Reject scanner probes before any session/auth work.
    // Paths with non-app file extensions (e.g. .php, .env, .asp) can never be valid routes here.
    // /installer/* is the exception: the installer's own paths, behind a login (its step ids end in .json).
    if (isScannedPath(path) && !isInstallerPath(path)) {
      return new Response(null, { status: 404 });
    }

    // Unknown /api/* paths are rejected before any auth work — route table is static and known.
    if (path.startsWith('/api') && !isKnownApiRoute(path)) {
      return corsResponse(jsonResponse({ error: 'Not found' }, 404), request, env);
    }

    // Changes only from this very site. SameSite=Lax still sends the session
    // cookie on requests from a sibling subdomain (same site, other origin —
    // www.<the same domain>, say); those must not drive the API or the
    // installer. The payment providers' callbacks (server to server) are no
    // browsers and carry no session.
    const writes = request.method !== 'GET' && request.method !== 'HEAD';
    if (writes && ((path.startsWith('/api') && !path.startsWith('/api/callback')) || isInstallerPath(path)) && !fromThisSite(request, env)) {
      return corsResponse(jsonResponse({ error: 'Not allowed from another site' }, 403), request, env);
    }

    // arcanum-installer behind this BFF (self-hosted installations only —
    // see bff/installer.ts). Without it, as if the route didn't exist. The
    // bare /installer redirects: the installer's page uses relative paths.
    if (isInstallerPath(path)) {
      if (!installerAvailable(env)) return new Response(null, { status: 404 });
      if (path === '/installer') return Response.redirect(new URL(`/installer/${url.search}`, url).toString(), 302);
    }

    const sessionStore = new CloudflareKVSessionStore(env.ARCANUM_SESSIONS, env);

    // Login against the instance's identity provider (one per installation,
    // for every org — hosting plan phase 6 removed the per-org variants
    // /:orgId/login, /:orgId/console and /:orgId/device). The provider always
    // sends the browser back to FRONTEND_URL/callback.
    if (path === '/login' || path === '/callback' || path === '/logout') {
      const authHandler = new AuthRoutesHandler(sessionStore, env);
      return authHandler.processAuthRoute(request);
    }

    // Device Authorization Grant: a kiosk device shows a QR/code, the user completes
    // login on their own phone, the kiosk polls until done. Public — no session/cookie
    // needed to start or poll, since the whole point is authenticating this device.
    if (path === '/device' || path.startsWith('/device/')) {
      const deviceHandler = new DeviceRoutesHandler(sessionStore, env);
      return deviceHandler.processDeviceRoute(request);
    }

    // The notification WebSocket — public/no-session by design (see
    // arcanum-devicehub's own comment on WS_TOKEN_SECRET: the channel only
    // ever relays an event name + id, never real data, and the connect step
    // itself verifies a short-lived signed token minted by the
    // session-checked /api/devices/ws-token). Used to live on
    // arcanum-devicehub's own public custom domain — moved here so a kiosk
    // talks to the one address it's on (the instance's custom domain or its
    // workers.dev address) for everything, not a separate hostname.
    // devicehub's own connect handler does the token verification and DO
    // upgrade; this is a pure byte-forwarding hop, not a proxy that needs to
    // understand the protocol.
    // Self-ordering guests' pages — public by design (a guest has no
    // account): /bestel/<event code> (menu → cart → pay → confirmation) and
    // /volg/<order token> (follow an order). arcanum-frontends' selforder.html.
    // /tafel/<QR token>: a table's QR code (release C) — a guest orders on
    // the table's tab, a signed-in waiter is sent on to /bediening.
    // Web Push (release G'): a follow page added to an iPhone's home screen
    // opens that order — its own manifest, made here (nothing secret: the
    // token is in the address already). iOS only allows Web Push from there.
    const manifestMatch = path.match(/^\/volg\/([A-Za-z0-9_-]{20,64})\/manifest\.webmanifest$/);
    // `icon=<org>/selforder`: the organisation's own icon (bff/org-icons.ts).
    if (manifestMatch) return orderManifest(manifestMatch[1], iconRef(url.searchParams.get('icon')));
    // A kassa's Tap to Pay phone (and the kassa's QR for a payment): public —
    // the page holds no data; the phone's calls carry its key, the QR's its
    // payment's own token. Paired from the page itself: on an iPhone, the
    // home-screen app keeps its own cookies, apart from Safari's.
    // The console's link carries the org's icon (`icon=<org>/tap`): the page and its manifest have it.
    if (path === '/tap/manifest.webmanifest') return appManifest('/tap', 'Tap to Pay', 'tap', '/tap', iconRef(url.searchParams.get('icon')));
    if (path === '/tap') {
      const tapProxy = new UIFrontendProxy(env, { service: env.ARCANUM_FRONTENDS_SERVICE, localUrl: env.CONSOLE_LOCAL_URL, fallbackFile: '/tap.html' });
      const ref = iconRef(url.searchParams.get('icon'));
      const page = await tapProxy.handleRequest(request, '/tap.html');
      return ref ? withHead(page, { icon96: orgIconUrl(ref, 96), icon180: orgIconUrl(ref, 180), manifest: `/tap/manifest.webmanifest?${new URLSearchParams({ icon: `${ref.org}/${ref.slot}` })}` }) : page;
    }
    // The follow page's service worker (shows the notification): public,
    // from arcanum-frontends' public/.
    if (path === '/push-sw.js') {
      const swProxy = new UIFrontendProxy(env, { service: env.ARCANUM_FRONTENDS_SERVICE, localUrl: env.CONSOLE_LOCAL_URL, fallbackFile: '/push-sw.js' });
      return swProxy.handleRequest(request, '/push-sw.js');
    }
    if (path.startsWith('/bestel/') || path.startsWith('/volg/') || path.startsWith('/tafel/')) {
      const selfOrderProxy = new UIFrontendProxy(env, {
        service: env.ARCANUM_FRONTENDS_SERVICE,
        localUrl: env.CONSOLE_LOCAL_URL,
        fallbackFile: '/selforder.html',
      });
      return selfOrderProxy.handleRequest(request, '/selforder.html');
    }

    // Pairing a station screen or customer display with its code alone (no
    // account needed): arcanum-frontends' pair.html. A kassa's code sends
    // the person on to sign in first.
    // The console's pairing link carries the device (role, name): the page
    // comes with that device's icon, name and manifest in its HTML (Safari's
    // Add to Dock reads what was sent, not what a script changed), so an app
    // installed from it is that device.
    if (path === '/pair/manifest.webmanifest') return deviceManifest(url.searchParams);
    if (path === '/pair') {
      const pairProxy = new UIFrontendProxy(env, {
        service: env.ARCANUM_FRONTENDS_SERVICE,
        localUrl: env.CONSOLE_LOCAL_URL,
        fallbackFile: '/pair.html',
      });
      return asDevice(await pairProxy.handleRequest(request, '/pair.html'), url.searchParams);
    }

    // A follow page's live updates: arcanum-devicehub's order hub. Like
    // /devices/connect below, a pure forwarding hop — the socket's own
    // short-lived ticket (from /api/public/orders/<token>) does the work.
    if (path === '/devices/connect' || path === '/orders/connect') {
      const isDevelopment = env.FRONTEND_URL?.includes('localhost') || env.FRONTEND_URL?.includes('127.0.0.1');
      // The socket's own short-lived token does the work: no session cookie along.
      const forward = (target: string) => {
        const req = new Request(target, request);
        req.headers.delete('Cookie');
        req.headers.delete('Authorization');
        return req;
      };
      if (isDevelopment && env.DEVICEHUB_LOCAL_URL) {
        return fetch(forward(`${env.DEVICEHUB_LOCAL_URL}${path}${url.search}`));
      }
      return env.ARCANUM_DEVICEHUB_SERVICE.fetch(forward(`https://devicehub${path}${url.search}`));
    }

    // arcanum-frontends' shared Vite asset prefix — JS/CSS for every entry
    // it builds (admin, chooser, device, login-prompt), public by nature
    // (compiled client code, nothing sensitive). Has to be checked before
    // the auth gate below, not just alongside /console's own routing:
    // device.html and login-prompt.html are themselves served before/
    // without a session, so their own <script>/<link> tags need these to
    // load unauthenticated too.
    // The screens' app icons and manifests (arcanum-frontends' public/icons/):
    // public too — a browser fetches a manifest without cookies, and the
    // login prompt shows them before anyone signed in.
    // An organisation's own app icons (bff/org-icons.ts): its own, else the default.
    if (path.startsWith('/icons/org/')) {
      const iconsProxy = new UIFrontendProxy(env, { service: env.ARCANUM_FRONTENDS_SERVICE, localUrl: env.CONSOLE_LOCAL_URL, fallbackFile: '/icons/arcanum-192.png' });
      const icon = await orgIconRoute(path, url.searchParams, env, (file) => iconsProxy.handleRequest(new Request(new URL(file, url), { headers: request.headers }), file));
      return icon ?? new Response(null, { status: 404 });
    }
    if (path.startsWith('/assets/') || path.startsWith('/icons/')) {
      const assetsProxy = new UIFrontendProxy(env, {
        service: env.ARCANUM_FRONTENDS_SERVICE,
        localUrl: env.CONSOLE_LOCAL_URL,
        fallbackFile: '/admin.html',
      });
      return assetsProxy.handleRequest(request, path);
    }

    const auth = await authresult(request, env, sessionStore);
    // Nobody signed in, but a paired station screen or customer display: its key.
    const deviceKey = auth.authMethod === 'public' ? deviceKeyFrom(request, env) : null;
    if (deviceKey) auth.deviceKey = deviceKey;

    if (path === '/whoami') {
      const result = await processWhoAmi(request, auth, env);
      return corsResponse(jsonResponse(result.data, result.status), request, env);
    }

    // Signed in: forward. Not signed in: the page gets the same login prompt
    // as any other page (the public branch below), its API calls a 401.
    if (isInstallerPath(path)) {
      if (auth.authMethod !== 'public') return forwardToInstaller(request, env, auth);
      if (!request.headers.get('Accept')?.includes('text/html')) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }
    }

    if (path.startsWith('/api')) {
      // A paired device's notification token: the backend checks it's that
      // device's own key (devicehub doesn't know keys).
      if (path === '/api/devices/ws-token' && auth.authMethod === 'public' && deviceKey) {
        return corsResponse(await deviceWsToken(request, env, deviceKey), request, env);
      }
      if (auth.authMethod === 'public' && routeRequiresAuth(path) && !(deviceKey && routeAllowsDevice(path))) {
        return corsResponse(jsonResponse({ error: 'Unauthorized' }, 401), request, env);
      }
      const router = new Router(env, auth);
      const response = await router.dispatch(request);
      if (response && path === '/api/public/pair') return corsResponse(await keepDeviceKey(response, env), request, env);
      if (response) return corsResponse(response, request, env);
      return corsResponse(jsonResponse({ error: 'Not found' }, 404), request, env);
    }

    // All other paths → UI (gated behind auth) — a paired station screen or
    // customer display opens its own page (and the start page, which sends
    // it there) with its key: the pages hold no data, its API calls are checked.
    if (auth.authMethod === 'public' && !(deviceKey && DEVICE_PAGES.has(path))) {
      // Only show browsers a login prompt; scanners and API clients get 401.
      if (!request.headers.get('Accept')?.includes('text/html')) {
        return new Response(null, { status: 401 });
      }
      // Deliberately a link, not an automatic 302 to /login: that redirect used to
      // fire for every anonymous request to any page — including scanner/bot noise
      // that never even knew /login existed — and /login creates a KV-backed PKCE
      // session on every hit. That silently burned through the Workers KV free-tier
      // daily write quota. Requiring an actual click means only a real login attempt
      // costs a KV write.
      //
      // The prompt itself is arcanum-frontends' login-prompt.html (a real,
      // always-present built file — no fallback needed), read client-side
      // off window.location.pathname for its own returnTo, since it's
      // served at whatever path was originally requested.
      const promptProxy = new UIFrontendProxy(env, {
        service: env.ARCANUM_FRONTENDS_SERVICE,
        localUrl: env.CONSOLE_LOCAL_URL,
        fallbackFile: '/login-prompt.html',
      });
      const prompt = await promptProxy.handleRequest(request, '/login-prompt.html');
      return new Response(prompt.body, { status: 401, headers: prompt.headers });
    }

    // The admin portal (arcanum-frontends) lives at /console — arcanum-webapp's
    // old /admin.html and /admin-org.html pages it replaced are gone. Same
    // auth gate as any other UI path above, just a different backend.
    // (/assets/* — its Vite build output — is handled earlier, unauthenticated.)
    if (path === '/console' || path.startsWith('/console/')) {
      const consoleProxy = new UIFrontendProxy(env, {
        service: env.ARCANUM_FRONTENDS_SERVICE,
        localUrl: env.CONSOLE_LOCAL_URL,
        fallbackFile: '/admin.html',
      });
      return consoleProxy.handleRequest(request, path);
    }

    // Root "/" — the org + device-role chooser (arcanum-frontends'
    // chooser.html), authenticated at this point (the public branch above
    // already returned). Its own script checks localStorage first and
    // redirects straight to kassa/display.html if this browser is
    // already registered as a terminal.
    if (path === '/') {
      const chooserProxy = new UIFrontendProxy(env, {
        service: env.ARCANUM_FRONTENDS_SERVICE,
        localUrl: env.CONSOLE_LOCAL_URL,
        fallbackFile: '/chooser.html',
      });
      return chooserProxy.handleRequest(request, path);
    }

    // Everything arcanum-webapp used to serve has now moved here too —
    // display.html keeps its path exactly: kassa's "Klantscherm openen"
    // button opens /display.html?terminal=<id> directly. transactions.html
    // was dropped (not moved) — the admin portal's own Rapporten page
    // (routes/reports.tsx) already covers this, org-wide rather than
    // per-device/slot-scoped.
    // The SumUp simulator's page is gone (2026-10-06, SumUp's Virtual Solo
    // replaces it): a browser that still opens it goes back to the chooser,
    // which asks again what this device is.
    if (path === '/simulator.html') return Response.redirect(new URL('/', request.url).toString(), 302);

    // The waiter screen (release C): signed in, like any page above.
    if (path === '/bediening' || path === '/bediening/') {
      const waiterProxy = new UIFrontendProxy(env, {
        service: env.ARCANUM_FRONTENDS_SERVICE,
        localUrl: env.CONSOLE_LOCAL_URL,
        fallbackFile: '/waiter.html',
      });
      return waiterProxy.handleRequest(request, '/waiter.html');
    }

    if (path === '/display.html' || path === '/kassa.html' || path === '/settings.html' || path === '/station.html') {
      const movedScreenProxy = new UIFrontendProxy(env, {
        service: env.ARCANUM_FRONTENDS_SERVICE,
        localUrl: env.CONSOLE_LOCAL_URL,
        fallbackFile: path,
      });
      return movedScreenProxy.handleRequest(request, path);
    }

    return new Response(null, { status: 404 });
}

const DEVICE_PAGES = new Set(['/', '/station.html', '/display.html']);

// The answer to /api/public/pair: a device paired with its code alone gets
// its key as a cookie — taken out of the answer, so the page's scripts never
// hold it.
async function keepDeviceKey(response: Response, env: Env): Promise<Response> {
  if (response.status !== 201) return response;
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.deviceKey !== 'string') return jsonResponse(body, response.status);
  const { deviceKey, ...device } = body;
  const out = jsonResponse(device, 201);
  out.headers.append('Set-Cookie', buildDeviceCookie(env, deviceKey as string));
  return out;
}

async function deviceWsToken(request: Request, env: Env, deviceKey: string): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers({ 'X-Device-Key': deviceKey, 'X-Forwarded-By': 'bff' });
  const target = `/organizations/device-ws-token${url.search}`;
  const isDev = env.FRONTEND_URL?.includes('localhost') || env.FRONTEND_URL?.includes('127.0.0.1');
  if (isDev && env.BANCONTACT_LOCAL_URL) return fetch(`${env.BANCONTACT_LOCAL_URL}${target}`, { headers });
  return env.ARCANUM_BACKEND_SERVICE.fetch(new Request(`https://backend${target}`, { headers }));
}

// A request from this very site: its own origin (the workers.dev address or
// the custom domain, whichever the browser is on), FRONTEND_URL's, or an
// ALLOWED_ORIGINS one (local development) — by Origin, else by the
// browser's Sec-Fetch-Site. Neither header: not a browser, so no CSRF.
function fromThisSite(request: Request, env: Env): boolean {
  const origin = request.headers.get('Origin');
  if (origin && origin !== 'null') {
    const allowed = new Set([new URL(request.url).origin, new URL(env.FRONTEND_URL).origin, ...(env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean)]);
    return allowed.has(origin);
  }
  const site = request.headers.get('Sec-Fetch-Site');
  return !site || site === 'same-origin';
}

function resolveAllowedOrigin(request: Request, env: Env): string {
  const requestOrigin = request.headers.get('Origin');
  if (!requestOrigin) return env.FRONTEND_URL;

  const allowed = new Set<string>(
    [env.FRONTEND_URL, ...(env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim())].filter(Boolean)
  );

  return allowed.has(requestOrigin) ? requestOrigin : env.FRONTEND_URL;
}

function corsResponse(response: Response, request: Request, env: Env): Response {
  const out = new Response(response.body, response);
  out.headers.set('Access-Control-Allow-Origin', resolveAllowedOrigin(request, env));
  out.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  out.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  out.headers.set('Access-Control-Allow-Credentials', 'true');
  out.headers.set('Vary', 'Origin');
  return out;
}


function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Returns true for paths with file extensions that are never valid in this BFF.
// Allows extensionless paths (SPA routes) and known static asset types.
function isScannedPath(path: string): boolean {
  const extMatch = path.match(/\.([a-zA-Z0-9]+)$/);
  if (!extMatch) return false;
  const ext = extMatch[1].toLowerCase();
  const ALLOWED = new Set(['html', 'js', 'css', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp', 'woff', 'woff2', 'ttf', 'eot', 'map', 'webmanifest']);
  return !ALLOWED.has(ext);
}

// A follow page's web app manifest (see the route above): opens that order,
// standalone. The page sets the shown name (apple-mobile-web-app-title).
// The scope the whole site: from that order the app goes on to the event's
// menu and the next order (/bestel/…, /volg/…) without leaving the app —
// the page itself opens the newest order, or the menu once this one's
// finished.
export function orderManifest(token: string, ref: IconRef | null = null): Response {
  return appManifest(`/volg/${token}`, 'Bestelling', 'selforder', '/', ref?.slot === 'selforder' ? ref : null);
}

// A device installed from its pairing link (/pair?code=…&role=…&name=…):
// its name and icon. No start_url — the page it was added from, the link
// itself, which opens the screen once paired; the scope the whole site.
const DEVICE_ICONS: Record<string, [icon: string, name: string]> = { pos: ['kassa', 'Kassa'], cfd: ['display', 'Klantscherm'], station: ['station', 'Station'] };

function linkedDevice(params: URLSearchParams): { role: string; icon: string; name: string } | null {
  const role = params.get('role') ?? '';
  const known = DEVICE_ICONS[role];
  if (!known) return null;
  return { role, icon: known[0], name: (params.get('name') ?? '').trim().slice(0, 60) || known[1] };
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// pair.html with the linked device's head: icon, home-screen icon, manifest,
// name under the icon, title (arcanum-frontends' pair.html has each of these
// once — its scripts/app-icons.test.ts checks the links). With `icon`
// (<org>/<slot>): that organisation's own icons.
export async function asDevice(page: Response, params: URLSearchParams): Promise<Response> {
  const device = linkedDevice(params);
  if (!device) return page;
  const ref = iconRef(params.get('icon'));
  return withHead(page, {
    icon96: ref ? orgIconUrl(ref, 96) : `/icons/${device.icon}-96.png`,
    icon180: ref ? orgIconUrl(ref, 180) : `/icons/${device.icon}-180.png`,
    manifest: ref ? orgManifestUrl(ref, device.name) : `/pair/manifest.webmanifest?${new URLSearchParams({ role: device.role, name: device.name })}`,
    name: device.name,
  });
}

// A page with these in its head (the first of each), as sent.
export async function withHead(page: Response, head: { icon96: string; icon180: string; manifest: string; name?: string }): Promise<Response> {
  if (!page.ok || !(page.headers.get('Content-Type') ?? '').includes('text/html')) return page;
  const attr = (value: string) => escapeHtml(value);
  let html = (await page.text())
    .replace(/(<link rel="icon"[^>]*href=")[^"]*/, (_, start: string) => start + attr(head.icon96))
    .replace(/(<link rel="apple-touch-icon"[^>]*href=")[^"]*/, (_, start: string) => start + attr(head.icon180))
    .replace(/(<link rel="manifest"[^>]*href=")[^"]*/, (_, start: string) => start + attr(head.manifest));
  if (head.name !== undefined) {
    const name = escapeHtml(head.name);
    html = html
      .replace(/(<meta name="apple-mobile-web-app-title"[^>]*content=")[^"]*/, (_, start: string) => start + name)
      .replace(/<title>[^<]*<\/title>/, () => `<title>${name}</title>`);
  }
  const headers = new Headers(page.headers);
  headers.delete('Content-Length');
  return new Response(html, { status: page.status, headers });
}

export function deviceManifest(params: URLSearchParams): Response {
  const device = linkedDevice(params);
  const icon = device?.icon ?? 'arcanum';
  const name = device?.name ?? ((params.get('name') ?? '').trim().slice(0, 60) || 'Arcanum');
  return new Response(
    JSON.stringify({
      name,
      short_name: name,
      scope: '/',
      display: 'standalone',
      background_color: '#ffffff',
      icons: manifestIcons(icon),
    }),
    { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' } }
  );
}

function manifestIcons(icon: string) {
  return [
    { src: `/icons/${icon}-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: `/icons/${icon}-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: `/icons/${icon}-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ];
}

// icon: one of arcanum-frontends' public/icons/ sets (scripts/app-icons.mjs).
export function appManifest(start: string, name: string, icon: string, scope = start, ref: IconRef | null = null): Response {
  return new Response(
    JSON.stringify({
      name,
      short_name: name,
      start_url: start,
      scope,
      id: start,
      display: 'standalone',
      background_color: '#ffffff',
      theme_color: '#ffffff',
      icons: ref ? [192, 512].map((size) => ({ src: orgIconUrl(ref, size), sizes: `${size}x${size}`, type: 'image/png', purpose: 'any' })) : manifestIcons(icon),
    }),
    { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' } }
  );
}
