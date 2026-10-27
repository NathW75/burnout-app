/**
 * Auth resolution, CSRF, gates and error mapping — PRD-006 §4, §5, §6.5
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { EntryNotFoundError, HandleError, LeaderboardAccessError, PoolNotFoundError } from '@burnout/leaderboard';
import { PaymentsError, StepUpRequiredError, WebhookSignatureError } from '@burnout/payments';
import { hasFreshStepUp } from '../auth/service';
import { resolveSession, type SessionInfo } from '../auth/sessions';
import type { ApiContext } from '../context';
import { forbidden, HttpError, tooMany, unauthorized } from '../errors';

declare module 'express-serve-static-core' {
  interface Request {
    session?: SessionInfo | null;
    authVia?: 'cookie' | 'bearer' | null;
    rawBody?: Buffer;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const ah =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/** Express-friendly async middleware: runs fn, then next(). */
export const mw =
  (fn: (req: Request, res: Response) => Promise<void> | void): RequestHandler =>
  (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .then(() => next(), next);
  };

/** Resolves the bearer token or session cookie into req.session (null if none or invalid). */
export function authResolver(ctx: ApiContext): RequestHandler {
  return mw(async (req) => {
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '')?.[1];
    const cookie = parseCookies(req.get('cookie'))[ctx.config.cookieName];
    req.authVia = bearer ? 'bearer' : cookie ? 'cookie' : null;
    req.session = bearer || cookie ? await resolveSession(ctx, (bearer ?? cookie)!) : null;
  });
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** §5.7: cookie-authenticated state changes need X-Burnout-CSRF: 1 and an allowed Origin. Bearer requests are exempt. */
export function csrf(ctx: ApiContext): RequestHandler {
  return (req, _res, next) => {
    if (!UNSAFE.has(req.method) || req.authVia === 'bearer') return next();
    const hasCookie = !!parseCookies(req.get('cookie'))[ctx.config.cookieName];
    if (!hasCookie) return next();
    const origin = req.get('origin');
    if (origin && !ctx.config.corsOrigins.includes(origin)) return next(forbidden('CSRF', 'Origin not allowed'));
    if (req.get('x-burnout-csrf') !== '1') return next(forbidden('CSRF', 'Missing CSRF header'));
    next();
  };
}

export function ipRateLimit(ctx: ApiContext, bucket: string, limit: number, windowSeconds: number): RequestHandler {
  return mw(async (req) => {
    if (!(await ctx.limiter.hit(`${bucket}:${req.ip}`, limit, windowSeconds))) throw tooMany();
  });
}

// ── gates ───────────────────────────────────────────────────────────────────

export function session(req: Request): SessionInfo {
  const s = req.session;
  if (!s || s.mfaPending) throw unauthorized();
  return s;
}

export function pendingSession(req: Request): SessionInfo {
  const s = req.session;
  if (!s) throw unauthorized();
  return s;
}

/** §6.5 financial gate: verified email → enrolled factor → fresh step-up. */
export function financialSession(ctx: ApiContext, req: Request): SessionInfo {
  const s = session(req);
  if (!s.emailVerified) throw forbidden('EMAIL_UNVERIFIED', 'Verify your email first');
  if (!s.hasFactor) throw forbidden('MFA_ENROLLMENT_REQUIRED', 'Set up two-factor authentication first');
  if (!hasFreshStepUp(ctx, s)) throw forbidden('STEP_UP_REQUIRED', 'Confirm with your second factor');
  return s;
}

export function adminSession(ctx: ApiContext, req: Request): SessionInfo {
  const s = session(req);
  if (s.role !== 'admin') throw forbidden();
  if (!s.hasFactor) throw forbidden('MFA_ENROLLMENT_REQUIRED', 'Set up two-factor authentication first');
  if (!hasFreshStepUp(ctx, s)) throw forbidden('STEP_UP_REQUIRED', 'Confirm with your second factor');
  return s;
}

export function body<T extends ZodTypeAny>(schema: T, req: Request): z.infer<T> {
  return schema.parse(req.body ?? {});
}

// ── errors ──────────────────────────────────────────────────────────────────

function paymentsStatus(code: string): number {
  if (code === 'STEP_UP_REQUIRED') return 403;
  if (code.endsWith('_NOT_FOUND')) return 404;
  if (code === 'IDENTITY_UNVERIFIED' || code === 'JURISDICTION_BLOCKED' || code === 'INSTANT_NOT_AVAILABLE') return 403;
  return 409;
}

export function errorHandler(ctx: ApiContext) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.code, message: err.message, ...(err.details ?? {}) });
    }
    if (err instanceof ZodError) {
      return res.status(400).json({ error: 'VALIDATION', message: 'Invalid request', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    if (err instanceof WebhookSignatureError) return res.status(400).json({ error: 'BAD_SIGNATURE', message: 'Signature verification failed' });
    if (err instanceof StepUpRequiredError) return res.status(403).json({ error: 'STEP_UP_REQUIRED', message: 'Confirm with your second factor' });
    if (err instanceof PaymentsError) return res.status(paymentsStatus(err.code)).json({ error: err.code, message: err.message });
    if (err instanceof LeaderboardAccessError) return res.status(403).json({ error: 'NOT_AN_ENTRANT', message: err.message });
    if (err instanceof EntryNotFoundError || err instanceof PoolNotFoundError) return res.status(404).json({ error: 'NOT_FOUND', message: 'Not found' });
    if (err instanceof HandleError) return res.status(err.code === 'HANDLE_TAKEN' || err.code === 'HANDLE_CHANGE_LIMIT' ? 409 : 400).json({ error: err.code, message: err.message });
    if (err instanceof SyntaxError && 'body' in (err as object)) return res.status(400).json({ error: 'VALIDATION', message: 'Malformed JSON' });
    // Unexpected: log the error class and message only — never request bodies or headers (AC15).
    ctx.log('error', 'unhandled error', { path: req.path, method: req.method, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
    return res.status(500).json({ error: 'INTERNAL', message: 'Something went wrong' });
  };
}
