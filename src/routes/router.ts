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
    service: 'BANCONTACT_SERVICE',
    requireAuth: true,
    rewritePath: { from: '/api/bancontact', to: '' },
    localUrlEnv: 'BANCONTACT_LOCAL_URL',
  },
];

export function isKnownApiRoute(pathname: string): boolean {
  return ROUTES.some((r) => r.pattern.test(pathname));
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
