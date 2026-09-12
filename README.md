# questo-bff

check deployment with commit

Backend-for-frontend for the Elewijtse Pijl app. Single front door on
`elewijtsepijl.esvvzw.be`: handles login against Auth0 (Google Workspace
connection), then proxies everything else — the static webapp UI and the
bancontact worker's API — to two other Workers via service bindings, so
neither of those Workers needs to be publicly reachable anymore.

```
Browser
  └─ elewijtsepijl.esvvzw.be/*  → questo-bff
       ├─ /login /callback /logout      → Auth0
       ├─ /whoami                       → current session identity
       ├─ /api/bancontact/*  (auth'd)   → service binding → questo-bancontact-worker
       └─ everything else    (auth'd)   → service binding → questo-webapp (assets)
```

Copied and adapted from `tessera-bff`. Changes from that codebase:
- No Auth0 `audience` / API scopes requested — this app doesn't use Auth0 for
  authorization, only authentication. `identity.roles` is always `[]`;
  who-can-do-what is the app's own concern, not Auth0's.
- Service bindings renamed/replaced: `WEBAPP_SERVICE` (questo-webapp),
  `BANCONTACT_SERVICE` (questo-bancontact-worker). The old
  `LEVELS_SERVICE`/`SCORES_SERVICE`/`PURCHASES_SERVICE` bindings and their
  route-table entries are gone.
- `router.ts` has one route: `/api/bancontact/*` → strips the
  `/api/bancontact` prefix and forwards to the bancontact worker's existing
  `/payments`, `/settings`, `/verify-password` paths unchanged.

## One-time setup

### 1. Auth0

In your new Auth0 tenant (the one already wired to Google Workspace):

1. Create an Application → type **Regular Web Application**.
2. Enable the Google Workspace connection on it.
3. Allowed Callback URLs: `https://elewijtsepijl.esvvzw.be/callback`
   (add `http://localhost:8787/callback` too if you'll test locally).
4. Allowed Logout URLs: `https://elewijtsepijl.esvvzw.be`
5. Copy the Client ID and Client Secret — you'll need them below.
6. Do **not** create an Auth0 API for this. Authorization stays in the app.

### 2. Install dependencies

```bash
npm install
```

### 3. Create the sessions KV namespace

```bash
npx wrangler kv namespace create QUESTO_SESSIONS
```

This prints an `id`. Put it into `wrangler.jsonc`'s `kv_namespaces` entry.

### 4. Set the Auth0 domain

In `wrangler.jsonc`, replace `REPLACE_WITH_NEW_AUTH0_TENANT_DOMAIN` under
`vars.AUTH0_DOMAIN` with your tenant's domain (e.g. `your-tenant.eu.auth0.com`
— no `https://`, no trailing slash).

### 5. Set secrets

```bash
npx wrangler secret put OAUTH_CLIENT_ID
npx wrangler secret put OAUTH_CLIENT_SECRET
```

Paste the values from the Auth0 Application when prompted.

### 6. Service bindings — deploy order matters

`wrangler.jsonc` declares two service bindings by Worker name:

- `BANCONTACT_SERVICE` → `questo-bancontact-worker`
- `WEBAPP_SERVICE` → `questo-webapp`

Both target Workers must already be deployed under those exact names before
this Worker's own deploy will succeed (Wrangler validates bindings at
deploy time). Deploy order:

1. Deploy `questo-webapp` **without** its custom domain route (see the note
   in questo's `webapp/wrangler.jsonc` — the custom domain moves here).
2. Deploy `questo-bancontact-worker` (unchanged).
3. Deploy this Worker (`wrangler deploy`), which claims
   `elewijtsepijl.esvvzw.be`.

A custom domain can only be attached to one Worker at a time — if
`questo-webapp` still has the route when you try to attach it here, the
deploy will fail. Remove it there first (already done in this session's
edit to `webapp/wrangler.jsonc`).

### 7. Deploy

```bash
npx wrangler deploy
```

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET
npm run dev
```

Run `questo-webapp` and `questo-bancontact-worker` locally too (each via
their own `wrangler dev`, on different ports), and point `UIPROXY_URL` /
`BANCONTACT_LOCAL_URL` in `.dev.vars` at wherever they're listening. In dev
mode this Worker talks to them over plain HTTP instead of service bindings.

## Smoke test after deploying

1. Visit `https://elewijtsepijl.esvvzw.be/` → redirected to `/login` →
   Google Workspace login → redirected back, session cookie set, entry
   screen loads.
2. `GET /whoami` → your identity (sub/email/name), `roles: []`.
3. Entry screen actions (create a QR payment, load settings) should work
   exactly as before — they now go through `/api/bancontact/*` instead of
   calling the bancontact worker's own URL directly.
4. Confirm the bancontact worker's own public URL still responds directly
   (it's not yet locked down — see "Follow-up hardening" below) but nothing
   in the app calls it anymore.

## Follow-up hardening (not done yet, do once the above is verified)

- `questo-bancontact-worker` and `questo-webapp` are reachable only via
  service binding from this app's perspective, but each Worker still has its
  own `*.workers.dev` URL unless you turn that off
  (`"workers_dev": false` in their `wrangler.jsonc`, or in the dashboard).
  Worth doing once you've confirmed the BFF path works end-to-end.
- Consider whether the bancontact worker's `SETTINGS_PASSWORD` check and
  rate limiter are still needed once every caller is already an
  authenticated staff member via the BFF, or whether to simplify to one
  layer of protection.
# questo-bff
