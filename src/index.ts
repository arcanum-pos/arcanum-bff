import type { Env } from './types';
import { CloudflareKVSessionStore } from './adapters/kv_session_store';
import { AuthRoutesHandler } from './bff/authroutes';
import { DeviceRoutesHandler } from './bff/deviceroutes';
import { authresult } from './bff/authresult';
import { processWhoAmi } from './bff/whoami';
import { Router, isKnownApiRoute, routeRequiresAuth } from './routes/router';
import { UIFrontendProxy } from './services/uiProxy';

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
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
        jsonResponse({ version: env.CF_VERSION_METADATA?.id ?? 'local', git_commit: env.GIT_COMMIT_SHA }),
        request,
        env
      );
    }

    // Reject scanner probes before any session/auth work.
    // Paths with non-app file extensions (e.g. .php, .env, .asp) can never be valid routes here.
    if (isScannedPath(path)) {
      return new Response(null, { status: 404 });
    }

    // Unknown /api/* paths are rejected before any auth work — route table is static and known.
    if (path.startsWith('/api') && !isKnownApiRoute(path)) {
      return corsResponse(jsonResponse({ error: 'Not found' }, 404), request, env);
    }

    const sessionStore = new CloudflareKVSessionStore(env.ARCANUM_SESSIONS);

    // /login and /device (+ /device/start) also have an org-scoped variant,
    // /:orgId/login and /:orgId/device(/start) — the only entry points that
    // need to know the org up front. /callback and /device/poll deliberately
    // stay these exact global paths regardless: the org travels inside the
    // short-lived PKCE/device-poll session created at start time, so
    // resolving it again there needs no URL prefix (also means an org's own
    // identity provider only ever needs the one, unprefixed redirect_uri
    // registered — same as every org today).
    //
    // /:orgId/console (note: no unprefixed /console — that's the real admin
    // app, handled below) is the authorization-code flow's counterpart to
    // /:orgId/device: same login, always landing on /console instead of /.
    // Matched here, before the generic /console handling further down, so
    // it never reaches the admin-app proxy.
    if (
      path === '/login' ||
      path === '/callback' ||
      path === '/logout' ||
      /^\/[^/]+\/login$/.test(path) ||
      /^\/[^/]+\/console$/.test(path)
    ) {
      const authHandler = new AuthRoutesHandler(sessionStore, env);
      return authHandler.processAuthRoute(request);
    }

    // Device Authorization Grant: a kiosk device shows a QR/code, the user completes
    // login on their own phone, the kiosk polls until done. Public — no session/cookie
    // needed to start or poll, since the whole point is authenticating this device.
    if (
      path === '/device' ||
      path.startsWith('/device/') ||
      /^\/[^/]+\/device$/.test(path) ||
      /^\/[^/]+\/device\/start$/.test(path)
    ) {
      const deviceHandler = new DeviceRoutesHandler(sessionStore, env);
      return deviceHandler.processDeviceRoute(request);
    }

    // arcanum-frontends' shared Vite asset prefix — JS/CSS for every entry
    // it builds (admin, chooser, device, login-prompt), public by nature
    // (compiled client code, nothing sensitive). Has to be checked before
    // the auth gate below, not just alongside /console's own routing:
    // device.html and login-prompt.html are themselves served before/
    // without a session, so their own <script>/<link> tags need these to
    // load unauthenticated too.
    if (path.startsWith('/assets/')) {
      const assetsProxy = new UIFrontendProxy(env, {
        service: env.CONSOLE_SERVICE,
        localUrl: env.CONSOLE_LOCAL_URL,
        fallbackFile: '/admin.html',
      });
      return assetsProxy.handleRequest(request, path);
    }

    const auth = await authresult(request, env, sessionStore);

    if (path === '/whoami') {
      const result = await processWhoAmi(request, auth, env);
      return corsResponse(jsonResponse(result.data, result.status), request, env);
    }

    if (path.startsWith('/api')) {
      if (auth.authMethod === 'public' && routeRequiresAuth(path)) {
        return corsResponse(jsonResponse({ error: 'Unauthorized' }, 401), request, env);
      }
      const router = new Router(env, auth);
      const response = await router.dispatch(request);
      if (response) return corsResponse(response, request, env);
      return corsResponse(jsonResponse({ error: 'Not found' }, 404), request, env);
    }

    // All other paths → UI (gated behind auth)
    if (auth.authMethod === 'public') {
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
        service: env.CONSOLE_SERVICE,
        localUrl: env.CONSOLE_LOCAL_URL,
        fallbackFile: '/login-prompt.html',
      });
      const prompt = await promptProxy.handleRequest(request, '/login-prompt.html');
      return new Response(prompt.body, { status: 401, headers: prompt.headers });
    }

    // The admin portal (arcanum-admin) lives at /console — questo-webapp's
    // old /admin.html and /admin-org.html pages it replaced are gone. Same
    // auth gate as any other UI path above, just a different backend.
    // (/assets/* — its Vite build output — is handled earlier, unauthenticated.)
    if (path === '/console' || path.startsWith('/console/')) {
      const consoleProxy = new UIFrontendProxy(env, {
        service: env.CONSOLE_SERVICE,
        localUrl: env.CONSOLE_LOCAL_URL,
        fallbackFile: '/admin.html',
      });
      return consoleProxy.handleRequest(request, path);
    }

    // Root "/" — the org + device-role chooser (arcanum-frontends'
    // chooser.html), authenticated at this point (the public branch above
    // already returned). Its own script checks localStorage first and
    // redirects straight to kassa/display/simulator.html if this browser is
    // already registered as a terminal.
    if (path === '/') {
      const chooserProxy = new UIFrontendProxy(env, {
        service: env.CONSOLE_SERVICE,
        localUrl: env.CONSOLE_LOCAL_URL,
        fallbackFile: '/chooser.html',
      });
      return chooserProxy.handleRequest(request, path);
    }

    // The SumUp simulator moved to arcanum-frontends (simulator.html) —
    // kassa.html/display.html stay on WEBAPP_SERVICE below until they move too.
    if (path === '/simulator.html') {
      const simulatorProxy = new UIFrontendProxy(env, {
        service: env.CONSOLE_SERVICE,
        localUrl: env.CONSOLE_LOCAL_URL,
        fallbackFile: '/simulator.html',
      });
      return simulatorProxy.handleRequest(request, path);
    }

    const uiProxy = new UIFrontendProxy(env, {
      service: env.WEBAPP_SERVICE,
      localUrl: env.UIPROXY_URL,
      fallbackFile: '/index.html',
    });
    return uiProxy.handleRequest(request, path);
  },
};

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
  const ALLOWED = new Set(['html', 'js', 'css', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp', 'woff', 'woff2', 'ttf', 'eot', 'map']);
  return !ALLOWED.has(ext);
}
