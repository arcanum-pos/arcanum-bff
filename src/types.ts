import { callWorker } from './services/workerClient';

export interface NormalizedIdentity {
  sub: string;
  email: string;
  name: string;
  firstName: string;
  lastName: string;
  username: string;
  roles: string[];
  // Which issuer authenticated this identity — see arcanum-backend's
  // memberships.issuer for why bare sub isn't enough.
  issuer: string;
  // The provider's `email_verified` claim; undefined when it sent none.
  // Forwarded as X-User-Email-Verified — the backend never activates a
  // pending invite on an e-mail marked unverified.
  emailVerified?: boolean;
}

export interface Env {
  // KV namespaces
  ARCANUM_SESSIONS: KVNamespace;
  // Caps PKCE-session KV writes per IP on /login — a temp KV session is created
  // there before any authentication happens, so without this, scanner/bot traffic
  // hitting /login burns through the Workers KV free-tier daily write quota.
  LOGIN_RATE_LIMITER?: RateLimit;
  // Service bindings
  ARCANUM_BACKEND_SERVICE: Fetcher;
  ARCANUM_DEVICEHUB_SERVICE: Fetcher;
  // Every UI screen (admin portal, kassa, settings, the customer display, the
  // SumUp simulator, the org/device chooser, the login prompt, the
  // device-grant QR page) — reached at /console and a handful of other
  // explicit paths, see index.ts. Optional: unset in an environment that
  // hasn't deployed it yet.
  ARCANUM_FRONTENDS_SERVICE?: Fetcher;
  // arcanum-installer, at /installer/* (bff/installer.ts). Self-hosted
  // installations only: arcanum-installer adds both when it uploads this
  // Worker — deliberately not in wrangler.jsonc, where a binding to a
  // Worker that doesn't exist would break the deploy. The key proves to
  // the installer that the identity headers come from this BFF.
  ARCANUM_INSTALLER_SERVICE?: Fetcher;
  INSTALLER_INTERNAL_KEY?: string;
  SESSION_TTL: number;
  // No OAUTH_CLIENT_ID/SECRET here anymore: every login flow gets its client
  // credentials from arcanum-backend's resolved identity provider.
  FRONTEND_URL: string;
  // Source code of what this installation runs (AGPL-3.0 §13), shown as the
  // app's "Broncode" link. Unset = the upstream repos.
  SOURCE_URL?: string;
  // The Arcanum release this installation runs (e.g. "0.1.4") — set by
  // arcanum-installer; unset when deployed straight from the repos (main).
  ARCANUM_VERSION?: string;
  // Authorizes calls to worker's internal-only identity-provider-resolution
  // route (see services/workerClient.ts) — must match worker's own
  // BFF_INTERNAL_KEY secret. Deliberately separate from worker's own
  // INTERNAL_API_KEY (which authorizes its calls to arcanum-devicehub) —
  // a different pairwise relationship, independently rotatable.
  BFF_INTERNAL_KEY: string;
  // Local `wrangler dev` HTTP fallbacks (set via .dev.vars only, unused in production
  // where service bindings are used instead)
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
  // userinfo's `email_verified` at login, when the provider sent one — the
  // fallback when the id_token doesn't carry the claim (authresult.ts).
  email_verified?: boolean;
  // The instance's issuer URL at login — recorded once at /callback or
  // /device/poll time, never re-derived from a token afterward; forwarded as
  // X-User-Issuer. (Sessions from before hosting-plan phase 6 also carry an
  // `orgId` — no longer read.)
  issuer: string;
  // Which OAuth client actually issued this token — 'authcode' (/callback)
  // or 'device' (/device/poll). A provider that requires a separate client
  // per flow (see identity-providers.ts's auth_code_client_id override)
  // will reject a refresh_token grant presented with the wrong client_id/
  // secret, so refresh.ts must resolve the same purpose the session was
  // actually created with, not always 'authcode'.
  authPurpose: 'device' | 'authcode';
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

// Who a request is: a browser session, or nobody ('public'). There is no
// bearer-token way in — it accepted any token the login provider's
// /userinfo took, also one issued to another installation's client.
export interface AuthResult {
  type: 'user';
  data: SessionData | NormalizedIdentity | string;
  token: string;
  authMethod: 'session' | 'public';
  identity?: NormalizedIdentity;
}

export function isSessionData(data: SessionData | NormalizedIdentity | string): data is SessionData {
  return typeof data === 'object' && 'access_token' in data;
}

// What arcanum-bff needs to drive a login: the instance's identity provider
// (arcanum-backend's `default` identity_providers row — one per
// installation, for every org; see its organizations/identity-providers.ts).
// No discovery fetch happens here: the backend resolved and persisted the
// endpoints when it seeded the row, so this is just a service-binding round
// trip. The browser always comes back to FRONTEND_URL (/callback), whatever
// hostname it started on.
export interface IdpSettings {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  connectionName?: string;
  scope?: string;
  endpoints: OAuthEndpoints;
}

// GET /identity-provider/resolve?purpose=… on arcanum-backend (BFF_INTERNAL_KEY).
// `purpose` picks the OAuth client — 'authcode' for the browser flow
// (/login), 'device' for the device grant (/device). Some providers (Google)
// require a separate client per flow; the backend resolves the actual
// override, this just says which one it wants.
export async function resolveIdpSettings(env: Env, purpose: 'device' | 'authcode'): Promise<IdpSettings> {
  const res = await callWorker(env, `/identity-provider/resolve?purpose=${purpose}`);
  if (!res.ok) {
    throw new Error(`Failed to resolve the identity provider: ${res.status}`);
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
