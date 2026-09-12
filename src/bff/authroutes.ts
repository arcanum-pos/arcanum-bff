import type { Env, SessionData } from '../types';
import { getOAuthEndpoints } from '../types';
import type { SessionStore } from './session';
import { OAuthHandler } from './auth';

export class AuthRoutesHandler {
  private oauth: OAuthHandler;

  constructor(private sessionStore: SessionStore, private env: Env) {
    this.oauth = new OAuthHandler(this.sessionStore, {
      OAUTH_CLIENT_ID: env.OAUTH_CLIENT_ID,
      OAUTH_CLIENT_SECRET: env.OAUTH_CLIENT_SECRET,
      FRONTEND_URL: env.FRONTEND_URL,
      REDIRECT_URI: `${env.FRONTEND_URL}/callback`,
      endpoints: getOAuthEndpoints(env),
    });
  }

  async processAuthRoute(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/login') {
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

      const newSessionId = await this.sessionStore.create(userSessionData satisfies SessionData, 604800);
      const isDevelopment = this.env.FRONTEND_URL?.includes('localhost') || this.env.FRONTEND_URL?.includes('127.0.0.1');

      const cookieBase = `session_id=${newSessionId}; Path=/; HttpOnly; Max-Age=604800`;
      const cookieValue = isDevelopment
        ? cookieBase
        : this.env.COOKIE_DOMAIN
          ? `${cookieBase}; Domain=${this.env.COOKIE_DOMAIN}; Secure; SameSite=None`
          : `${cookieBase}; Secure; SameSite=None`;

      return new Response(null, {
        status: 302,
        headers: { Location: this.env.FRONTEND_URL, 'Set-Cookie': cookieValue },
      });
    }

    if (path === '/logout') {
      const sessionId = extractSessionId(request);
      if (sessionId) {
        await this.sessionStore.delete(sessionId);
      }

      return new Response(null, {
        status: 302,
        headers: {
          Location: this.env.FRONTEND_URL,
          'Set-Cookie': 'session_id=; Path=/; HttpOnly; Max-Age=0',
        },
      });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
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
