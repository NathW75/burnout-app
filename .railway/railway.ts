/**
 * Burnout League on Railway: Infrastructure as Code.
 *
 * Applied from a workstation with the Railway CLI (docs/deploy/RAILWAY.md):
 *   railway config plan     → review, then
 *   railway config apply
 * Railway does not read this folder during deploys; pushes to main deploy the
 * services below as configured here.
 *
 * Secrets are Railway shared variables (Project Settings → Shared Variables,
 * once per environment). This file only references them by name, so their
 * values never appear here or in git. Hard constraint 2.
 *
 * Environments: staging deploys every push to main. Production waits for the
 * GitHub checks (CI and the blackout deploy gate) before it deploys.
 *
 * Custom domains can't be registered from this file (Railway rejects it). They
 * are added in the dashboard: api-staging.burnoutfantasy.com (staging) and
 * api.burnoutfantasy.com (production), both targeting port 8080 (PORT below).
 */
import { defineRailway, github, postgres, redis, service } from 'railway/iac';

const REPO = 'NathW75/burnout-app';
// Same region as Postgres and Redis (Virginia): every request makes several DB round trips.
const REGION = 'us-east4-eqdc4a';

export default defineRailway((ctx, project) => {
  const production = ctx.isEnvironment('production');
  const db = postgres('Postgres');
  const cache = redis('Redis');
  const secret = (name: string) => ctx.shared[name];
  const source = github(REPO, { branch: 'main', checkSuites: production });

  // Both processes load the same runtime (packages/api/src/runtime.ts).
  const common = {
    DATABASE_URL: db.env.DATABASE_URL,
    REDIS_URL: cache.env.REDIS_URL,
    CURRENT_SEASON: '2026-2027-regular',
    APP_BASE_URL: 'https://burnoutfantasy.com',
    MAIL_FROM: 'no-reply@burnoutfantasy.com',
    PAYMENTS_LIVE: 'false', // no live processor until written approval (PRD-004 §7.3)
    TOTP_ENCRYPTION_KEY: secret('TOTP_ENCRYPTION_KEY'),
    PAYMENT_WEBHOOK_SECRET: secret('PAYMENT_WEBHOOK_SECRET'),
    SENDGRID_API_KEY: secret('SENDGRID_API_KEY'),
  };

  // One build for both: every workspace package in dependency order.
  // Docs-only commits don't redeploy.
  const build = {
    builder: 'RAILPACK' as const,
    buildCommand: 'npm run build:server',
    watchPatterns: ['packages/**', 'package.json', 'package-lock.json', '.nvmrc'],
  };

  // Prisma takes an advisory lock, so both services may run it; whichever
  // starts first applies the migrations and neither process starts on an old schema.
  const migrate = 'npm run db:migrate';

  const api = service('api', {
    source,
    build,
    start: 'node packages/api/dist/index.js',
    preDeploy: migrate,
    healthcheck: '/healthz', // checks Postgres and Redis
    healthcheckTimeout: 60,
    replicas: { [REGION]: 1 },
    deploy: { restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 10 },
    env: {
      ...common,
      PORT: '8080', // the custom domain (added in the dashboard) targets this port
      CORS_ORIGINS: 'https://burnoutfantasy.com,https://www.burnoutfantasy.com',
      TRUST_PROXY: '1', // Railway's edge; Cloudflare is verified by EDGE_SHARED_SECRET instead
      EDGE_SHARED_SECRET: secret('EDGE_SHARED_SECRET'), // PRD-006 §10.4; must match the Cloudflare rule
    },
  });

  // Exactly one worker: jobs also hold advisory locks, but one ticker is the design.
  const worker = service('worker', {
    source,
    build,
    start: 'node packages/api/dist/worker.js',
    preDeploy: migrate,
    replicas: { [REGION]: 1 },
    deploy: { restartPolicyType: 'ALWAYS' },
    env: {
      ...common,
      MSF_API_KEY: secret('MSF_API_KEY'), // MySportsFeeds: only the worker calls it
      MSF_BASE_URL: 'https://api.mysportsfeeds.com/v2.1/pull/nfl',
    },
  });

  return project(ctx.projectName ?? 'Burnout League', { resources: [db, cache, api, worker] });
});
