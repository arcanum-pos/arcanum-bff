// Direct (non-proxy) calls from questo-bff to `worker`'s own internal-only
// routes — distinct from ServiceProxy, which forwards an already-established
// user session/identity. This is used pre-authentication (there is no
// session yet), so it carries BFF_INTERNAL_KEY instead of any user identity
// — mirrors worker's own devicehub-client.ts pattern for its calls to
// questo-devicehub (a separate secret from that one, though: a different
// pairwise relationship).
import type { Env } from '../types';

function isDevelopment(env: Env): boolean {
  return Boolean(env.FRONTEND_URL?.includes('localhost') || env.FRONTEND_URL?.includes('127.0.0.1'));
}

export async function callWorker(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${env.BFF_INTERNAL_KEY}`,
    ...((init.headers as Record<string, string>) || {}),
  };

  if (isDevelopment(env) && env.BANCONTACT_LOCAL_URL) {
    return fetch(`${env.BANCONTACT_LOCAL_URL}${path}`, { ...init, headers });
  }
  return env.BANCONTACT_SERVICE.fetch(`https://worker${path}`, { ...init, headers });
}
