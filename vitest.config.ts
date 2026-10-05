import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Stand-in for arcanum-installer: answers with exactly what it received, so
// a test can see what the BFF forwarded (and what it stripped).
async function echoInstaller(request: Request) {
  const url = new URL(request.url);
  return Response.json(
    {
      path: url.pathname,
      search: url.search,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: await request.text(),
    },
    { status: 299, headers: { 'Content-Security-Policy': "default-src 'none'", 'X-Installer': 'echo' } }
  );
}

// Stand-in for arcanum-frontends: every file is a tiny HTML page naming itself.
function frontends(request: Request) {
  const path = new URL(request.url).pathname;
  return new Response(`<html>frontends ${path}</html>`, { headers: { 'Content-Type': 'text/html' } });
}

const unused = () => Response.json({ error: 'not stubbed' }, { status: 500 });

// Stand-in for arcanum-backend: the instance's login provider on
// /identity-provider/resolve (with the BFF key only), anything else echoed
// back — so a test can see which path and identity headers it got.
const IDP = {
  issuerUrl: 'https://login.test',
  connectionName: null,
  scopes: null,
  endpoints: {
    authorization_endpoint: 'https://login.test/authorize',
    token_endpoint: 'https://login.test/token',
    userinfo_endpoint: 'https://login.test/userinfo',
    device_authorization_endpoint: 'https://login.test/device/code',
    end_session_endpoint: 'https://login.test/logout',
  },
};
async function backend(request: Request) {
  const url = new URL(request.url);
  if (url.pathname === '/identity-provider/resolve') {
    if (request.headers.get('Authorization') !== 'Bearer test-bff-key') return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const purpose = url.searchParams.get('purpose');
    return Response.json({ ...IDP, clientId: `${purpose}-client`, clientSecret: `${purpose}-secret` });
  }
  return Response.json({ echo: true, path: url.pathname, search: url.search, headers: Object.fromEntries(request.headers) });
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          // Test-only values. A developer's .dev.vars may point FRONTEND_URL
          // at localhost (= the HTTP dev path); pin production behaviour.
          FRONTEND_URL: 'https://arcanum.test',
          CONSOLE_LOCAL_URL: '',
          DEVICEHUB_LOCAL_URL: '',
          BANCONTACT_LOCAL_URL: '',
          BFF_INTERNAL_KEY: 'test-bff-key',
          // The instance's login provider (bff/idp.ts): the kassa's client,
          // and a separate browser client (as for Google).
          DEFAULT_IDP_ISSUER_URL: 'https://login.test',
          DEFAULT_IDP_CLIENT_ID: 'device-client',
          DEFAULT_IDP_CLIENT_SECRET: 'device-secret',
          DEFAULT_IDP_AUTH_CODE_CLIENT_ID: 'authcode-client',
          DEFAULT_IDP_AUTH_CODE_CLIENT_SECRET: 'authcode-secret',
          INSTALLER_INTERNAL_KEY: 'test-installer-key',
        },
        // The provider's discovery document (bff/idp.ts fetches it); nothing else leaves.
        outboundService: (request: Request) =>
          new URL(request.url).href === 'https://login.test/.well-known/openid-configuration'
            ? Response.json({ issuer: IDP.issuerUrl, ...IDP.endpoints })
            : new Response('no outbound in tests', { status: 502 }),
        serviceBindings: {
          ARCANUM_BACKEND_SERVICE: backend,
          ARCANUM_DEVICEHUB_SERVICE: unused,
          ARCANUM_FRONTENDS_SERVICE: frontends,
          ARCANUM_INSTALLER_SERVICE: echoInstaller,
        },
      },
    }),
  ],
});
