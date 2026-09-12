export interface NormalizedIdentity {
  sub: string;
  email: string;
  name: string;
  firstName: string;
  lastName: string;
  username: string;
  roles: string[];
  provider: 'auth0';
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
  // Auth0 config (wrangler.jsonc vars)
  AUTH0_DOMAIN: string;
  SESSION_TTL: number;
  // Forces login straight to this Auth0 connection (e.g. an enterprise connection
  // like a Google Workspace connection), skipping Auth0's own connection picker.
  // Unset this to let Auth0 show its default picker again (e.g. once multiple
  // connections/orgs exist).
  OAUTH_CONNECTION?: string;
  // Secrets (.dev.vars / wrangler secret put)
  OAUTH_CLIENT_ID: string;
  OAUTH_CLIENT_SECRET: string;
  FRONTEND_URL: string;
  // Local `wrangler dev` HTTP fallbacks (set via .dev.vars only, unused in production
  // where service bindings are used instead)
  UIPROXY_URL?: string;
  BANCONTACT_LOCAL_URL?: string;
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
}

export interface PkceSessionData {
  codeVerifier: string;
  type: 'oauth_pkce';
}

export interface DevicePollSessionData {
  deviceCode: string;
  type: 'device_poll';
}

export interface OAuthEndpoints {
  authEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  deviceCodeEndpoint: string;
}

export interface OAuthSettings {
  OAUTH_CLIENT_ID: string;
  OAUTH_CLIENT_SECRET: string;
  FRONTEND_URL: string;
  REDIRECT_URI: string;
  OAUTH_CONNECTION?: string;
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

export function getOAuthEndpoints(env: Env): OAuthEndpoints {
  const domain = env.AUTH0_DOMAIN;
  return {
    authEndpoint: `https://${domain}/authorize`,
    tokenEndpoint: `https://${domain}/oauth/token`,
    userinfoEndpoint: `https://${domain}/userinfo`,
    deviceCodeEndpoint: `https://${domain}/oauth/device/code`,
  };
}
