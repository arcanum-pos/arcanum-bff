# arcanum-bff


Backend-for-frontend for the Arcanum platform. Single front door on
`arcanum.kaboutersoft.be`: handles login against Auth0 (or an org's own
identity provider, once configured), then proxies everything else to the
platform's other Workers via service bindings, so none of them need to be
publicly reachable.

```
Browser
  └─ arcanum.kaboutersoft.be/*  → arcanum-bff
       ├─ /login /callback /logout /device*   → Auth0 / an org's own IdP
       ├─ /whoami                             → current session identity
       ├─ /devices/connect                    → service binding → arcanum-devicehub
       │    (the notification WebSocket — public/no-session, see index.ts)
       ├─ /api/bancontact/* /api/organizations/* /api/callback/*  (see
       │    src/routes/router.ts)             → service binding → arcanum-backend
       ├─ /api/devices/*                      → service binding → arcanum-devicehub
       └─ /console, /, /kassa.html, /settings.html, /device, /simulator.html,
            /display.html, and every arcanum-frontends asset  (auth'd, except
            /device*, /devices/connect, and the login prompt itself)
                                               → service binding → arcanum-frontends
```

This same-origin routing is also what lets an org's own custom domain work
for every screen *and* the notification channel — every custom domain routes
to this Worker, so nothing here is tied to `arcanum.kaboutersoft.be`
specifically.

Service bindings (see `wrangler.jsonc`):
- `ARCANUM_BACKEND_SERVICE` → `arcanum-backend` (payments, organizations/admin
  API, provider callbacks)
- `ARCANUM_DEVICEHUB_SERVICE` → `arcanum-devicehub` (device registration/
  linking, and the notification WebSocket itself — forwarded through this BFF
  rather than a separate arcanum-devicehub hostname, so it follows whichever
  domain the browser is on)
- `ARCANUM_FRONTENDS_SERVICE` → `arcanum-frontends` (every UI screen)

No Auth0 `audience` / API scopes requested — this app doesn't use Auth0 for
authorization, only authentication. Authorization (who can do what) is the
app's own concern, resolved per-org from the `memberships` table.

## One-time setup

### 1. Auth0

In your Auth0 tenant:

1. Create an Application → type **Regular Web Application**.
2. Enable whichever connection(s) you want as the platform default.
3. Allowed Callback URLs: `https://arcanum.kaboutersoft.be/callback`
   (add `http://localhost:8787/callback` too if you'll test locally).
4. Allowed Logout URLs: `https://arcanum.kaboutersoft.be`
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

### 4. Set the Auth0 domain

In `wrangler.jsonc`, set `vars.AUTH0_DOMAIN` to your tenant's domain (e.g.
`your-tenant.eu.auth0.com` — no `https://`, no trailing slash).

### 5. Set secrets

```bash
npx wrangler secret put OAUTH_CLIENT_ID
npx wrangler secret put OAUTH_CLIENT_SECRET
npx wrangler secret put BFF_INTERNAL_KEY
```

`BFF_INTERNAL_KEY` must match the same secret set on `arcanum-backend`.

### 6. Service bindings — deploy order matters

`wrangler.jsonc`'s three service bindings are by Worker name — each target
Worker must already be deployed under its exact name before this Worker's
own deploy will succeed (Wrangler validates bindings at deploy time). Deploy
`arcanum-backend`, `arcanum-devicehub`, and `arcanum-frontends` first, then
this Worker last (`wrangler deploy`), which claims `arcanum.kaboutersoft.be`.

### 7. Deploy

```bash
npx wrangler deploy
```

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET / BFF_INTERNAL_KEY
npm run dev
```

Run `arcanum-backend`, `arcanum-devicehub`, and `arcanum-frontends` locally
too (each via their own `wrangler dev`, on different ports — see
`LOCAL_DEV.md` at the arcanum folder root for the full port map), and point
`BANCONTACT_LOCAL_URL` / `DEVICEHUB_LOCAL_URL` / `CONSOLE_LOCAL_URL` in
`.dev.vars` at wherever they're listening. In dev mode this Worker talks to
them over plain HTTP instead of service bindings.

## Smoke test after deploying

1. Visit `https://arcanum.kaboutersoft.be/` unauthenticated → login prompt →
   Auth0 login → redirected back, session cookie set, the org/device chooser
   loads.
2. `GET /whoami` → your identity (sub/email/name).
3. `/console` loads the admin portal; kassa/settings/the customer display/
   the SumUp simulator all work end-to-end (real payment flows — verify with
   care, not just that the page loads).
