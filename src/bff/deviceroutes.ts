import type { Env, SessionData, DevicePollSessionData } from '../types';
import { resolveIdpSettings } from '../types';
import type { SessionStore } from './session';
import { DeviceFlowHandler } from './device';
import { buildSessionCookie } from './cookie';
import { renderDevicePage } from '../devicePage';
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
      scope: idp.scope,
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

    // Matches both /device (group 1 undefined -> DEFAULT_ORG_ID) and
    // /:orgId/device — same static page either way; its own script computes
    // the matching /device/start URL from window.location (see
    // devicePage.ts).
    const deviceMatch = path.match(/^\/(?:([^/]+)\/)?device$/);
    if (deviceMatch && request.method === 'GET') {
      return new Response(renderDevicePage('/'), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // /:orgId/console: the same device-grant QR/code page, repurposed for
    // admin-portal login — for an org whose identity provider only supports
    // the device grant (e.g. a Google "TV and Limited Input" client, which
    // can't do the authorization-code flow at all), this is the only way to
    // log an admin into /console at all. No unprefixed /console variant:
    // the platform default org's identity provider already supports the
    // regular browser flow, so it has no need for this workaround.
    const consoleLoginMatch = path.match(/^\/([^/]+)\/console$/);
    if (consoleLoginMatch && request.method === 'GET') {
      return new Response(renderDevicePage('/console'), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    if (path === '/device/qrcode.js' && request.method === 'GET') {
      return new Response(QRCODE_BUNDLE_JS, {
        headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' },
      });
    }

    // Matches both /device/start and /:orgId/device/start.
    const startMatch = path.match(/^\/(?:([^/]+)\/)?device\/start$/);
    if (startMatch && request.method === 'POST') {
      const orgId = startMatch[1] || DEFAULT_ORG_ID;
      const device = await this.buildDeviceHandler(orgId);
      const result = await device.start(orgId);
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
