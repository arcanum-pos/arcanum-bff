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
          INSTALLER_INTERNAL_KEY: 'test-installer-key',
        },
        serviceBindings: {
          ARCANUM_BACKEND_SERVICE: unused,
          ARCANUM_DEVICEHUB_SERVICE: unused,
          ARCANUM_FRONTENDS_SERVICE: frontends,
          ARCANUM_INSTALLER_SERVICE: echoInstaller,
        },
      },
    }),
  ],
});
