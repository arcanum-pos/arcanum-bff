import { callWorker } from './services/workerClient';

export interface NormalizedIdentity {
  sub: string;
  email: string;
  name: string;
  firstName: string;
  lastName: string;
  username: string;
  roles: string[];
  // Which issuer authenticated this identity — see worker's
  // memberships.issuer for why bare sub isn't enough once an org can bring
  // its own identity provider.
  issuer: string;
}

export interface Env {
  // KV namespaces
  QUESTO_SESSIONS: KVNamespace;
  // Caps PKCE-session KV writes per IP on /login — a temp KV session is created
  // there before any authentication happens, so without this, scanner/bot traffic
  // hitting /login burns through the Workers KV free-tier daily write quota.
  LOGIN_RATE_LIMITER?: RateLimit;
  // Service bindings
  WEBAPP_SERVICE: Fetcher;
  BANCONTACT_SERVICE: Fetcher;
  DEVICEHUB_SERVICE: Fetcher;
  // The admin portal (questo-admin, Vite/React/shadcn) — reached at /console.
  // Optional: unset in an environment that hasn't deployed it yet.
  CONSOLE_SERVICE?: Fetcher;
  // Still used by authresult.ts's Bearer-token auth path (validateAuth0Bearer)
  // — deliberately scoped to the platform's one original tenant only, not
  // yet multi-issuer-aware. Everything else (login, device, refresh,
  // logout) now resolves via resolveIdpSettings instead.
  AUTH0_DOMAIN: string;
  SESSION_TTL: number;
  OAUTH_CLIENT_ID: string;
  OAUTH_CLIENT_SECRET: string;
  FRONTEND_URL: string;
  // Authorizes calls to worker's internal-only identity-provider-resolution
  // route (see services/workerClient.ts) — must match worker's own
  // BFF_INTERNAL_KEY secret. Deliberately separate from worker's own
  // INTERNAL_API_KEY (which authorizes its calls to questo-devicehub) —
  // a different pairwise relationship, independently rotatable.
  BFF_INTERNAL_KEY: string;
  // Local `wrangler dev` HTTP fallbacks (set via .dev.vars only, unused in production
  // where service bindings are used instead)
  UIPROXY_URL?: string;
  BANCONTACT_LOCAL_URL?: string;
  DEVICEHUB_LOCAL_URL?: string;
  CONSOLE_LOCAL_URL?: string;
  // Optional cookie domain, e.g. ".example.com", only needed if the BFF and another
  // subdomain need to share a session cookie
  COOKIE_DOMAIN?: string;
  // Comma-separated extra CORS origins beyond FRONTEND_URL (only relevant for local dev,
  // since in production the UI and API are same-origin behind this BFF)
  ALLOWED_ORIGINS?: string;
  GIT_COMMIT_SHA?: string;
  CF_VERSION_METADATA?: {
    id: string;
    tag: string;
    timestamp: string;
  };
}

export interface SessionData {
  access_token: string;
  id_token?: string;
  refresh_token: string | null;
  email: string;
  name: string;
  expires_at: number;
  // Which org's identity provider authenticated this session ('default'
  // until per-org routing exists), and that provider's real issuer URL —
  // recorded once at /callback or /device/poll time, never re-derived from
  // a token afterward. Needed to resolve the right settings again later
  // (refresh, logout) and to forward X-User-Issuer to worker.
  orgId: string;
  issuer: string;
}

export interface PkceSessionData {
  codeVerifier: string;
  type: 'oauth_pkce';
  orgId: string;
}

export interface DevicePollSessionData {
  deviceCode: string;
  type: 'device_poll';
  orgId: string;
}

export interface OAuthEndpoints {
  authEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  deviceCodeEndpoint: string;
  endSessionEndpoint?: string;
}

export interface OAuthSettings {
  OAUTH_CLIENT_ID: string;
  OAUTH_CLIENT_SECRET: string;
  FRONTEND_URL: string;
  REDIRECT_URI: string;
  OAUTH_CONNECTION?: string;
  issuerUrl: string;
  scope?: string;
  endpoints: OAuthEndpoints;
}

export type RewritePath = string | { from: string; to: string } | null;

export interface AuthResult {
  type: 'machine' | 'user';
  data: SessionData | NormalizedIdentity | string;
  token: string;
  authMethod: 'bearer' | 'session' | 'public';
  identity?: NormalizedIdentity;
}

export function isSessionData(data: SessionData | NormalizedIdentity | string): data is SessionData {
  return typeof data === 'object' && 'access_token' in data;
}

// What questo-bff needs to actually drive a login for one org: that org's
// own configured identity provider if it has one, otherwise the platform
// default's (resolved by worker — see worker/src/organizations/
// identity-providers.ts resolveIdentityProviderForAuth). No discovery fetch
// happens here: worker already resolved and persisted the endpoints at
// admin-save time, so this is just a service-binding round trip.
export interface IdpSettings {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  connectionName?: string;
  scope?: string;
  endpoints: OAuthEndpoints;
}

export async function resolveIdpSettings(orgId: string, env: Env): Promise<IdpSettings> {
  const res = await callWorker(env, `/organizations/${encodeURIComponent(orgId)}/identity-provider/resolve`);
  if (!res.ok) {
    throw new Error(`Failed to resolve identity provider for org '${orgId}': ${res.status}`);
  }

  const data = (await res.json()) as {
    issuerUrl: string;
    clientId: string;
    clientSecret: string;
    connectionName: string | null;
    scopes: string | null;
    endpoints: {
      authorization_endpoint: string;
      token_endpoint: string;
      userinfo_endpoint: string;
      device_authorization_endpoint: string;
      end_session_endpoint: string | null;
    };
  };

  return {
    issuerUrl: data.issuerUrl,
    clientId: data.clientId,
    clientSecret: data.clientSecret,
    connectionName: data.connectionName ?? undefined,
    scope: data.scopes ?? undefined,
    endpoints: {
      authEndpoint: data.endpoints.authorization_endpoint,
      tokenEndpoint: data.endpoints.token_endpoint,
      userinfoEndpoint: data.endpoints.userinfo_endpoint,
      deviceCodeEndpoint: data.endpoints.device_authorization_endpoint,
      endSessionEndpoint: data.endpoints.end_session_endpoint ?? undefined,
    },
  };
}
