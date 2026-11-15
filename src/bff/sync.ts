import type { Env } from '../types';

// /sync/* - offline sync (arcanum/OFFLINE.md): a local box sends its org's
// changes to its backup on this installation. Server to server, no session:
// the box's sync key (Authorization: Bearer) is all it has, and the backend
// (sync/replica.ts) decides which org that key may write. So, unlike every
// other route, Authorization goes along - and nothing else of the caller's:
// no cookie, no identity headers, no device key.
const SYNC_PATHS = new Set(['/sync/hello', '/sync/batch']);

export function isSyncPath(path: string): boolean {
  return SYNC_PATHS.has(path);
}

export async function forwardSync(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  const url = new URL(request.url);
  // A fresh set: nothing the caller sent but its key.
  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  const authorization = request.headers.get('Authorization');
  if (authorization) headers.set('Authorization', authorization);
  headers.set('X-Forwarded-By', 'bff');
  const isDevelopment = env.FRONTEND_URL?.includes('localhost') || env.FRONTEND_URL?.includes('127.0.0.1');
  const init = { method: 'POST', headers, body: request.body, duplex: 'half' } as RequestInit;
  try {
    const res =
      isDevelopment && env.BANCONTACT_LOCAL_URL
        ? await fetch(`${env.BANCONTACT_LOCAL_URL}${url.pathname}`, init)
        : await env.ARCANUM_BACKEND_SERVICE.fetch(new Request(`https://backend${url.pathname}`, init));
    return new Response(res.body, res);
  } catch (error) {
    console.error('Backend unreachable for sync:', error);
    return new Response(JSON.stringify({ error: 'Service unavailable' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }
}
