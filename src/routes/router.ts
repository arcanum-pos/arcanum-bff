import type { Env, AuthResult, RewritePath } from '../types';
import { ServiceProxy } from '../services/serviceProxy';

interface RouteDefinition {
  pattern: RegExp;
  service: keyof Env;
  requireAuth: boolean;
  rewritePath?: RewritePath;
  // env var holding the local `wrangler dev` URL to forward to instead of the service
  // binding, only used when running locally (FRONTEND_URL contains localhost/127.0.0.1)
  localUrlEnv?: keyof Env;
}

const ROUTES: RouteDefinition[] = [
  {
    pattern: /^\/api\/bancontact(\/|$)/,
    service: 'ARCANUM_BACKEND_SERVICE',
    requireAuth: true,
    rewritePath: { from: '/api/bancontact', to: '' },
    localUrlEnv: 'BANCONTACT_LOCAL_URL',
  },
  // Device registration/linking/ws-token — a separate Worker (questo-devicehub)
  // from payment processing, on purpose. The WebSocket itself (/devices/connect)
  // is NOT proxied here: clients open it directly against that worker's public
  // URL using the short-lived token returned by /api/devices/ws-token, deliberately
  // bypassing session auth for that one, low-privilege, notification-only channel.
  {
    pattern: /^\/api\/devices(\/|$)/,
    service: 'ARCANUM_DEVICEHUB_SERVICE',
    requireAuth: true,
    rewritePath: { from: '/api/devices', to: '/devices' },
    localUrlEnv: 'DEVICEHUB_LOCAL_URL',
  },
  // Organizations/admin-portal backend — same worker as bancontact/sumup
  // (payment processing), just a different path prefix. Session-checked like
  // everything else; per-organization role checks happen inside the worker
  // itself (see worker/src/organizations/auth.ts), using the X-User-Sub
  // identity header this proxy already attaches below.
  {
    pattern: /^\/api\/organizations(\/|$)/,
    service: 'ARCANUM_BACKEND_SERVICE',
    requireAuth: true,
    rewritePath: { from: '/api/organizations', to: '/organizations' },
    localUrlEnv: 'BANCONTACT_LOCAL_URL',
  },
  // Payment-provider webhook callbacks (Bancontact, SumUp). Deliberately
  // unauthenticated — the provider calling this has no Auth0 session/bearer
  // token to present — but still routed through this proxy rather than
  // exposing the worker's own public URL, so the worker stays reachable only
  // via the BFF (see the 2026-09 callback-handler discussion). Payload
  // authenticity (signature/secret) is verified by the worker itself, not
  // here — this proxy is just an unauthenticated pipe for this one prefix.
  {
    pattern: /^\/api\/callback(\/|$)/,
    service: 'ARCANUM_BACKEND_SERVICE',
    requireAuth: false,
    rewritePath: { from: '/api/callback', to: '/callback' },
    localUrlEnv: 'BANCONTACT_LOCAL_URL',
  },
];

export function isKnownApiRoute(pathname: string): boolean {
  return ROUTES.some((r) => r.pattern.test(pathname));
}

// Consulted by index.ts's top-level /api auth gate, which runs before the
// Router is constructed — so it needs to know a route's requireAuth without
// dispatching. Defaults to true (safe default) for anything unmatched; in
// practice isKnownApiRoute already rejects unmatched /api paths earlier.
export function routeRequiresAuth(pathname: string): boolean {
  const route = ROUTES.find((r) => r.pattern.test(pathname));
  return route ? route.requireAuth : true;
}

export class Router {
  private proxy: ServiceProxy;

  constructor(private env: Env, authResult: AuthResult) {
    this.proxy = new ServiceProxy(env, authResult);
  }

  async dispatch(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const route = ROUTES.find((r) => r.pattern.test(url.pathname));

    if (!route) return null;

    const service = (this.env as unknown as Record<string, unknown>)[route.service as string] as Fetcher | undefined;
    if (!service) {
      console.error(`Service binding ${String(route.service)} not found`);
      return new Response(JSON.stringify({ error: 'Service unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const localUrl = route.localUrlEnv ? (this.env[route.localUrlEnv] as string | undefined) : undefined;

    return this.proxy.forward(request, service, {
      requireAuth: route.requireAuth,
      rewritePath: route.rewritePath ?? null,
      local_url: localUrl,
      debug: this.env.FRONTEND_URL?.includes('localhost'),
    });
  }
}
