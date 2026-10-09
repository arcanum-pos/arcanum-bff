# arcanum-bff


Backend-for-frontend for the Arcanum platform. Single front door on
`demo.arcanum.kaboutersoft.be` (or an own instance's address): handles login
against the instance's identity provider — one per installation, for every
org, resolved from arcanum-backend's `GET /identity-provider/resolve` — then
proxies everything else to the
platform's other Workers via service bindings, so none of them need to be
publicly reachable.

```
Browser
  └─ demo.arcanum.kaboutersoft.be/*  → arcanum-bff
       ├─ /login /callback /logout /device*   → the instance's identity provider
       ├─ /whoami                             → current session identity
       ├─ /devices/connect                    → service binding → arcanum-devicehub
       │    (the notification WebSocket — public/no-session, see index.ts)
       ├─ /api/bancontact/* /api/organizations/* /api/callback/*  (see
       │    src/routes/router.ts)             → service binding → arcanum-backend
       ├─ /api/devices/*                      → service binding → arcanum-devicehub
       └─ /console, /, /kassa.html, /settings.html, /device,
            /display.html, and every arcanum-frontends asset  (auth'd, except
            /device*, /devices/connect, and the login prompt itself)
                                               → service binding → arcanum-frontends
```

Every screen *and* the notification channel are same-origin, so nothing
here is tied to `demo.arcanum.kaboutersoft.be` specifically: an own instance runs
on its workers.dev address or on the custom domain its installer attached.
Login always redirects back to `FRONTEND_URL/callback` (the one address
registered at the provider) — there is no per-org custom domain or per-org
identity provider anymore (hosting plan phase 6). The bff forwards the
caller's identity to the backend as `X-User-Sub`, `X-User-Issuer`,
`X-User-Email`, `X-User-Name` and `X-User-Email-Verified` (`true`/`false`
from the provider's `email_verified` claim; absent when it sent none).

Service bindings (see `wrangler.jsonc`):
- `ARCANUM_BACKEND_SERVICE` → `arcanum-backend` (payments, organizations/admin
  API, provider callbacks)
- `ARCANUM_DEVICEHUB_SERVICE` → `arcanum-devicehub` (device registration/
  linking, and the notification WebSocket itself — forwarded through this BFF
  rather than a separate arcanum-devicehub hostname, so it follows whichever
  domain the browser is on)
- `ARCANUM_FRONTENDS_SERVICE` → `arcanum-frontends` (every UI screen)
- `ARCANUM_INSTALLER_SERVICE` → `arcanum-installer`, at `/installer/*`
  (signed-in only; the installer checks its own admin allowlist). Self-hosted
  installations only: arcanum-installer adds this binding and the
  `INSTALLER_INTERNAL_KEY` secret when it uploads this Worker — not in
  `wrangler.jsonc`. Without both, `/installer` is a 404.

No Auth0 `audience` / API scopes requested — this app doesn't use Auth0 for
authorization, only authentication. Authorization (who can do what) is the
app's own concern, resolved per-org from the `memberships` table.

## One-time setup

### 1. Auth0

In your Auth0 tenant:

1. Create an Application → type **Regular Web Application**.
2. Enable whichever connection(s) you want as the platform default.
3. Allowed Callback URLs: `https://demo.arcanum.kaboutersoft.be/callback`
   (add `http://localhost:8787/callback` too if you'll test locally).
4. Allowed Logout URLs: `https://demo.arcanum.kaboutersoft.be`
5. Copy the Client ID and Client Secret — you'll need them below.
6. Do **not** create an Auth0 API for this. Authorization stays in the app.

### 2. Install dependencies

```bash
npm install
```

### 3. Create the sessions KV namespace

```bash
npx wrangler kv namespace create ARCANUM_SESSIONS
```

This prints an `id`. Put it into `wrangler.jsonc`'s `kv_namespaces` entry.

### 4. Set secrets

```bash
npx wrangler secret put BFF_INTERNAL_KEY
```

The BFF derives two keys of its own from `BFF_INTERNAL_KEY` (HKDF,
`src/bff/crypto.ts`): one signs the short-lived values a browser carries
during a login, one encrypts sessions at rest. Rotating it therefore also
ends every session. The login provider is the BFF's own settings too:
`DEFAULT_IDP_ISSUER_URL`, `DEFAULT_IDP_CLIENT_ID`, `DEFAULT_IDP_CLIENT_SECRET`
(+ optional `DEFAULT_IDP_SCOPES`,
`DEFAULT_IDP_AUTH_CODE_CLIENT_ID/SECRET`) — the installer sets them; the
endpoints come from the provider's discovery document.

### 5. Service bindings — deploy order matters

`wrangler.jsonc`'s three service bindings are by Worker name — each target
Worker must already be deployed under its exact name before this Worker's
own deploy will succeed (Wrangler validates bindings at deploy time). Deploy
`arcanum-backend`, `arcanum-devicehub`, and `arcanum-frontends` first, then
this Worker last (`wrangler deploy`), which claims `demo.arcanum.kaboutersoft.be`.

### 6. Deploy

```bash
npx wrangler deploy
```

## Security notes

- **Sessions**: a 256-bit random id in the `__Host-session_id` cookie
  (`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`; plain `session_id` only in
  local development or with `COOKIE_DOMAIN`). The session itself — access,
  refresh and id token — is AES-GCM-encrypted in KV. An old `session_id`
  cookie is never read (a sibling subdomain could plant one); it's cleared.
- **Login** (`/login` → provider → `/callback`): PKCE S256; the verifier,
  the `state` and where to land travel in a signed, 10-minute `oauth_state`
  cookie, so `/callback` only goes on for the browser that started the login
  (no login CSRF), and nothing is written to KV before a login succeeds.
- **Device login** (`/device/start`, `/device/poll?id=`): the poll id is the
  provider's device code, signed; starts are rate-limited per IP.
- **No bearer tokens**: only the session cookie signs a request in.
- **Token refresh**: when a parallel request already refreshed, the newer
  tokens in the session are used instead of signing the browser out.
- **Writes only from this site**: a non-GET request to `/api/*` (not
  `/api/callback/*`) or `/installer/*` must come from this origin, the
  `FRONTEND_URL`'s, or an `ALLOWED_ORIGINS` one (`Origin`, else
  `Sec-Fetch-Site: same-origin`) — `SameSite=Lax` alone still lets a sibling
  subdomain send the cookie.
- **Forwarding**: identity headers a client sends are always replaced; the
  Workers behind get neither the session cookie nor the access token (nor a
  client's `Authorization`);
  `/api/bancontact/*` forwards only the payment and ledger paths the screens
  use; `/api/callback/*` (payment providers) is the one unauthenticated pipe.
- **Headers** on every answer: `X-Frame-Options: DENY` + CSP
  `frame-ancestors 'none'`, `nosniff`, `strict-origin-when-cross-origin`,
  HSTS — never overriding what an upstream set itself.
- **Logout** refuses a cross-site request (`Sec-Fetch-Site: cross-site`).

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in BFF_INTERNAL_KEY
npm run dev
```

Run `arcanum-backend`, `arcanum-devicehub`, and `arcanum-frontends` locally
too (each via their own `wrangler dev`, on different ports — see
`LOCAL_DEV.md` at the arcanum folder root for the full port map), and point
`BANCONTACT_LOCAL_URL` / `DEVICEHUB_LOCAL_URL` / `CONSOLE_LOCAL_URL` in
`.dev.vars` at wherever they're listening. In dev mode this Worker talks to
them over plain HTTP instead of service bindings.

## Tests

```bash
npm test          # Vitest in the Workers runtime (@cloudflare/vitest-pool-workers)
npm run typecheck
```

## Smoke test after deploying

1. Visit `https://demo.arcanum.kaboutersoft.be/` unauthenticated → login prompt →
   Auth0 login → redirected back, session cookie set, the org/device chooser
   loads.
2. `GET /whoami` → your identity (sub/email/name).
3. `/console` loads the admin portal; kassa/settings/the customer display
   all work end-to-end (real payment flows — verify with
   care, not just that the page loads).

## License

Copyright (C) 2026 kaboutersoft.be

Arcanum is free software: you can redistribute it and/or modify it under the
terms of the GNU Affero General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version. It is distributed in the hope that it will be useful, but
WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full text.

In short: free to use, self-host, modify, host for others and charge for
hosting or support — but if you run a modified version for users over a
network, you must offer those users its source code (AGPL §13). The app's
"Broncode" link (the `SOURCE_URL` setting of arcanum-bff) is how an
installation points its users to that source.
