import type { Env, SessionData, PkceSessionData, OAuthSettings, IdpSettings } from '../types';
import { resolveIdpSettings } from '../types';
import type { SessionStore } from './session';
import { OAuthHandler } from './auth';
import { buildSessionCookie } from './cookie';

const DEFAULT_ORG_ID = 'default';

export class AuthRoutesHandler {
  constructor(private sessionStore: SessionStore, private env: Env) {}

  // Builds an OAuthHandler for a specific org's resolved identity provider
  // — replaces what used to be a single handler built once from this
  // Worker's own hardcoded Auth0 vars. Always the authorization-code client
  // — this class only ever drives that flow (device.ts is the device-grant
  // counterpart).
  //
  // redirect_uri is dynamic: an org with its OWN IdP client and its own
  // custom domain gets `https://<that domain>/callback` — safe only because
  // *that org* controls what's registered as an allowed callback on *their*
  // client. The shared/default IdP has exactly one registered callback and
  // can never vary per org, so isOwnIdp being false always keeps the fixed
  // FRONTEND_URL one, however this was reached. (worker enforces that a
  // custom domain always implies an org's own complete IdP config — see
  // custom-domain.ts's setCustomDomain — so in practice `idp.customDomain`
  // alone already implies `idp.isOwnIdp`; both are still checked here as
  // cheap defense in depth.)
  private async buildOAuthHandler(orgIdentifier: string): Promise<{ oauth: OAuthHandler; idp: IdpSettings }> {
    const idp = await resolveIdpSettings(orgIdentifier, this.env, 'authcode');
    const redirectUri = idp.isOwnIdp && idp.customDomain ? `https://${idp.customDomain}/callback` : `${this.env.FRONTEND_URL}/callback`;
    const settings: OAuthSettings = {
      OAUTH_CLIENT_ID: idp.clientId,
      OAUTH_CLIENT_SECRET: idp.clientSecret,
      FRONTEND_URL: this.env.FRONTEND_URL,
      REDIRECT_URI: redirectUri,
      OAUTH_CONNECTION: idp.connectionName,
      issuerUrl: idp.issuerUrl,
      scope: idp.scope,
      endpoints: idp.endpoints,
    };
    return { oauth: new OAuthHandler(this.sessionStore, settings), idp };
  }

  // /callback doesn't know which org (or intended destination) a given
  // login attempt was for except by reading it back out of the PKCE session
  // `state` refers to — so peek at it here, before building the handler
  // that will redo that same lookup (and delete it) inside oauth.callback().
  private async peekPkceSession(state: string): Promise<{ orgId: string; returnTo: string }> {
    const data = (await this.sessionStore.get(state)) as PkceSessionData | null;
    return { orgId: data?.orgId || DEFAULT_ORG_ID, returnTo: sanitizeReturnTo(data?.returnTo) };
  }

  async processAuthRoute(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Matches both /login and /:orgId/login. For the unprefixed form, try
    // the request's own Host header before falling back to the literal
    // DEFAULT_ORG_ID — this is what lets a custom domain log in with no org
    // identifier in the URL at all (see organizations.ts's resolveOrgId on
    // the worker side).
    const loginMatch = path.match(/^\/(?:([^/]+)\/)?login$/);
    if (loginMatch) {
      const orgIdentifier = loginMatch[1] || request.headers.get('Host') || DEFAULT_ORG_ID;
      const returnTo = sanitizeReturnTo(url.searchParams.get('returnTo'));
      return this.startLogin(orgIdentifier, returnTo, request);
    }

    // /:orgId/console: the authorization-code flow's counterpart to
    // /:orgId/device — same login, always landing on /console. No
    // unprefixed /console variant: that's the actual admin app itself
    // (handled in index.ts, never reaching AuthRoutesHandler).
    const consoleLoginMatch = path.match(/^\/([^/]+)\/console$/);
    if (consoleLoginMatch) {
      return this.startLogin(consoleLoginMatch[1], '/console', request);
    }

    if (path === '/callback') {
      const params = Object.fromEntries(url.searchParams.entries());
      const { orgId, returnTo } = await this.peekPkceSession(params.state ?? '');
      const { oauth, idp } = await this.buildOAuthHandler(orgId);
      const [userSessionData, error] = await oauth.callback(params.code ?? '', params.state ?? '');

      if (error || !userSessionData) {
        return new Response(JSON.stringify({ error: error ?? 'Unknown error' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const newSessionId = await this.sessionStore.create(userSessionData satisfies SessionData, this.env.SESSION_TTL);
      const cookieHeaders = { 'Set-Cookie': buildSessionCookie(this.env, newSessionId) };

      // This org has its own IdP client and its own custom domain —
      // redirect_uri was already that domain (see buildOAuthHandler), so
      // this callback IS being served there; finish normally with an
      // absolute URL for clarity. Otherwise (shared/default IdP, no custom
      // domain involved), land on FRONTEND_URL as always.
      const location =
        idp.isOwnIdp && idp.customDomain ? `https://${idp.customDomain}${returnTo}` : `${this.env.FRONTEND_URL}${returnTo}`;

      return new Response(null, { status: 302, headers: { Location: location, ...cookieHeaders } });
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
          const idp = await resolveIdpSettings(sessionData.orgId, this.env, sessionData.authPurpose ?? 'authcode');
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

  // Shared by /login, /:orgId/login, and /:orgId/console — all three start
  // the exact same authorization-code flow, differing only in which org and
  // where the browser lands afterward. `orgIdentifier` may be a real id, or
  // (for the unprefixed paths) the request's own Host header —
  // buildOAuthHandler resolves whichever it is and hands back the real id.
  private async startLogin(orgIdentifier: string, returnTo: string, request: Request): Promise<Response> {
    if (!(await this.checkRateLimit(request))) {
      return new Response('Te veel aanmeldpogingen. Probeer over een minuut opnieuw.', {
        status: 429,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    const { oauth, idp } = await this.buildOAuthHandler(orgIdentifier);

    const [authUrl, state] = await oauth.login(idp.orgId, returnTo);
    return new Response(null, {
      status: 302,
      headers: {
        Location: authUrl,
        'Set-Cookie': `oauth_state=${state}; Path=/; HttpOnly; Max-Age=600`,
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
