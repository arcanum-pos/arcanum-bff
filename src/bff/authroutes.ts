import type { Env, SessionData, OAuthSettings } from '../types';
import { resolveIdpSettings } from './idp';
import type { SessionStore } from './session';
import { LOGIN_STATE_SECONDS, OAuthHandler } from './auth';
import { buildSessionCookie, clearSessionCookies, cookieValue, LOGIN_STATE_COOKIE, loginStateCookie, sessionIdFrom } from './cookie';

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
      issuerUrl: idp.issuerUrl,
      scope: idp.scope,
      endpoints: idp.endpoints,
    };
    return new OAuthHandler(this.env, settings);
  }

  async processAuthRoute(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/login') {
      return this.startLogin(sanitizeReturnTo(url.searchParams.get('returnTo')), request);
    }

    if (path === '/callback') {
      // The state cookie is used once, whatever happens.
      const headers = new Headers({ 'Set-Cookie': loginStateCookie(this.env, '', 0) });
      const stateCookie = cookieValue(request, LOGIN_STATE_COOKIE);
      const oauth = await this.buildOAuthHandler();
      const [userSessionData, error] = await oauth.callback(url.searchParams.get('code') ?? '', url.searchParams.get('state') ?? '', stateCookie);

      if (error || !userSessionData) {
        // The detail goes to the log, not to the browser.
        console.warn('Sign-in callback refused:', error ?? 'unknown');
        headers.set('Content-Type', 'application/json');
        return new Response(JSON.stringify({ error: 'Aanmelden is mislukt. Probeer opnieuw.' }), { status: 400, headers });
      }

      const returnTo = sanitizeReturnTo(await OAuthHandler.returnTo(this.env, stateCookie));
      const newSessionId = await this.sessionStore.create(userSessionData satisfies SessionData, this.env.SESSION_TTL);
      headers.append('Set-Cookie', buildSessionCookie(this.env, newSessionId));
      headers.set('Location', `${this.env.FRONTEND_URL}${returnTo}`);
      return new Response(null, { status: 302, headers });
    }

    if (path === '/logout') {
      // A link on another site can't sign anyone out (SameSite=Lax still
      // sends the cookie on a top-level navigation): only our own pages, or
      // the address typed or bookmarked.
      if (request.headers.get('Sec-Fetch-Site') === 'cross-site') {
        return new Response(null, { status: 302, headers: { Location: this.env.FRONTEND_URL } });
      }
      const sessionId = sessionIdFrom(request, this.env);
      const sessionData = sessionId ? ((await this.sessionStore.get(sessionId)) as SessionData | null) : null;
      if (sessionId) {
        await this.sessionStore.delete(sessionId);
      }

      const clearCookieHeaders = () => {
        const headers = new Headers();
        for (const cookie of clearSessionCookies(this.env)) headers.append('Set-Cookie', cookie);
        return headers;
      };

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
            const headers = clearCookieHeaders();
            headers.set('Location', logoutUrl.toString());
            return new Response(null, { status: 302, headers });
          }
        } catch (err) {
          console.error('Kon identity provider niet ophalen voor logout, val terug op lokaal uitloggen', err);
        }
      }

      const headers = clearCookieHeaders();
      headers.set('Location', this.env.FRONTEND_URL);
      return new Response(null, { status: 302, headers });
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

    const [authUrl, stateCookie] = await oauth.login(returnTo);
    return new Response(null, {
      status: 302,
      headers: { Location: authUrl, 'Set-Cookie': loginStateCookie(this.env, stateCookie, LOGIN_STATE_SECONDS) },
    });
  }

  private async checkRateLimit(request: Request): Promise<boolean> {
    if (!this.env.LOGIN_RATE_LIMITER) return true;
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await this.env.LOGIN_RATE_LIMITER.limit({ key: ip });
    return success;
  }

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
