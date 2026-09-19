import type { Env, SessionData, PkceSessionData, OAuthSettings } from '../types';
import { resolveIdpSettings } from '../types';
import type { SessionStore } from './session';
import { OAuthHandler } from './auth';
import { buildSessionCookie } from './cookie';

const DEFAULT_ORG_ID = 'default';

export class AuthRoutesHandler {
  constructor(private sessionStore: SessionStore, private env: Env) {}

  // Builds an OAuthHandler for a specific org's resolved identity provider
  // — replaces what used to be a single handler built once from this
  // Worker's own hardcoded Auth0 vars.
  private async buildOAuthHandler(orgId: string): Promise<OAuthHandler> {
    const idp = await resolveIdpSettings(orgId, this.env);
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

  // /callback doesn't know which org a given login attempt was for except
  // by reading it back out of the PKCE session `state` refers to — so peek
  // at it here, before building the handler that will redo that same
  // lookup (and delete it) inside oauth.callback().
  private async peekPkceOrgId(state: string): Promise<string> {
    const data = (await this.sessionStore.get(state)) as PkceSessionData | null;
    return data?.orgId || DEFAULT_ORG_ID;
  }

  async processAuthRoute(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Matches both /login (group 1 undefined -> DEFAULT_ORG_ID) and
    // /:orgId/login.
    const loginMatch = path.match(/^\/(?:([^/]+)\/)?login$/);
    if (loginMatch) {
      if (!(await this.checkRateLimit(request))) {
        return new Response('Te veel aanmeldpogingen. Probeer over een minuut opnieuw.', {
          status: 429,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }

      const orgId = loginMatch[1] || DEFAULT_ORG_ID;
      const oauth = await this.buildOAuthHandler(orgId);
      const [authUrl, state] = await oauth.login(orgId);
      return new Response(null, {
        status: 302,
        headers: {
          Location: authUrl,
          'Set-Cookie': `oauth_state=${state}; Path=/; HttpOnly; Max-Age=600`,
        },
      });
    }

    if (path === '/callback') {
      const params = Object.fromEntries(url.searchParams.entries());
      const orgId = await this.peekPkceOrgId(params.state ?? '');
      const oauth = await this.buildOAuthHandler(orgId);
      const [userSessionData, error] = await oauth.callback(params.code ?? '', params.state ?? '');

      if (error || !userSessionData) {
        return new Response(JSON.stringify({ error: error ?? 'Unknown error' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const newSessionId = await this.sessionStore.create(userSessionData satisfies SessionData, this.env.SESSION_TTL);

      return new Response(null, {
        status: 302,
        headers: { Location: this.env.FRONTEND_URL, 'Set-Cookie': buildSessionCookie(this.env, newSessionId) },
      });
    }

    if (path === '/logout') {
      const sessionId = extractSessionId(request);
      const sessionData = sessionId ? ((await this.sessionStore.get(sessionId)) as SessionData | null) : null;
      if (sessionId) {
        await this.sessionStore.delete(sessionId);
      }

      const clearCookieHeaders = { 'Set-Cookie': 'session_id=; Path=/; HttpOnly; Max-Age=0' };

      // Clearing our own session isn't enough — the identity provider may
      // keep its own SSO session cookie, so without an upstream logout call
      // too, the next /login would silently re-authenticate via that
      // session instead of prompting again. Only possible if the provider
      // exposes end_session_endpoint (OIDC RP-Initiated Logout) — not every
      // provider does, so falling back to just clearing our own cookie is
      // the correct behavior, not a degraded one.
      if (sessionData?.orgId) {
        try {
          const idp = await resolveIdpSettings(sessionData.orgId, this.env);
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
