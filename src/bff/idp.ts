import type { Env, IdpSettings } from '../types';

// The instance's login provider — one per installation, for every org.
//
// Its settings are the bff's own (DEFAULT_IDP_*, set by the installer, the
// same values arcanum-backend gets): the client secret never crosses an API.
// The endpoints come from the provider's discovery document, fetched here
// and kept per isolate for an hour.
//
// `purpose` picks the OAuth client — 'authcode' for the browser flow
// (/login), 'device' for the device grant (/device). Some providers (Google)
// need a separate client per flow: DEFAULT_IDP_AUTH_CODE_CLIENT_ID/SECRET,
// used for 'authcode' only when both are set.
//
// Without DEFAULT_IDP_* nobody can sign in (the installer always sets them;
// the backend no longer hands the client secret out).

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const discoveryCache = new Map<string, { at: number; endpoints: IdpSettings['endpoints'] }>();

export async function discoverEndpoints(issuerUrl: string): Promise<IdpSettings['endpoints']> {
  const cached = discoveryCache.get(issuerUrl);
  if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.endpoints;
  const res = await fetch(`${issuerUrl.replace(/\/+$/, '')}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`The login provider's discovery document answered ${res.status}`);
  const doc = (await res.json()) as Record<string, unknown>;
  const text = (key: string) => (typeof doc[key] === 'string' ? (doc[key] as string) : undefined);
  const endpoints = {
    authEndpoint: text('authorization_endpoint'),
    tokenEndpoint: text('token_endpoint'),
    userinfoEndpoint: text('userinfo_endpoint'),
    deviceCodeEndpoint: text('device_authorization_endpoint'),
    endSessionEndpoint: text('end_session_endpoint'),
  };
  if (!endpoints.authEndpoint || !endpoints.tokenEndpoint || !endpoints.userinfoEndpoint || !endpoints.deviceCodeEndpoint) {
    throw new Error("The login provider's discovery document lacks a required endpoint (authorization, token, userinfo or device authorization)");
  }
  const complete = endpoints as IdpSettings['endpoints'];
  discoveryCache.set(issuerUrl, { at: Date.now(), endpoints: complete });
  return complete;
}

export function hasOwnIdpSettings(env: Env): boolean {
  return Boolean(env.DEFAULT_IDP_ISSUER_URL && env.DEFAULT_IDP_CLIENT_ID && env.DEFAULT_IDP_CLIENT_SECRET);
}

export async function resolveIdpSettings(env: Env, purpose: 'device' | 'authcode'): Promise<IdpSettings> {
  if (!hasOwnIdpSettings(env)) throw new Error('The login provider is not configured (DEFAULT_IDP_ISSUER_URL, DEFAULT_IDP_CLIENT_ID, DEFAULT_IDP_CLIENT_SECRET)');
  const authCode = purpose === 'authcode' && env.DEFAULT_IDP_AUTH_CODE_CLIENT_ID && env.DEFAULT_IDP_AUTH_CODE_CLIENT_SECRET;
  return {
    issuerUrl: env.DEFAULT_IDP_ISSUER_URL!,
    clientId: authCode ? env.DEFAULT_IDP_AUTH_CODE_CLIENT_ID! : env.DEFAULT_IDP_CLIENT_ID!,
    clientSecret: authCode ? env.DEFAULT_IDP_AUTH_CODE_CLIENT_SECRET! : env.DEFAULT_IDP_CLIENT_SECRET!,
    scope: env.DEFAULT_IDP_SCOPES?.trim() || undefined,
    endpoints: await discoverEndpoints(env.DEFAULT_IDP_ISSUER_URL!),
  };
}
