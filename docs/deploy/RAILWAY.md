# Deploying to Railway

Burnout League runs on Railway as two services built from this repo, next to
Railway-managed Postgres and Redis:

| Service | Start | Notes |
|---------|-------|-------|
| `api` | `node packages/api/dist/index.js` | Health check `GET /healthz` (Postgres + Redis). Custom domain `api.burnoutfantasy.com` (production) or `api-staging.burnoutfantasy.com` (staging), port 8080, added in the dashboard (Railway's config can't register domains). |
| `worker` | `node packages/api/dist/worker.js` | One replica. Locks, payments, scoring, roster and injury jobs (PRD-006 §11). The only process that calls MySportsFeeds. |

Both services run in **us-east4** (Virginia), the same region as Postgres and Redis.
Both build with `npm run build:server`, which builds every workspace
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
| `TURNSTILE_SECRET_KEY` | api | Cloudflare Turnstile **secret key** for the sign-up widget (Cloudflare → Turnstile → the `burnoutfantasy.com` widget). Unset means sign-up has no bot check; a warning is logged. |
| `ANTHROPIC_API_KEY` | worker | Optional. Tags feedback (PRD-007 §10). Empty means feedback is stored untagged. |
| `VAPID_PUBLIC_KEY` | both | Web push key pair, public half (PRD-008 §9). Not secret, but kept beside its private half so the pair can't drift. |
| `VAPID_PRIVATE_KEY` | worker | Web push key pair, private half. Unset (or the public half unset) means push is off; a warning is logged. |

Generate a random value in cmd (once per variable, per environment):

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**Invite-only sign-up (PRD-006 §6.10).** `SIGNUP_INVITE_ONLY` on the api
(staging: on; production: off) makes sign-up need a single-use code. An admin
makes codes in the app under Account → Admin → Invites. Make at least one
admin **before** turning it on, or nobody can get in:

```sql
UPDATE users SET role = 'admin' WHERE handle = 'YourHandle';
```

**Notice emails (PRD-008).** The worker emails lock, burn, lineup-change and
receipt notices when `NOTIFY_EMAIL=on` (staging: on; production: off until
SendGrid's domain is authenticated). They come from `NOTIFY_FROM`
(`Burnout League <alerts@burnoutfantasy.com>`), group notices within
`NOTIFY_GROUP_SECONDS` (120), and put one-click unsubscribe links on
`API_PUBLIC_URL`. All four are set in `.railway/railway.ts`; after pulling a
change to them, run `railway config plan` and `railway config apply`. They use
the existing `SENDGRID_API_KEY`. In SendGrid, authenticate the
`burnoutfantasy.com` domain (Settings → Sender Authentication) or notices land
in spam.

**Push notifications (PRD-008 §9).** The worker also sends each notice as a
web push to every device that turned push on, when `NOTIFY_PUSH=on` (staging:
on; production: off) and the VAPID key pair is set. Make one pair per
environment on your own machine:

```
npx web-push generate-vapid-keys
```

Put the two values in that environment's Shared Variables as
`VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`, then run `railway config plan` and
`railway config apply`. Never paste the private key anywhere else. Changing the
pair later signs every device out of push; people turn it back on in Account →
Notifications. Phones: Android Chrome works from the browser; iPhone and iPad
need the app added to the Home Screen first (iOS 16.4 or later).

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

   **Windows:** if it fails with "requires Railway CLI 5.42.1 or newer" even though
   `railway --version` is newer, that's a Railway SDK bug. Its version check can't
   run npm's `railway.cmd` wrapper. Point it at the real binary for this cmd
   window, then plan again:

   ```
   dir /s /b "%APPDATA%\npm\node_modules\@railway\cli\*.exe"
   set _=<the path printed above>
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

6. **Custom domain** (Railway dashboard): staging environment → `api` service →
   Settings → Networking → **Custom Domain** → `api-staging.burnoutfantasy.com`,
   target port **8080**. Railway then shows the DNS record to create.
   Don't run `railway config pull` afterward: it would overwrite
   `.railway/railway.ts`.

7. **Cloudflare** (burnoutfantasy.com zone):
   - **DNS:** add the record Railway showed for `api-staging` (a CNAME),
     **Proxied** (orange cloud). If Railway asks for a TXT verification record,
     add that too.
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

8. **Check:**

   ```
   curl https://api-staging.burnoutfantasy.com/healthz
   ```

   It should return `{"ok":true}`. In Railway, the api deploy log should show
   the migrations applying and `api listening`, and **no**
   `EDGE_SHARED_SECRET not set` warning. The worker log should show a
   `job schedule` line first (the season schedule import; `windowsCreated` is
   about 120 on a fresh database, `review: 0` ideally), then `worker started`
   and a `job locks` line every minute. On a first import mid-season, the
   first lock check also claims every past window (the backfill), so expect
   one large `windowsLocked` count.

## Why the edge secret (PRD-006 §10.4)

Railway's own address can be reached without Cloudflare, so a `cf-ipcountry`
or `cf-region-code` header on its own proves nothing: anyone could send
`US`/`GA` and get past the jurisdiction check. The API trusts those headers,
and `cf-connecting-ip` (the visitor's real IP, used for rate limits and the
audit log), **only** when the request carries the edge secret that Cloudflare
adds. Without it the headers are dropped, so the region is unknown and paid
checkout is blocked, and the client IP is the one Railway's edge saw.
