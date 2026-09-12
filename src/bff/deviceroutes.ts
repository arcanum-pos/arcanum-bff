import type { Env, SessionData } from '../types';
import { getOAuthEndpoints } from '../types';
import type { SessionStore } from './session';
import { DeviceFlowHandler } from './device';
import { buildSessionCookie } from './cookie';
import { DEVICE_PAGE_HTML } from '../devicePage';
import { QRCODE_BUNDLE_JS } from '../assets/qrcodeBundle';

function json(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

export class DeviceRoutesHandler {
  private device: DeviceFlowHandler;

  constructor(private sessionStore: SessionStore, private env: Env) {
    this.device = new DeviceFlowHandler(this.sessionStore, {
      clientId: env.OAUTH_CLIENT_ID,
      clientSecret: env.OAUTH_CLIENT_SECRET,
      endpoints: getOAuthEndpoints(env),
    });
  }

  async processDeviceRoute(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/device' && request.method === 'GET') {
      return new Response(DEVICE_PAGE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    if (path === '/device/qrcode.js' && request.method === 'GET') {
      return new Response(QRCODE_BUNDLE_JS, {
        headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' },
      });
    }

    if (path === '/device/start' && request.method === 'POST') {
      const result = await this.device.start();
      if ('error' in result) return json(result, 502);
      return json(result);
    }

    if (path === '/device/poll' && request.method === 'GET') {
      const pollId = url.searchParams.get('id');
      if (!pollId) return json({ status: 'error', message: 'Ontbrekende aanvraag-id' }, 400);

      const [result, sessionData] = await this.device.poll(pollId);

      if (result.status === 'complete' && sessionData) {
        const newSessionId = await this.sessionStore.create(sessionData satisfies SessionData, this.env.SESSION_TTL);
        return json(result, 200, { 'Set-Cookie': buildSessionCookie(this.env, newSessionId) });
      }

      return json(result);
    }

    return json({ error: 'Not found' }, 404);
  }
}
