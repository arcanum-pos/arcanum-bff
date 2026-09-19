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

    const sessionStore = new CloudflareKVSessionStore(env.QUESTO_SESSIONS);

    // /login and /device (+ /device/start) also have an org-scoped variant,
    // /:orgId/login and /:orgId/device(/start) — the only entry points that
    // need to know the org up front. /callback and /device/poll deliberately
    // stay these exact global paths regardless: the org travels inside the
    // short-lived PKCE/device-poll session created at start time, so
    // resolving it again there needs no URL prefix (also means an org's own
    // identity provider only ever needs the one, unprefixed redirect_uri
    // registered — same as every org today).
    if (path === '/login' || path === '/callback' || path === '/logout' || /^\/[^/]+\/login$/.test(path)) {
      const authHandler = new AuthRoutesHandler(sessionStore, env);
      return authHandler.processAuthRoute(request);
    }

    // Device Authorization Grant: a kiosk device shows a QR/code, the user completes
    // login on their own phone, the kiosk polls until done. Public — no session/cookie
    // needed to start or poll, since the whole point is authenticating this device.
    // /:orgId/console (note: no unprefixed /console — that's the real admin
    // app, handled below) is the same device-grant QR/code page as /device,
    // just redirecting to /console on completion instead of / — see
    // deviceroutes.ts. Matched here, before the generic /console handling
    // further down, so it never reaches the admin-app proxy.
    if (
      path === '/device' ||
      path.startsWith('/device/') ||
      /^\/[^/]+\/device$/.test(path) ||
      /^\/[^/]+\/device\/start$/.test(path) ||
      /^\/[^/]+\/console$/.test(path)
    ) {
      const deviceHandler = new DeviceRoutesHandler(sessionStore, env);
      return deviceHandler.processDeviceRoute(request);
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
      return new Response(loginPromptHtml(path), { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // The admin portal (questo-admin) lives at /console — questo-webapp's
    // old /admin.html and /admin-org.html pages it replaced are gone. Same
    // auth gate as any other UI path above, just a different backend.
    // /assets/* is questo-admin's own Vite build's asset prefix (distinct
    // from questo-webapp's Astro output, which uses /_astro/*), so it's
    // routed here regardless of which page loaded it — every entry
    // questo-admin ever adds shares this one dist/assets/ folder.
    if (path === '/console' || path.startsWith('/console/') || path.startsWith('/assets/')) {
      const consoleProxy = new UIFrontendProxy(env, {
        service: env.CONSOLE_SERVICE,
        localUrl: env.CONSOLE_LOCAL_URL,
        fallbackFile: '/admin.html',
      });
      return consoleProxy.handleRequest(request, path);
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

// Carries the originally-requested path through /login so /callback lands
// the browser back where it was headed (e.g. /console) instead of always
// the root chooser — see authroutes.ts's sanitizeReturnTo for why this is
// safe to build straight from `path` (already a browser-parsed pathname).
function loginPromptHtml(returnTo: string): string {
  const href = returnTo && returnTo !== '/' ? `/login?returnTo=${encodeURIComponent(returnTo)}` : '/login';
  return `<!DOCTYPE html>
<html lang="nl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Aanmelden vereist</title>
<style>body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#f5f5f5}
a{display:inline-block;padding:.75rem 1.5rem;background:#1a73e8;color:#fff;text-decoration:none;border-radius:.5rem;font-weight:600}</style>
</head>
<body><a href="${href}">Aanmelden om verder te gaan</a></body>
</html>`;
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
