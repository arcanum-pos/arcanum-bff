// /sync/* - a local box's offline sync (bff/sync.ts): no session, only its
// key goes along to the backend.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';

function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  return worker.fetch(new Request(`https://arcanum.test${path}`, { redirect: 'manual', ...init }), env, ctx);
}

describe('a box syncing to its backup', () => {
  it('reaches the backend without a session, with its key and nothing else of its own', async () => {
    const res = await call('/sync/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer the-sync-key', 'X-User-Sub': 'forged', Cookie: '__Host-session_id=abc', 'X-Device-Key': 'forged' },
      body: JSON.stringify({ toSeq: 1, tables: [] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; headers: Record<string, string> };
    expect(body.path).toBe('/sync/batch');
    expect(body.headers.authorization).toBe('Bearer the-sync-key');
    for (const h of ['x-user-sub', 'cookie', 'x-device-key']) expect(body.headers[h], h).toBeUndefined();
  });

  it('only for its two calls, and only POST', async () => {
    expect((await call('/sync/hello', { method: 'GET' })).status).toBe(405);
    expect((await call('/sync/anything-else', { method: 'POST' })).status).not.toBe(200);
  });
});
