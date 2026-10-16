// arcanum-bff self-hosted (SELF_HOSTING.md): the same Worker code
// (index.ts), served by Node with Cloudflare-shaped bindings (node/env.ts).
// PORT to listen on (default 8080).
//
// One thing Node does differently: a WebSocket (a device's notification
// socket, a follow page's order hub) arrives as an HTTP upgrade, not as a
// Request — so /devices/connect and /orders/connect are passed straight on
// to devicehub here, as raw TCP, like index.ts does on Cloudflare (no
// cookie, no Authorization: the socket's own short-lived token does the work).
import { serve } from '@hono/node-server';
import type { IncomingMessage } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import worker from './index';
import { nodeEnv } from './node/env';

const SOCKET_PATHS = new Set(['/devices/connect', '/orders/connect']);

export function forwardUpgrade(devicehubUrl: string, req: IncomingMessage, client: Duplex, head: Buffer): void {
  const path = new URL(req.url || '/', 'http://bff').pathname;
  if (!SOCKET_PATHS.has(path)) {
    client.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return;
  }
  const target = new URL(devicehubUrl);
  const upstream = net.connect({ host: target.hostname, port: Number(target.port || 80) }, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`, `Host: ${target.host}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      if (/^(host|cookie|authorization)$/i.test(name)) continue;
      lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  const close = () => {
    upstream.destroy();
    client.destroy();
  };
  upstream.on('error', close);
  client.on('error', close);
}

export function start(environment: NodeJS.ProcessEnv = process.env) {
  const { env, sessions } = nodeEnv(environment);
  const ctx = { waitUntil: (p: Promise<unknown>) => void p.catch((err) => console.error('waitUntil', err)), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const port = Number(environment.PORT || 8080);
  const server = serve({ fetch: (request) => worker.fetch(request, env, ctx), port }, () => console.log(`arcanum-bff listening on :${port}`));
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => forwardUpgrade(environment.DEVICEHUB_URL!, req, socket, head));
  // Expired sessions out of the file now and then (KV does it by itself).
  setInterval(() => sessions.sweep(), 3600_000).unref();
  return server;
}

