// A ticket printer asking for work (arcanum/PRINTING.md, Epson Server Direct
// Print): it has no session and sends no Origin - the backend checks the
// secret in its URL. Only that one path opens up.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';

const BASE = 'https://arcanum.test';

function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  return worker.fetch(new Request(`${BASE}${path}`, { redirect: 'manual', ...init }), env, ctx);
}

describe('a printer polling for work', () => {
  it('reaches the backend without a session, its key in the query, no identity', async () => {
    const res = await call('/api/public/print/epson/pr-1?key=the-secret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-User-Sub': 'forged' },
      body: 'ConnectionType=GetRequest&ID=',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; search: string; headers: Record<string, string> };
    expect(body.path).toBe('/public/print/epson/pr-1');
    expect(body.search).toBe('?key=the-secret');
    expect(body.headers['x-user-sub']).toBeUndefined();
  });

  it('opens nothing else under it', async () => {
    for (const path of ['/api/public/print/epson', '/api/public/print/epson/pr-1/jobs', '/api/public/print/star/pr-1']) {
      expect((await call(path, { method: 'POST', body: '' })).status, path).toBe(404);
    }
  });
});
