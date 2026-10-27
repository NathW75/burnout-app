# Deploying to Railway

Burnout League runs on Railway as two services built from this repo, next to
Railway-managed Postgres and Redis:

| Service | Start | Notes |
|---------|-------|-------|
| `api` | `node packages/api/dist/index.js` | Health check `GET /healthz` (Postgres + Redis). Domain `api.burnoutfantasy.com` (production) or `api-staging.burnoutfantasy.com` (staging), port 8080. |
| `worker` | `node packages/api/dist/worker.js` | One replica. Locks, payments, scoring, roster and injury jobs (PRD-006 §11). The only process that calls MySportsFeeds. |

Both services build with `npm run build:server`, which builds every workspace
package in dependency order. Before each deploy, both run
`npm run db:migrate` (`prisma migrate deploy`). Prisma takes an advisory lock,
so whichever service starts first applies the migrations, and neither process
ever starts on an old schema. A failed migration stops the deploy.

The configuration lives in `.railway/railway.ts` (Railway Infrastructure as
Code). Railway retired `railway.toml` for new services, and existing files stop
being read on 2026-12-01. Railway doesn't read `.railway/` during a deploy:
you apply changes from your machine with the CLI (below), and pushes to `main`
then deploy the code.

## Environments and the blackout window

- **staging** deploys every push to `main`.
- **production** waits for every GitHub check on the commit to pass ("wait for
  CI"): the test suite (`ci.yml`) and the deploy gate (`deploy-gate.yml`). The
  gate fails from **Thu 5:00 PM ET to Tue 2:00 AM ET**, so nothing reaches
  production during the NFL blackout window.
  - A commit pushed during the window doesn't deploy on its own afterward.
    Re-run the deploy gate job in GitHub Actions, or press Redeploy in Railway.
  - Emergency override (needs on-call authorization): put
    `[blackout-override]` in the commit message. The job log records it.

## Secrets

Secrets are **Railway shared variables**: Project Settings → Shared Variables,
set separately for each environment, with different values in staging and
production. `.railway/railway.ts` only names them, so their values never appear
in the repo, in chat or in project docs.

| Shared variable | Used by | Value |
|-----------------|---------|-------|
| `TOTP_ENCRYPTION_KEY` | both | 32 random bytes, base64 (command below). **Never change it once users enroll**: changing it invalidates every authenticator. |
| `PAYMENT_WEBHOOK_SECRET` | both | Random. The fake processor signs webhooks with it. |
| `EDGE_SHARED_SECRET` | api | Random. Must match the Cloudflare rule below. Unset means paid checkout is blocked. |
| `MSF_API_KEY` | worker | Your (rotated) MySportsFeeds key. |
| `SENDGRID_API_KEY` | both | SendGrid key. Unset means emails aren't sent; a warning is logged. |

Generate a random value in cmd (once per variable, per environment):

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

`DATABASE_URL` and `REDIS_URL` are references to the Postgres and Redis
services, and the rest (`CURRENT_SEASON`, `APP_BASE_URL`, `CORS_ORIGINS`,
`PORT`, `TRUST_PROXY`, `PAYMENTS_LIVE=false`, …) are set in
`.railway/railway.ts`. Change them there, not in the dashboard.

## First-time setup (Windows, cmd)

Do staging first. Production later follows the same steps with
`railway environment production`. Respect the blackout window, and the
governance rule that code soaks in staging before production.

1. **Railway CLI** (5.42.1 or newer), then sign in:

   ```
   npm install -g @railway/cli
   railway --version
   railway login
   ```

2. **Link the repo folder** to the project and pick the **staging** environment:

   ```
   cd C:\Users\nb_wa\Documents\burnout-app\burnout-repo\burnout
   npm install
   railway link
   railway environment staging
   ```

3. **Preview** (changes nothing):

   ```
   railway config plan
   ```

   Read it before applying. You should see `api` and `worker` created, and no
   changes to Postgres or Redis. **Do not apply** if the plan would:
   - replace or change the image of an existing Postgres or Redis. The names in
     the file are `Postgres` and `Redis`; if yours differ, the file gets edited
     first.
   - delete anything, including the old `Burnout` service (connected to the
     marketing repo). Deletions need `--confirm-destructive`, so they won't
     happen by accident.
   - rename the project.

4. **Apply:**

   ```
   railway config apply
   ```

5. **Shared variables** for staging (table above): Project Settings → Shared
   Variables → staging. The first deploy may fail its health check until
   they're set. Railway redeploys once you deploy the staged changes.

6. **Cloudflare** (burnoutfantasy.com zone):
   - **DNS:** add the record Railway shows for `api-staging` under the api
     service's Settings → Networking (a CNAME), **Proxied** (orange cloud). If
     Railway asks for a TXT verification record, add that too.
   - **SSL/TLS** mode: **Full**.
   - **Rules → Transform Rules → Modify Request Header**, new rule:
     - When: Hostname equals `api-staging.burnoutfantasy.com`
     - Then: **Set static** header `X-Burnout-Edge` = your staging
       `EDGE_SHARED_SECRET`
     - Production gets its own rule (hostname `api.burnoutfantasy.com`, the
       production secret).
     - "Set" overwrites anything a client sends, so the header can only come
       from Cloudflare.
   - Visitor location headers (Managed Transforms): already on.

7. **Check:**

   ```
   curl https://api-staging.burnoutfantasy.com/healthz
   ```

   It should return `{"ok":true}`. In Railway, the api deploy log should show
   the migrations applying and `api listening`, and **no**
   `EDGE_SHARED_SECRET not set` warning. The worker log should show
   `worker started` and a `job locks` line every minute.

## Why the edge secret (PRD-006 §10.4)

Railway's own address can be reached without Cloudflare, so a `cf-ipcountry`
or `cf-region-code` header on its own proves nothing: anyone could send
`US`/`GA` and get past the jurisdiction check. The API trusts those headers,
and `cf-connecting-ip` (the visitor's real IP, used for rate limits and the
audit log), **only** when the request carries the edge secret that Cloudflare
adds. Without it the headers are dropped, so the region is unknown and paid
checkout is blocked, and the client IP is the one Railway's edge saw.
