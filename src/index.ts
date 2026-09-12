import type { Env } from './types';
import { CloudflareKVSessionStore } from './adapters/kv_session_store';
import { AuthRoutesHandler } from './bff/authroutes';
import { authresult } from './bff/authresult';
import { processWhoAmi } from './bff/whoami';
import { Router, isKnownApiRoute } from './routes/router';
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

    if (path === '/login' || path === '/callback' || path === '/logout') {
      const authHandler = new AuthRoutesHandler(sessionStore, env);
      return authHandler.processAuthRoute(request);
    }

    const auth = await authresult(request, env, sessionStore);

    if (path === '/whoami') {
      const result = await processWhoAmi(request, auth, env);
      return corsResponse(jsonResponse(result.data, result.status), request, env);
    }

    if (path.startsWith('/api')) {
      if (auth.authMethod === 'public') {
        return corsResponse(jsonResponse({ error: 'Unauthorized' }, 401), request, env);
      }
      const router = new Router(env, auth);
      const response = await router.dispatch(request);
      if (response) return corsResponse(response, request, env);
      return corsResponse(jsonResponse({ error: 'Not found' }, 404), request, env);
    }

    // All other paths → UI (gated behind auth)
    if (auth.authMethod === 'public') {
      // Only redirect browsers to login; scanners and API clients that reach here get 401.
      if (!request.headers.get('Accept')?.includes('text/html')) {
        return new Response(null, { status: 401 });
      }
      return new Response(null, { status: 302, headers: { Location: '/login' } });
    }
    const uiProxy = new UIFrontendProxy(env);
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
