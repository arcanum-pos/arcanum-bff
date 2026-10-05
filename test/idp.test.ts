// The login provider from the bff's own settings (DEFAULT_IDP_*, bff/idp.ts):
// endpoints from the provider's discovery document, the client secret never
// asked from arcanum-backend. Without them: the backend's resolve route.
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

const BASE = 'https://arcanum.test';
const OWN = {
  DEFAULT_IDP_ISSUER_URL: 'https://own-idp.test',
  DEFAULT_IDP_CLIENT_ID: 'own-device-client',
  DEFAULT_IDP_CLIENT_SECRET: 'own-device-secret',
  // No separate browser client unless a test sets one.
  DEFAULT_IDP_AUTH_CODE_CLIENT_ID: '',
  DEFAULT_IDP_AUTH_CODE_CLIENT_SECRET: '',
};

function call(path: string, overrides: Record<string, string> = {}, init?: RequestInit): Promise<Response> {
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const request = new Request(`${BASE}${path}`, { redirect: 'manual', ...init });
  request.headers.set('CF-Connecting-IP', `198.51.100.${Math.floor(Math.random() * 250)}-${crypto.randomUUID()}`);
  return worker.fetch(request, { ...env, ...overrides } as never, ctx);
}

// The provider: discovery, token, userinfo, device code. And who asked arcanum-backend.
function mockOwnProvider(discovery: Record<string, unknown> | null = {}) {
  const seen: { url: string; body?: string }[] = [];
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = request.url;
    if (url === 'https://own-idp.test/.well-known/openid-configuration') {
      seen.push({ url });
      if (discovery === null) return new Response('down', { status: 503 });
      return Response.json({
        issuer: 'https://own-idp.test',
        authorization_endpoint: 'https://own-idp.test/authorize',
        token_endpoint: 'https://own-idp.test/token',
        userinfo_endpoint: 'https://own-idp.test/userinfo',
        device_authorization_endpoint: 'https://own-idp.test/device/code',
        end_session_endpoint: 'https://own-idp.test/logout',
        ...discovery,
      });
    }
    if (url === 'https://own-idp.test/device/code' || url === 'https://own-idp.test/token') {
      seen.push({ url, body: await request.text() });
      return url.endsWith('/device/code')
        ? Response.json({ device_code: 'dc', user_code: 'WXYZ', verification_uri_complete: 'https://own-idp.test/device?user_code=WXYZ', expires_in: 600, interval: 5 })
        : Response.json({ error: 'authorization_pending' }, { status: 400 });
    }
    return realFetch(input, init);
  });
  return seen;
}
afterEach(() => vi.restoreAllMocks());

describe("the login provider from the bff's own settings", () => {
  it("/login goes to the discovered authorize endpoint with the bff's own client — the backend isn't asked", async () => {
    const seen = mockOwnProvider({ issuer: 'https://own-idp.test-unique-1' });
    const backend = vi.spyOn(env.ARCANUM_BACKEND_SERVICE, 'fetch');
    const res = await call('/login', { ...OWN, DEFAULT_IDP_ISSUER_URL: 'https://own-idp.test' });
    expect(res.status).toBe(302);
    const authorize = new URL(res.headers.get('Location')!);
    expect(`${authorize.origin}${authorize.pathname}`).toBe('https://own-idp.test/authorize');
    expect(authorize.searchParams.get('client_id')).toBe('own-device-client');
    expect(authorize.searchParams.get('scope')).toBe('openid profile email offline_access');
    expect(seen.some((s) => s.url.endsWith('/.well-known/openid-configuration'))).toBe(true);
    expect(backend).not.toHaveBeenCalled();
  });

  it('a separate browser client (Google) for /login, the main one for the device grant; scopes as set', async () => {
    const seen = mockOwnProvider();
    const google = { ...OWN, DEFAULT_IDP_AUTH_CODE_CLIENT_ID: 'web-client', DEFAULT_IDP_AUTH_CODE_CLIENT_SECRET: 'web-secret', DEFAULT_IDP_SCOPES: 'openid profile email' };
    const authorize = new URL((await call('/login', google)).headers.get('Location')!);
    expect(authorize.searchParams.get('client_id')).toBe('web-client');
    expect(authorize.searchParams.get('scope')).toBe('openid profile email');
    const started = await call('/device/start', google, { method: 'POST' });
    expect(started.status).toBe(200);
    const deviceCall = seen.find((s) => s.url === 'https://own-idp.test/device/code')!;
    expect(new URLSearchParams(deviceCall.body).get('client_id')).toBe('own-device-client');
  });

  it("a discovery document without a device endpoint, or a provider that's down: the login fails, it doesn't fall back", async () => {
    mockOwnProvider({ device_authorization_endpoint: undefined, issuer: 'x' });
    const noDevice = await call('/login', { ...OWN, DEFAULT_IDP_ISSUER_URL: 'https://own-idp.test/' });
    expect(noDevice.status).toBe(502);
    vi.restoreAllMocks();
    mockOwnProvider(null);
    const down = await call('/login', { ...OWN, DEFAULT_IDP_ISSUER_URL: 'https://own-idp.test//' });
    expect(down.status).toBe(502);
  });

  it('without them nobody can sign in — the backend is never asked for the client secret', async () => {
    const backend = vi.spyOn(env.ARCANUM_BACKEND_SERVICE, 'fetch');
    const res = await call('/login', { DEFAULT_IDP_ISSUER_URL: '', DEFAULT_IDP_CLIENT_ID: '', DEFAULT_IDP_CLIENT_SECRET: '' });
    expect(res.status).toBe(502);
    expect(backend).not.toHaveBeenCalled();
  });
});
