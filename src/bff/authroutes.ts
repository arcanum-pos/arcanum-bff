import type { Env, SessionData } from '../types';
import { getOAuthEndpoints } from '../types';
import type { SessionStore } from './session';
import { OAuthHandler } from './auth';
import { buildSessionCookie } from './cookie';

export class AuthRoutesHandler {
  private oauth: OAuthHandler;

  constructor(private sessionStore: SessionStore, private env: Env) {
    this.oauth = new OAuthHandler(this.sessionStore, {
      OAUTH_CLIENT_ID: env.OAUTH_CLIENT_ID,
      OAUTH_CLIENT_SECRET: env.OAUTH_CLIENT_SECRET,
      FRONTEND_URL: env.FRONTEND_URL,
      REDIRECT_URI: `${env.FRONTEND_URL}/callback`,
      OAUTH_CONNECTION: env.OAUTH_CONNECTION,
      endpoints: getOAuthEndpoints(env),
    });
  }

  async processAuthRoute(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/login') {
      if (!(await this.checkRateLimit(request))) {
        return new Response('Te veel aanmeldpogingen. Probeer over een minuut opnieuw.', {
          status: 429,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }

      const [authUrl, state] = await this.oauth.login();
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
      const [userSessionData, error] = await this.oauth.callback(params.code ?? '', params.state ?? '');

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
      if (sessionId) {
        await this.sessionStore.delete(sessionId);
      }

      // Clearing our own session isn't enough — Auth0 keeps its own SSO session
      // cookie, so without this the next /login would silently re-authenticate
      // via that session instead of prompting again.
      const auth0LogoutUrl = new URL(`https://${this.env.AUTH0_DOMAIN}/v2/logout`);
      auth0LogoutUrl.searchParams.set('client_id', this.env.OAUTH_CLIENT_ID);
      auth0LogoutUrl.searchParams.set('returnTo', this.env.FRONTEND_URL);

      return new Response(null, {
        status: 302,
        headers: {
          Location: auth0LogoutUrl.toString(),
          'Set-Cookie': 'session_id=; Path=/; HttpOnly; Max-Age=0',
        },
      });
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
