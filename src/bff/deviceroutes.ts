import type { Env, SessionData } from '../types';
import { resolveIdpSettings } from '../types';
import type { SessionStore } from './session';
import { DeviceFlowHandler } from './device';
import { buildSessionCookie } from './cookie';
import { UIFrontendProxy } from '../services/uiProxy';

function json(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

export class DeviceRoutesHandler {
  constructor(private sessionStore: SessionStore, private env: Env) {}

  // A DeviceFlowHandler for the instance's identity provider (its
  // device-grant client).
  private async buildDeviceHandler(): Promise<DeviceFlowHandler> {
    const idp = await resolveIdpSettings(this.env, 'device');
    return new DeviceFlowHandler(this.sessionStore, {
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
      endpoints: idp.endpoints,
      issuerUrl: idp.issuerUrl,
      scope: idp.scope,
    });
  }

  async processDeviceRoute(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // The QR page (arcanum-frontends' device.html).
    if (path === '/device' && request.method === 'GET') {
      const deviceProxy = new UIFrontendProxy(this.env, {
        service: this.env.ARCANUM_FRONTENDS_SERVICE,
        localUrl: this.env.CONSOLE_LOCAL_URL,
        fallbackFile: '/device.html',
      });
      return deviceProxy.handleRequest(request, path);
    }

    if (path === '/device/start' && request.method === 'POST') {
      const device = await this.buildDeviceHandler();
      const result = await device.start();
      if ('error' in result) return json(result, 502);
      return json(result);
    }

    if (path === '/device/poll' && request.method === 'GET') {
      const pollId = url.searchParams.get('id');
      if (!pollId) return json({ status: 'error', message: 'Ontbrekende aanvraag-id' }, 400);

      const device = await this.buildDeviceHandler();
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
