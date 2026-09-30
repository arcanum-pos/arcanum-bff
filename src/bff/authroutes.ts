import type { Env, SessionData, PkceSessionData, OAuthSettings } from '../types';
import { resolveIdpSettings } from '../types';
import type { SessionStore } from './session';
import { OAuthHandler } from './auth';
import { buildSessionCookie } from './cookie';

export class AuthRoutesHandler {
  constructor(private sessionStore: SessionStore, private env: Env) {}

  // An OAuthHandler for the instance's identity provider — always the
  // authorization-code client (device.ts is the device-grant counterpart).
  //
  // redirect_uri is always FRONTEND_URL/callback: an instance has exactly
  // one address registered at its login provider — the shared tenant's, an
  // own instance's workers.dev address, or the custom domain the installer
  // gave the instance (which then becomes FRONTEND_URL). Never derived from
  // the request's Host.
  private async buildOAuthHandler(): Promise<OAuthHandler> {
    const idp = await resolveIdpSettings(this.env, 'authcode');
    const settings: OAuthSettings = {
      OAUTH_CLIENT_ID: idp.clientId,
      OAUTH_CLIENT_SECRET: idp.clientSecret,
      FRONTEND_URL: this.env.FRONTEND_URL,
      REDIRECT_URI: `${this.env.FRONTEND_URL}/callback`,
      OAUTH_CONNECTION: idp.connectionName,
      issuerUrl: idp.issuerUrl,
      scope: idp.scope,
      endpoints: idp.endpoints,
    };
    return new OAuthHandler(this.sessionStore, settings);
  }

  // Where to land after /callback — stored in the PKCE session `state`
  // refers to at /login time; peeked here before oauth.callback() deletes it.
  private async peekReturnTo(state: string): Promise<string> {
    const data = (await this.sessionStore.get(state)) as PkceSessionData | null;
    return sanitizeReturnTo(data?.returnTo);
  }

  async processAuthRoute(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/login') {
      return this.startLogin(sanitizeReturnTo(url.searchParams.get('returnTo')), request);
    }

    if (path === '/callback') {
      const params = Object.fromEntries(url.searchParams.entries());
      const returnTo = await this.peekReturnTo(params.state ?? '');
      const oauth = await this.buildOAuthHandler();
      const [userSessionData, error] = await oauth.callback(params.code ?? '', params.state ?? '');

      if (error || !userSessionData) {
        return new Response(JSON.stringify({ error: error ?? 'Unknown error' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const newSessionId = await this.sessionStore.create(userSessionData satisfies SessionData, this.env.SESSION_TTL);
      const cookieHeaders = { 'Set-Cookie': buildSessionCookie(this.env, newSessionId) };

      return new Response(null, { status: 302, headers: { Location: `${this.env.FRONTEND_URL}${returnTo}`, ...cookieHeaders } });
    }

    if (path === '/logout') {
      const sessionId = extractSessionId(request);
      const sessionData = sessionId ? ((await this.sessionStore.get(sessionId)) as SessionData | null) : null;
      if (sessionId) {
        await this.sessionStore.delete(sessionId);
      }

      const clearCookieHeaders = { 'Set-Cookie': 'session_id=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' };

      // Clearing our own session isn't enough — the identity provider may
      // keep its own SSO session cookie, so without an upstream logout call
      // too, the next /login would silently re-authenticate via that
      // session instead of prompting again. Only possible if the provider
      // exposes end_session_endpoint (OIDC RP-Initiated Logout) — not every
      // provider does, so falling back to just clearing our own cookie is
      // the correct behavior, not a degraded one.
      if (sessionData) {
        try {
          const idp = await resolveIdpSettings(this.env, sessionData.authPurpose ?? 'authcode');
          if (idp.endpoints.endSessionEndpoint) {
            const logoutUrl = new URL(idp.endpoints.endSessionEndpoint);
            logoutUrl.searchParams.set('client_id', idp.clientId);
            // Both param names set: OIDC's RP-Initiated Logout spec calls it
            // post_logout_redirect_uri; Auth0's legacy /v2/logout (not used
            // here, but some providers may still expect it) calls it
            // returnTo. Unrecognized params are ignored, so this is safe
            // across providers rather than something to branch on.
            logoutUrl.searchParams.set('post_logout_redirect_uri', this.env.FRONTEND_URL);
            logoutUrl.searchParams.set('returnTo', this.env.FRONTEND_URL);
            if (sessionData.id_token) logoutUrl.searchParams.set('id_token_hint', sessionData.id_token);
            return new Response(null, { status: 302, headers: { Location: logoutUrl.toString(), ...clearCookieHeaders } });
          }
        } catch (err) {
          console.error('Kon identity provider niet ophalen voor logout, val terug op lokaal uitloggen', err);
        }
      }

      return new Response(null, { status: 302, headers: { Location: this.env.FRONTEND_URL, ...clearCookieHeaders } });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // /login[?returnTo=…] — the authorization-code flow.
  private async startLogin(returnTo: string, request: Request): Promise<Response> {
    if (!(await this.checkRateLimit(request))) {
      return new Response('Te veel aanmeldpogingen. Probeer over een minuut opnieuw.', {
        status: 429,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    const oauth = await this.buildOAuthHandler();

    const [authUrl, state] = await oauth.login(returnTo);
    return new Response(null, {
      status: 302,
      headers: {
        Location: authUrl,
        'Set-Cookie': `oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
      },
    });
  }

  private async checkRateLimit(request: Request): Promise<boolean> {
    if (!this.env.LOGIN_RATE_LIMITER) return true;
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await this.env.LOGIN_RATE_LIMITER.limit({ key: ip });
    return success;
  }

}

function extractSessionId(request: Request): string | null {
  const cookieHeader = request.headers.get('Cookie') ?? '';
  for (const cookie of cookieHeader.split(';')) {
    const [name, value] = cookie.trim().split('=');
    if (name === 'session_id') return value ?? null;
  }
  return null;
}

// /login?returnTo=... is a public, unauthenticated GET — this is the one
// place standing between an arbitrary query value and a 302 Location header
// built from it. Only an own-origin relative path is accepted (must start
// with a single '/', never '//' or contain '://', both of which a browser
// would treat as a different origin); anything else falls back to '' (the
// existing default: FRONTEND_URL alone, i.e. the root chooser).
function sanitizeReturnTo(value: string | null | undefined): string {
  if (!value) return '';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('://')) return '';
  return value;
}
