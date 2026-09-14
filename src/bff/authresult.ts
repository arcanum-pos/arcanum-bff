import type { Env, AuthResult, SessionData, NormalizedIdentity } from '../types';
import { isSessionData } from '../types';
import type { SessionStore } from './session';
import { isTokenExpiringSoon, refreshUserToken } from './refresh';
import { decodeJwtPayload } from './jwt';

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
      if (isTokenExpiringSoon(sessionData.expires_at, 30)) {
        const refreshed = await refreshUserToken(sessionData, sessionId, sessionStore, env);
        if (refreshed) {
          sessionData = await getSessionData(sessionStore, sessionId);
        } else {
          return { type: 'user', data: 'token refresh failed', token: '', authMethod: 'public' };
        }
      }

      if (validateSessionData(sessionData)) {
        const identity = extractIdentityFromSession(sessionData);
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

// Deliberately still scoped to the platform's one original Auth0 tenant
// only — the Bearer-token auth path, not the cookie-session path. No
// current caller presents a bearer token from an org-specific issuer; if
// that ever changes, this needs the same per-issuer resolution the
// session/device/login paths already have.
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
      issuer: `https://${env.AUTH0_DOMAIN}/`,
    };
  } catch {
    return null;
  }
}

// `roles` is always empty here: we never request an API-scoped access token
// (no `audience` param on login), so there is no `permissions` claim to read.
// Authorization (what a logged-in user is allowed to do) is handled by the
// app itself, not by the identity provider.
//
// `issuer` comes from the session itself (recorded once at /callback or
// /device/poll time, from whichever identity provider was actually
// resolved for that login) — never re-derived from the token's own `iss`
// claim, so a resolution bug can't quietly mislabel identity.
function extractIdentityFromSession(sessionData: SessionData): NormalizedIdentity | undefined {
  const token = sessionData.id_token ?? sessionData.access_token;
  const payload = decodeJwtPayload(token);
  if (!payload) return undefined;

  return {
    sub: (payload.sub as string) ?? '',
    email: (payload.email as string) ?? sessionData.email,
    name: (payload.name as string) ?? sessionData.name,
    firstName: (payload.given_name as string) ?? '',
    lastName: (payload.family_name as string) ?? '',
    username: (payload.nickname as string) ?? (payload.email as string) ?? sessionData.email,
    roles: [],
    issuer: sessionData.issuer,
  };
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
