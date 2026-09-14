import type { Env, SessionData, DevicePollSessionData } from '../types';
import { resolveIdpSettings } from '../types';
import type { SessionStore } from './session';
import { DeviceFlowHandler } from './device';
import { buildSessionCookie } from './cookie';
import { DEVICE_PAGE_HTML } from '../devicePage';
import { QRCODE_BUNDLE_JS } from '../assets/qrcodeBundle';

const DEFAULT_ORG_ID = 'default';

function json(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

export class DeviceRoutesHandler {
  constructor(private sessionStore: SessionStore, private env: Env) {}

  private async buildDeviceHandler(orgId: string): Promise<DeviceFlowHandler> {
    const idp = await resolveIdpSettings(orgId, this.env);
    return new DeviceFlowHandler(this.sessionStore, {
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
      endpoints: idp.endpoints,
      issuerUrl: idp.issuerUrl,
    });
  }

  // /device/poll doesn't know which org a given attempt was for except by
  // reading it back out of the stored DevicePollSessionData — peek at it
  // here, before building the handler that will redo that same lookup
  // (and delete it) inside device.poll().
  private async peekPollOrgId(pollId: string): Promise<string> {
    const data = (await this.sessionStore.get(pollId)) as DevicePollSessionData | null;
    return data?.orgId || DEFAULT_ORG_ID;
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
      const device = await this.buildDeviceHandler(DEFAULT_ORG_ID);
      const result = await device.start(DEFAULT_ORG_ID);
      if ('error' in result) return json(result, 502);
      return json(result);
    }

    if (path === '/device/poll' && request.method === 'GET') {
      const pollId = url.searchParams.get('id');
      if (!pollId) return json({ status: 'error', message: 'Ontbrekende aanvraag-id' }, 400);

      const orgId = await this.peekPollOrgId(pollId);
      const device = await this.buildDeviceHandler(orgId);
      const [result, sessionData] = await device.poll(pollId);

      if (result.status === 'complete' && sessionData) {
        const newSessionId = await this.sessionStore.create(sessionData satisfies SessionData, this.env.SESSION_TTL);
        return json(result, 200, { 'Set-Cookie': buildSessionCookie(this.env, newSessionId) });
      }

      return json(result);
    }

    return json({ error: 'Not found' }, 404);
  }
}
