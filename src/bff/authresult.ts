import type { Env, AuthResult, SessionData, NormalizedIdentity } from '../types';
import { isSessionData } from '../types';
import type { SessionStore } from './session';
import { isTokenExpiringSoon, refreshUserToken } from './refresh';
import { decodeJwtPayload, toEmailVerified } from './jwt';
import { sessionIdFrom } from './cookie';

export async function authresult(request: Request, env: Env, sessionStore: SessionStore): Promise<AuthResult> {
  const sessionId = sessionIdFrom(request, env);

  if (sessionId) {
    let sessionData = await getSessionData(sessionStore, sessionId);

    if (validateSessionData(sessionData)) {
      if (isTokenExpiringSoon(sessionData.expires_at, 30)) {
        const refreshed = await refreshUserToken(sessionData, sessionId, sessionStore, env);
        // Refused, or failed: maybe another request of this browser just
        // refreshed it (the kassa fires several at once) — then the session
        // in KV already holds the new tokens.
        const latest = await getSessionData(sessionStore, sessionId);
        const refreshedElsewhere = validateSessionData(latest) && latest.access_token !== sessionData.access_token && !isTokenExpiringSoon(latest.expires_at, 0);
        if (!refreshed && !refreshedElsewhere) {
          return { type: 'user', data: 'token refresh failed', token: '', authMethod: 'public' };
        }
        sessionData = latest;
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
    // The id_token's claim when it has one, else what userinfo said at login.
    emailVerified: toEmailVerified(payload.email_verified) ?? sessionData.email_verified,
  };
}

async function getSessionData(sessionStore: SessionStore, sessionId: string): Promise<SessionData | null> {
  const data = await sessionStore.get(sessionId);
  if (!data || typeof data !== 'object') return null;
  return isSessionData(data as SessionData) ? (data as SessionData) : null;
}

// email is NOT required here even though every other social connection
// happens to provide one — GitHub only returns an email when the user has a
// public/verified one and the connection requests the user:email scope,
// so a real, successfully-authenticated GitHub login can legitimately have
// no email at all (name can be blank too — GitHub only guarantees a
// username). Actual identity is (issuer, sub), extracted separately in
// extractIdentityFromSession; email/name are display-only from here on.
function validateSessionData(data: SessionData | null): data is SessionData {
  if (!data) return false;
  if (!data.access_token) {
    console.error('Session missing required fields');
    return false;
  }
  return true;
}
