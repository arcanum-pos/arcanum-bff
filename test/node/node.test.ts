// The bff self-hosted (SELF_HOSTING.md): the same Worker code on Node with
// Cloudflare-shaped bindings — sessions in SQLite, the rate limit in memory,
// service bindings as HTTP to the other Services — and the WebSocket
// upgrade passed on to devicehub without the person's cookie. The other
// Services are small local HTTP servers here.
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { start } from '../../src/node';
import { httpFetcher } from '../../src/node/fetcher';
import { SqliteKV } from '../../src/node/kv';
import { MemoryRateLimit } from '../../src/node/rate-limit';

const dir = mkdtempSync(path.join(tmpdir(), 'bff-'));

async function listen(server: http.Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}

describe('sessions in SQLite (KV)', () => {
  it('put, get, delete - and gone once expired', async () => {
    const kv = new SqliteKV(path.join(dir, 'kv.db'));
    await kv.put('s1', 'one', { expirationTtl: 60 });
    expect(await kv.get('s1')).toBe('one');
    await kv.put('s1', 'two', { expirationTtl: 60 });
    expect(await kv.get('s1')).toBe('two');
    await kv.delete('s1');
    expect(await kv.get('s1')).toBeNull();
    await kv.put('old', 'x', { expirationTtl: -1 });
    expect(await kv.get('old')).toBeNull();
    await kv.put('older', 'x', { expirationTtl: -1 });
    expect(kv.sweep()).toBe(1);
  });

  it('kept across a restart (the file)', async () => {
    const file = path.join(dir, 'restart.db');
    await new SqliteKV(file).put('s', 'kept', { expirationTtl: 60 });
    expect(await new SqliteKV(file).get('s')).toBe('kept');
  });
});

describe('the rate limit, in memory', () => {
  it('at most so many per key per period', async () => {
    const limiter = new MemoryRateLimit(2, 60);
    const results = [];
    for (let i = 0; i < 3; i++) results.push((await limiter.limit({ key: 'ip-1' })).success);
    expect(results).toEqual([true, true, false]);
    expect((await limiter.limit({ key: 'ip-2' })).success).toBe(true);
  });
});

describe('a service binding as HTTP', () => {
  it('path, query, method, headers and body go to the Service', async () => {
    let seen: { url?: string; method?: string; header?: string; body: string } = { body: '' };
    const server = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      seen = { url: req.url, method: req.method, header: req.headers['x-user-sub'] as string, body };
      res.end('ok');
    });
    const url = await listen(server);
    const res = await httpFetcher(url).fetch('https://backend/organizations/o1/tabs?x=1', { method: 'POST', headers: { 'X-User-Sub': 'u1' }, body: '{"a":1}' });
    expect(await res.text()).toBe('ok');
    // Changeable, like a service binding's answer (the bff adds headers to it).
    expect(() => res.headers.set('X-Added', '1')).not.toThrow();
    expect(seen).toEqual({ url: '/organizations/o1/tabs?x=1', method: 'POST', header: 'u1', body: '{"a":1}' });
    server.close();
  });
});

