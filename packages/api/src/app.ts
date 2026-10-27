/**
 * Express app — PRD-006
 */
import compression from 'compression';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Redis } from 'ioredis';
import { createLeaderboardService } from '@burnout/leaderboard';
import type { PaymentsService } from '@burnout/payments';
import { SecretBox } from './auth/crypto';
import { redisRateLimiter, type RateLimiter } from './auth/rate-limit';
import { cloudflareTurnstile, type TurnstileVerifier } from './auth/turnstile';
import { DEFAULT_API_CONFIG, type ApiConfig, type ApiContext, type Log } from './context';
import { notFound } from './errors';
import { ah, authResolver, csrf, edgeGuard, errorHandler, ipRateLimit } from './http/middleware';
import { buildRouter } from './http/routes';
import type { Mailer } from './mailer';
import type { SqlDatabase } from './sql';

export interface CreateAppDeps {
  db: SqlDatabase;
  redis?: Redis;
  namespace?: string;
  payments: PaymentsService;
  mailer: Mailer;
  totpEncryptionKey: string;
  getServerTime?: () => Date;
  log?: Log;
  config?: Partial<ApiConfig>;
  limiter?: RateLimiter;
  handleBlocklist?: ReadonlyArray<string>;
  /** Replaces the Cloudflare siteverify call (tests). Used only when config.turnstileSecret is set. */
  verifyTurnstile?: TurnstileVerifier;
}

const noopLimiter: RateLimiter = { hit: async () => true, blocked: async () => false, reset: async () => {} };

export function createContext(deps: CreateAppDeps): ApiContext {
  const log: Log = deps.log ?? (() => {});
  const ns = deps.namespace ?? '';
  const config = { ...DEFAULT_API_CONFIG, ...deps.config };
  return {
    db: deps.db,
    redis: deps.redis,
    ns,
    now: deps.getServerTime ?? (() => new Date()),
    log,
    config,
    secretBox: new SecretBox(deps.totpEncryptionKey),
    limiter: deps.limiter ?? (deps.redis ? redisRateLimiter(deps.redis, ns, (m) => log('warn', m)) : noopLimiter),
    mailer: deps.mailer,
    leaderboard: createLeaderboardService({ db: deps.db, redis: deps.redis, namespace: ns, handleBlocklist: deps.handleBlocklist, log }),
    payments: deps.payments,
    verifyTurnstile: config.turnstileSecret ? (deps.verifyTurnstile ?? cloudflareTurnstile(config.turnstileSecret, log)) : null,
  };
}

export function createApp(deps: CreateAppDeps): { app: Express; ctx: ApiContext } {
  const ctx = createContext(deps);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', ctx.config.trustProxy);
  app.use(edgeGuard(ctx)); // first: decides which edge headers anything below may believe (§10.4)
  app.use(helmet());
  app.use(compression());
  app.use(cors({ origin: ctx.config.corsOrigins, credentials: true, allowedHeaders: ['content-type', 'authorization', 'x-burnout-csrf', 'x-current-screen'] }));

  app.get('/healthz', ah(async (_req, res) => {
    await ctx.db.query('SELECT 1');
    if (ctx.redis) await ctx.redis.ping();
    res.json({ ok: true });
  }));

  // Webhooks need the exact raw bytes for signature checks: mount before the JSON parser.
  app.post('/v1/webhooks/:processor', express.raw({ type: '*/*', limit: '1mb' }), ah(async (req, res) => {
    if (req.params.processor !== ctx.payments.context.processor.name) throw notFound();
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v ?? '')]));
    const result = await ctx.payments.handleWebhook(Buffer.isBuffer(req.body) ? req.body : Buffer.from(''), headers);
    res.json({ received: true, status: result.status });
  }));

  app.use(express.json({ limit: '100kb' }));
  app.use(ipRateLimit(ctx, 'ip', 300, 60));
  app.use(authResolver(ctx));
  app.use(csrf(ctx));
  app.use('/v1', buildRouter(ctx));
  app.use((_req, _res, next) => next(notFound()));
  app.use(errorHandler(ctx));
  return { app, ctx };
}
