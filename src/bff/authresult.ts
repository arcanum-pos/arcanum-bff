import type { Env, AuthResult, SessionData, NormalizedIdentity } from '../types';
import { isSessionData } from '../types';
import type { SessionStore } from './session';
import { isTokenExpiringSoon, refreshUserToken } from './refresh';

export async function authresult(request: Request, env: Env, sessionStore: SessionStore): Promise<AuthResult> {
  const bearerToken = extractBearerToken(request);
  const sessionId = extractSessionId(request);

  if (bearerToken) {
    const identity = await validateAuth0Bearer(bearerToken, env);
    if (!identity) {
      return { type: 'machine', data: 'token invalid', token: '', authMethod: 'bearer' };
    }
    return { type: 'machine', data: identity, token: bearerToken, authMethod: 'bearer', identity };
  }

  if (sessionId) {
    let sessionData = await getSessionData(sessionStore, sessionId);

    if (validateSessionData(sessionData)) {
      if (isTokenExpiringSoon(sessionData.access_token, 30)) {
        const refreshed = await refreshUserToken(sessionData, sessionId, sessionStore, env);
        if (refreshed) {
          sessionData = await getSessionData(sessionStore, sessionId);
        } else {
          return { type: 'user', data: 'token refresh failed', token: '', authMethod: 'public' };
        }
      }

      if (validateSessionData(sessionData)) {
        const identity = extractAuth0IdentityFromToken(sessionData.id_token ?? sessionData.access_token);
        return {
          type: 'user',
          data: sessionData,
          token: sessionData.access_token,
          authMethod: 'session',
          identity,
        };
      }
    }
  }

  return { type: 'user', data: '', token: '', authMethod: 'public' };
}

async function validateAuth0Bearer(token: string, env: Env): Promise<NormalizedIdentity | null> {
  try {
    const response = await fetch(`https://${env.AUTH0_DOMAIN}/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;

    const userInfo = (await response.json()) as Record<string, unknown>;
    return {
      sub: (userInfo.sub as string) ?? '',
      email: (userInfo.email as string) ?? '',
      name: (userInfo.name as string) ?? '',
      firstName: (userInfo.given_name as string) ?? '',
      lastName: (userInfo.family_name as string) ?? '',
      username: (userInfo.nickname as string) ?? (userInfo.email as string) ?? '',
      roles: [],
      provider: 'auth0',
    };
  } catch {
    return null;
  }
}

// `roles` is always empty here: we never request an Auth0-API-scoped access token
// (no `audience` param on login), so there is no `permissions` claim to read. Authorization
// (what a logged-in user is allowed to do) is handled by the app itself, not by Auth0.
function extractAuth0IdentityFromToken(token: string): NormalizedIdentity | undefined {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return undefined;

    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(base64)) as Record<string, unknown>;

    return {
      sub: (payload.sub as string) ?? '',
      email: (payload.email as string) ?? '',
      name: (payload.name as string) ?? '',
      firstName: (payload.given_name as string) ?? '',
      lastName: (payload.family_name as string) ?? '',
      username: (payload.nickname as string) ?? (payload.email as string) ?? '',
      roles: [],
      provider: 'auth0',
    };
  } catch {
    return undefined;
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

async function getSessionData(sessionStore: SessionStore, sessionId: string): Promise<SessionData | null> {
  const data = await sessionStore.get(sessionId);
  if (!data || typeof data !== 'object') return null;
  return isSessionData(data as SessionData) ? (data as SessionData) : null;
}

function validateSessionData(data: SessionData | null): data is SessionData {
  if (!data) return false;
  if (!data.access_token || !data.email) {
    console.error('Session missing required fields');
    return false;
  }
  return true;
}

function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return null;
  const [scheme, token] = authHeader.split(' ');
  return scheme === 'Bearer' && token ? token : null;
}