describe('the whole bff on Node', () => {
  let bff: string;
  let stop: () => void;
  const devicehubSaw: string[] = [];
  const servers: http.Server[] = [];

  beforeAll(async () => {
    const backend = http.createServer((req, res) => res.end(JSON.stringify({ backend: req.url, sub: req.headers['x-user-sub'] ?? null })));
    const frontends = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<html>frontends ${req.url}</html>`);
    });
    // devicehub: answers a WebSocket upgrade, and remembers the request it got.
    const devicehub = http.createServer((_req, res) => res.end('devicehub'));
    devicehub.on('upgrade', (req, socket) => {
      devicehubSaw.push(`${req.url} cookie=${req.headers.cookie ?? '-'} auth=${req.headers.authorization ?? '-'}`);
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      socket.on('data', (d) => socket.write(d));
    });
    servers.push(backend, frontends, devicehub);
    const [b, f, d] = await Promise.all([listen(backend), listen(frontends), listen(devicehub)]);
    Object.assign(process.env, { TEST_BACKEND_URL: b, TEST_FRONTENDS_URL: f, TEST_DEVICEHUB_URL: d });
    const server = start({
      PORT: '0',
      BACKEND_URL: b,
      FRONTENDS_URL: f,
      DEVICEHUB_URL: d,
      SESSIONS_DB: path.join(dir, 'sessions.db'),
      FRONTEND_URL: 'https://arcanum.test',
      BFF_INTERNAL_KEY: 'test-bff-key',
    });
    await once(server, 'listening');
    bff = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    stop = () => server.close();
  });
  afterAll(() => {
    stop();
    servers.forEach((s) => s.close());
  });

  it('an authenticated API call answered by the backend (its answer gets the bff\'s headers)', async () => {
    const res = await fetch(`${bff}/api/public/tables/qr-1`, { headers: { Origin: 'https://arcanum.test' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ backend: '/public/tables/qr-1', sub: null });
  });

  it('the public API to the backend, with no identity - even one a client made up', async () => {
    const res = await fetch(`${bff}/api/public/self-order/the-code`, { headers: { 'X-User-Sub': 'forged' } });
    expect(await res.json()).toEqual({ backend: '/public/self-order/the-code', sub: null });
  });

  it('a page from frontends; a signed-in page without a session: the login prompt', async () => {
    expect(await (await fetch(`${bff}/pair`, { headers: { Accept: 'text/html' } })).text()).toBe('<html>frontends /pair.html</html>');
    const kassa = await fetch(`${bff}/kassa.html`, { headers: { Accept: 'text/html' } });
    expect(kassa.status).toBe(401);
    expect(await kassa.text()).toBe('<html>frontends /login-prompt.html</html>');
  });

  it("a device's socket goes to devicehub - without the person's cookie or Authorization", async () => {
    const socket = net.connect(Number(new URL(bff).port), '127.0.0.1');
    await once(socket, 'connect');
    socket.write(
      ['GET /devices/connect?token=t1 HTTP/1.1', 'Host: arcanum.test', 'Upgrade: websocket', 'Connection: Upgrade', 'Cookie: __Host-arcanum_session=secret', 'Authorization: Bearer x', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', '', ''].join('\r\n')
    );
    const [first] = (await once(socket, 'data')) as [Buffer];
    expect(first.toString()).toContain('101 Switching Protocols');
    // Both ways after the upgrade.
    socket.write('ping');
    const [echo] = (await once(socket, 'data')) as [Buffer];
    expect(echo.toString()).toBe('ping');
    expect(devicehubSaw).toEqual(['/devices/connect?token=t1 cookie=- auth=-']);
    socket.destroy();
  });

  it('on a localhost address too (its local-development path): the backend\'s answer comes through', async () => {
    const local = start({
      PORT: '0',
      BACKEND_URL: process.env.TEST_BACKEND_URL!,
      FRONTENDS_URL: process.env.TEST_FRONTENDS_URL!,
      DEVICEHUB_URL: process.env.TEST_DEVICEHUB_URL!,
      SESSIONS_DB: path.join(dir, 'local.db'),
      FRONTEND_URL: 'http://localhost:9',
      BFF_INTERNAL_KEY: 'test-bff-key',
    });
    await once(local, 'listening');
    const res = await fetch(`http://127.0.0.1:${(local.address() as net.AddressInfo).port}/api/public/self-order/the-code`);
    expect(await res.json()).toEqual({ backend: '/public/self-order/the-code', sub: null });
    local.close();
  });

  it('any other upgrade: refused', async () => {
    const socket = net.connect(Number(new URL(bff).port), '127.0.0.1');
    await once(socket, 'connect');
    socket.write(['GET /api/whatever HTTP/1.1', 'Host: arcanum.test', 'Upgrade: websocket', 'Connection: Upgrade', '', ''].join('\r\n'));
    const [answer] = (await once(socket, 'data')) as [Buffer];
    expect(answer.toString()).toContain('404');
    socket.destroy();
  });
});
