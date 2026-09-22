import type { Env, SessionData, DevicePollSessionData, IdpSettings } from '../types';
import { resolveIdpSettings } from '../types';
import type { SessionStore } from './session';
import { DeviceFlowHandler } from './device';
import { buildSessionCookie } from './cookie';
import { UIFrontendProxy } from '../services/uiProxy';

const DEFAULT_ORG_ID = 'default';

function json(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

export class DeviceRoutesHandler {
  constructor(private sessionStore: SessionStore, private env: Env) {}

  // `orgIdentifier` may be a real id, or (for the unprefixed /device/start)
  // the request's own Host header — lets a kiosk physically pointed at a
  // branded domain use the right client with no org identifier needed.
  private async buildDeviceHandler(orgIdentifier: string): Promise<{ device: DeviceFlowHandler; idp: IdpSettings }> {
    const idp = await resolveIdpSettings(orgIdentifier, this.env, 'device');
    const device = new DeviceFlowHandler(this.sessionStore, {
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
      endpoints: idp.endpoints,
      issuerUrl: idp.issuerUrl,
      scope: idp.scope,
    });
    return { device, idp };
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

    // Matches both /device (group 1 undefined -> DEFAULT_ORG_ID) and
    // /:orgId/device — same static page either way (arcanum-frontends'
    // device.html); its own script computes the matching /device/start URL
    // from window.location.
    const deviceMatch = path.match(/^\/(?:([^/]+)\/)?device$/);
    if (deviceMatch && request.method === 'GET') {
      const deviceProxy = new UIFrontendProxy(this.env, {
        service: this.env.CONSOLE_SERVICE,
        localUrl: this.env.CONSOLE_LOCAL_URL,
        fallbackFile: '/device.html',
      });
      return deviceProxy.handleRequest(request, path);
    }

    // Matches both /device/start and /:orgId/device/start. For the
    // unprefixed form, try the request's own Host header before falling
    // back to the literal DEFAULT_ORG_ID.
    const startMatch = path.match(/^\/(?:([^/]+)\/)?device\/start$/);
    if (startMatch && request.method === 'POST') {
      const orgIdentifier = startMatch[1] || request.headers.get('Host') || DEFAULT_ORG_ID;
      const { device, idp } = await this.buildDeviceHandler(orgIdentifier);
      const result = await device.start(idp.orgId);
      if ('error' in result) return json(result, 502);
      return json(result);
    }

    if (path === '/device/poll' && request.method === 'GET') {
      const pollId = url.searchParams.get('id');
      if (!pollId) return json({ status: 'error', message: 'Ontbrekende aanvraag-id' }, 400);

      const orgId = await this.peekPollOrgId(pollId);
      const { device } = await this.buildDeviceHandler(orgId);
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
