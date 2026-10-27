# Web app on Cloudflare (PRD-007 §4)

The web app (`apps/web`) is static files served by Cloudflare: no Worker code,
just the build in `apps/web/dist`. `apps/web/wrangler.jsonc` describes both
environments:

| Environment | Hostname | Worker name | Deploys |
|-------------|----------|-------------|---------|
| staging | `app-staging.burnoutfantasy.com` | `burnout-app-staging` | every push to `main` that touches the app |
| production | `app.burnoutfantasy.com` | `burnout-app-production` | after staging, outside the blackout window, once switched on |

GitHub Actions does the deploys (`.github/workflows/deploy-web.yml`). Production
runs the same blackout gate as the API: Thu 5:00 PM ET → Tue 2:00 AM ET is
closed (`[blackout-override]` in the commit message overrides, with on-call
authorization).

**What ships in the bundle.** Only public values: the API address and the
Turnstile *site* key, in `apps/web/.env.staging` and `apps/web/.env.production`.
The Turnstile *secret* key lives only in Railway (`TURNSTILE_SECRET_KEY`). Never
put a secret in a `VITE_` variable: everything there reaches the browser.

**Security headers.** The build writes `dist/_headers` (from
`apps/web/headers.ts`): a strict Content-Security-Policy (this origin, the API
origin, Turnstile, Google Fonts), `frame-ancestors 'none'`, HSTS and
`Referrer-Policy`. Cloudflare applies it to every response, including the
`index.html` it serves for app routes.

## One-time setup

### 1. Cloudflare API token for GitHub

Cloudflare → My Profile → API Tokens → **Create Token** → **Edit Cloudflare
Workers** template, then narrow it:

- **Account resources:** include your account only.
- **Zone resources:** include specific zone → `burnoutfantasy.com`.

The template already has the two permissions the deploy needs: Account →
Workers Scripts → Edit (it creates the Workers on the first deploy) and Zone →
Workers Routes → Edit (it attaches the custom domains). Create it and copy the
token once; don't paste it anywhere but GitHub.

Your **Account ID** is on the right of the Cloudflare dashboard home page
(Workers & Pages → Overview also shows it).

### 2. GitHub secrets

GitHub → `burnout-app` → Settings → Secrets and variables → Actions →
**New repository secret**, twice:

| Name | Value |
|------|-------|
| `CLOUDFLARE_API_TOKEN` | the token from step 1 |
| `CLOUDFLARE_ACCOUNT_ID` | your account ID |

The workflow names two GitHub environments, `staging` and `production`. GitHub
creates them on the first run. To require a manual approval for production,
add a required reviewer under Settings → Environments → production.

### 3. Hostnames

Nothing to do in DNS. The first deploy creates `app-staging.burnoutfantasy.com`
as a Workers Custom Domain, with its DNS record and certificate. It fails if a
DNS record for that name already exists; delete any old one first.

### 4. First staging deploy

Push to `main` (or run the workflow: Actions → **Deploy web app** → Run
workflow). When it's green, open `https://app-staging.burnoutfantasy.com`.

Check:

1. The sign-up page shows the Turnstile check.
2. A sign-up completes end to end: the verification email's link opens the app
   (Railway's `APP_BASE_URL` already points here), and the authenticator step
   follows.
3. Developer tools → Network: API calls go to `api-staging.burnoutfantasy.com`
   with no CORS errors. (Railway's `CORS_ORIGINS` already includes the app.)

### 5. Production (later)

When the production API is live:

1. Make sure Railway production has `TURNSTILE_SECRET_KEY` (the **app-prod**
   widget's secret key) and the production IaC applied.
2. GitHub → Settings → Secrets and variables → Actions → **Variables** → New
   repository variable: `WEB_PRODUCTION` = `on`.

From then on, every app change deploys to staging, then to production when the
window is open.

## Local development

```
cd apps/web
npm run dev
```

The app runs at `http://localhost:3000` against `VITE_API_BASE_URL` (default
`http://localhost:3001`). For a local API, set its `CORS_ORIGINS` to
`http://localhost:3000` and `SESSION_COOKIE_SECURE=false`.

## Tests

- `npm -w apps/web run test`: unit and component tests (Vitest).
- `npm -w apps/web run e2e`: Playwright against a real API, Postgres and Redis.
  Needs `E2E_DATABASE_URL` and `E2E_REDIS_URL` (CI sets them). The test API
  server (`apps/web/e2e/api-server.cts`) builds a fresh `burnout_e2e` database
  from the migrations on every run.

## Rolling back

Cloudflare → Workers & Pages → `burnout-app-staging` (or `-production`) →
Deployments → pick an earlier version → **Rollback**. Or revert the commit and
push.
