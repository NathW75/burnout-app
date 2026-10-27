/**
 * Routes — PRD-006 §10
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import * as auth from '../auth/service';
import type { SessionInfo } from '../auth/sessions';
import type { ApiContext } from '../context';
import { HttpError, notFound } from '../errors';
import * as lineups from '../lineups/service';
import { getPool } from '../players/pool';
import { adminSession, ah, body, financialSession, ipRateLimit, pendingSession, session } from './middleware';

const email = z.string().trim().email().max(254);
const uuid = z.string().uuid();
const code = z.string().trim().min(6).max(20);
const client = z.enum(['web', 'mobile']).default('web');
const slotPlayer = z.string().trim().min(1).max(50).nullable().optional();
const slotsSchema = z.object({
  qb: slotPlayer, rb1: slotPlayer, rb2: slotPlayer, wr1: slotPlayer, wr2: slotPlayer, wr3: slotPlayer, te: slotPlayer, flex: slotPlayer, k: slotPlayer,
}).strict();
const seasonWeek = (req: Request) => ({
  season: z.string().regex(/^\d{4}-\d{4}-(regular|playoff)$/).parse(req.params.season),
  week: z.coerce.number().int().min(1).max(18).parse(req.params.week),
});

function clientInfo(req: Request) {
  return { ip: req.ip ?? 'unknown', userAgent: req.get('user-agent') ?? '' };
}

function meView(ctx: ApiContext, s: SessionInfo) {
  return {
    id: s.userId,
    email: s.email,
    handle: s.handle,
    role: s.role,
    emailVerified: s.emailVerified,
    mfaEnrolled: s.hasFactor,
    stepUpUntil: s.stepUpAt && auth.hasFreshStepUp(ctx, s) ? new Date(s.stepUpAt.getTime() + ctx.config.stepUpMaxAgeMs).toISOString() : null,
  };
}

export function buildRouter(ctx: ApiContext): Router {
  const r = Router();
  const cookieOpts = () => ({
    httpOnly: true,
    secure: ctx.config.cookieSecure,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: ctx.config.sessionMaxMs,
  });
  const issue = (res: Response, kind: 'web' | 'mobile', token: string, extra: object) => {
    if (kind === 'web') {
      res.cookie(ctx.config.cookieName, token, cookieOpts());
      return res.json(extra);
    }
    return res.json({ ...extra, token }); // mobile: bearer token, returned once
  };
  const clearCookie = (res: Response) => res.clearCookie(ctx.config.cookieName, { ...cookieOpts(), maxAge: undefined });

  // ── auth ────────────────────────────────────────────────────────────────
  r.post('/auth/signup', ipRateLimit(ctx, 'signup', 10, 60), ah(async (req, res) => {
    const b = body(z.object({ email, password: z.string(), handle: z.string() }), req);
    await auth.signup(ctx, b);
    res.status(202).json({ status: 'verification_sent', message: 'Check your email to verify your account, then sign in.' });
  }));

  r.post('/auth/verify-email', ah(async (req, res) => {
    await auth.verifyEmail(ctx, body(z.object({ token: z.string().min(10).max(200) }), req).token);
    res.json({ verified: true });
  }));

  r.post('/auth/verify-email/resend', ah(async (req, res) => {
    await auth.resendVerification(ctx, session(req));
    res.status(202).json({ status: 'sent' });
  }));

  r.post('/auth/login', ah(async (req, res) => {
    const b = body(z.object({ email, password: z.string().max(200), client }), req);
    const result = await auth.login(ctx, { ...b, ...clientInfo(req) });
    issue(res, b.client, result.token, { mfaRequired: result.mfaRequired });
  }));

  r.post('/auth/login/mfa', ah(async (req, res) => {
    const s = pendingSession(req);
    await auth.completeMfaLogin(ctx, s, body(z.object({ code }), req).code);
    res.json({ mfaRequired: false });
  }));

  r.post('/auth/logout', ah(async (req, res) => {
    if (req.session) await auth.logout(ctx, req.session);
    clearCookie(res).json({ loggedOut: true });
  }));

  r.post('/auth/logout-all', ah(async (req, res) => {
    const n = await auth.logoutAll(ctx, session(req));
    clearCookie(res).json({ sessionsRevoked: n });
  }));

  r.post('/auth/password/change', ah(async (req, res) => {
    const b = body(z.object({ currentPassword: z.string().max(200), newPassword: z.string() }), req);
    await auth.changePassword(ctx, session(req), b.currentPassword, b.newPassword);
    res.json({ changed: true });
  }));

  r.post('/auth/password/reset-request', ipRateLimit(ctx, 'reset', 10, 60), ah(async (req, res) => {
    await auth.requestPasswordReset(ctx, body(z.object({ email }), req).email);
    res.status(202).json({ status: 'sent_if_exists' });
  }));

  r.post('/auth/password/reset', ah(async (req, res) => {
    const b = body(z.object({ token: z.string().min(10).max(200), newPassword: z.string() }), req);
    await auth.resetPassword(ctx, b.token, b.newPassword);
    res.json({ reset: true });
  }));

  r.post('/auth/mfa/totp/setup', ah(async (req, res) => {
    res.json(await auth.totpSetup(ctx, session(req), body(z.object({ password: z.string().max(200) }), req).password));
  }));

  r.post('/auth/mfa/totp/confirm', ah(async (req, res) => {
    res.json(await auth.totpConfirm(ctx, session(req), body(z.object({ code }), req).code));
  }));

  r.post('/auth/mfa/backup-codes/regenerate', ah(async (req, res) => {
    const s = session(req);
    if (!auth.hasFreshStepUp(ctx, s)) throw new HttpError(403, 'STEP_UP_REQUIRED', 'Confirm with your second factor');
    res.json(await auth.regenerateBackupCodes(ctx, s));
  }));

  r.post('/auth/step-up', ah(async (req, res) => {
    const out = await auth.stepUp(ctx, session(req), body(z.object({ code }), req).code);
    res.json({ stepUpUntil: out.stepUpUntil.toISOString() });
  }));

  // ── me ──────────────────────────────────────────────────────────────────
  r.get('/me', ah(async (req, res) => {
    res.json(meView(ctx, session(req)));
  }));

  r.get('/me/sessions', ah(async (req, res) => {
    res.json({ sessions: await auth.listSessions(ctx, session(req)) });
  }));

  r.delete('/me/sessions/:id', ah(async (req, res) => {
    if (!(await auth.revokeOwnSession(ctx, session(req), uuid.parse(req.params.id)))) throw notFound('No such session');
    res.json({ revoked: true });
  }));

  r.put('/me/handle', ah(async (req, res) => {
    const s = session(req);
    await ctx.leaderboard.setHandle(s.userId, body(z.object({ handle: z.string() }), req).handle, ctx.config.currentSeason, ctx.now());
    res.json({ handle: req.body.handle });
  }));

  // ── players and lineups ─────────────────────────────────────────────────
  r.get('/seasons/:season/weeks/:week/pool', ah(async (req, res) => {
    const { season, week } = seasonWeek(req);
    res.json({ season, week, players: await getPool(ctx, session(req).userId, season, week) });
  }));

  r.get('/seasons/:season/weeks/:week/lineup', ah(async (req, res) => {
    const { season, week } = seasonWeek(req);
    res.json(await lineups.getLineup(ctx, session(req).userId, season, week));
  }));

  r.post('/seasons/:season/weeks/:week/lineup/review', ah(async (req, res) => {
    const { season, week } = seasonWeek(req);
    const b = body(z.object({ slots: slotsSchema }), req);
    res.status(201).json(await lineups.review(ctx, session(req), season, week, b.slots, clientInfo(req)));
  }));

  r.post('/lineup-confirmations/:id/acknowledge', ah(async (req, res) => {
    const b = body(z.object({ burnRules: z.boolean(), permanent: z.boolean(), noRefund: z.boolean() }), req);
    res.json(await lineups.acknowledge(ctx, session(req), uuid.parse(req.params.id), b));
  }));

  r.post('/lineup-confirmations/:id/confirm', ah(async (req, res) => {
    res.json(await lineups.confirm(ctx, session(req), uuid.parse(req.params.id)));
  }));

  r.get('/receipts/:id', ah(async (req, res) => {
    res.json(await lineups.getReceipt(ctx, session(req).userId, uuid.parse(req.params.id)));
  }));

  // ── pools: leaderboard (PRD-003) ────────────────────────────────────────
  r.get('/pools', ah(async (req, res) => {
    const s = session(req);
    const season = z.string().default(ctx.config.currentSeason).parse(req.query.season);
    const rows = await ctx.db.query<{
      id: string; name: string; buy_in_cents: number; status: string; entry_closes_at: Date; prize_pool_cents: string | null;
      capacity: number | null; entered: boolean;
    }>(
      `SELECT p.id::text AS id, p.name, p.buy_in_cents, p.status, p.entry_closes_at, p.prize_pool_cents::text, p.capacity,
              EXISTS (SELECT 1 FROM contest_entries ce WHERE ce.pool_id = p.id AND ce.user_id = $2::uuid
                        AND NOT EXISTS (SELECT 1 FROM contest_entry_voids v WHERE v.entry_id = ce.id)) AS entered
         FROM contest_pools p WHERE p.season = $1 AND p.status <> 'draft' ORDER BY p.buy_in_cents`,
      [season, s.userId]
    );
    res.json({
      pools: rows.map((p) => ({
        id: p.id, name: p.name, buyInCents: p.buy_in_cents, status: p.status, entryClosesAt: p.entry_closes_at,
        guaranteedPrizePoolCents: p.prize_pool_cents === null ? null : Number(p.prize_pool_cents), capacity: p.capacity, entered: p.entered,
      })),
    });
  }));

  r.get('/pools/:id/board', ah(async (req, res) => {
    const q = z.object({ offset: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(100).optional(), ifVersion: z.string().max(64).optional() }).parse(req.query);
    const out = await ctx.leaderboard.getBoard(session(req).userId, uuid.parse(req.params.id), q);
    if ('notModified' in out) return res.status(304).set('ETag', out.version).end();
    res.set('ETag', out.version).json(out);
  }));

  r.get('/pools/:id/me', ah(async (req, res) => {
    res.json(await ctx.leaderboard.getMe(session(req).userId, uuid.parse(req.params.id)));
  }));

  r.get('/pools/:id/weeks/:week', ah(async (req, res) => {
    const week = z.coerce.number().int().min(1).max(18).parse(req.params.week);
    res.json({ week, rows: await ctx.leaderboard.getWeek(session(req).userId, uuid.parse(req.params.id), week) });
  }));

  r.get('/pools/:id/entries/:entryId/weeks/:week/lineup', ah(async (req, res) => {
    const week = z.coerce.number().int().min(1).max(18).parse(req.params.week);
    res.json({ slots: await ctx.leaderboard.getLineup(session(req).userId, uuid.parse(req.params.id), uuid.parse(req.params.entryId), week) });
  }));

  // ── pools: payments (PRD-004) ───────────────────────────────────────────
  r.get('/pools/:id/prizes', ah(async (req, res) => {
    session(req);
    res.json(await ctx.payments.getPrizes(uuid.parse(req.params.id)));
  }));

  const safeUrl = (u: string | undefined, fallback: string) => {
    if (!u) return fallback;
    if (!u.startsWith(`${ctx.config.appBaseUrl}/`)) throw new HttpError(400, 'VALIDATION', 'Return URLs must be on the app domain');
    return u;
  };

  r.post('/pools/:id/checkout', ah(async (req, res) => {
    const s = financialSession(ctx, req);
    const b = body(z.object({
      billingRegion: z.string().trim().length(2),
      billingSubRegion: z.string().trim().max(60).optional(),
      successUrl: z.string().url().optional(),
      cancelUrl: z.string().url().optional(),
    }), req);
    const country = (req.get(ctx.config.geoCountryHeader) ?? '').toUpperCase();
    const region = (req.get(ctx.config.geoRegionHeader) ?? '').toUpperCase();
    const ipRegion = country === 'US' && /^[A-Z]{2}$/.test(region) ? region : 'XX'; // unknown → blocked (§10.4)
    const result = await ctx.payments.startCheckout({
      userId: s.userId,
      poolId: uuid.parse(req.params.id),
      ipRegion,
      billingRegion: b.billingRegion,
      billingSubRegion: b.billingSubRegion,
      stepUpAt: s.stepUpAt,
      successUrl: safeUrl(b.successUrl, `${ctx.config.appBaseUrl}/entry/success`),
      cancelUrl: safeUrl(b.cancelUrl, `${ctx.config.appBaseUrl}/entry/cancel`),
    });
    if (!result.ok) return res.status(result.reason === 'STEP_UP_REQUIRED' ? 403 : 409).json({ error: result.reason, message: 'Entry not available' });
    res.status(201).json(result);
  }));

  r.get('/me/payouts', ah(async (req, res) => {
    res.json(await ctx.payments.getMyPayouts(session(req).userId));
  }));

  r.post('/me/payout-account/link', ah(async (req, res) => {
    const s = financialSession(ctx, req);
    res.json(await ctx.payments.createPayoutOnboardingLink({ userId: s.userId, stepUpAt: s.stepUpAt, returnUrl: `${ctx.config.appBaseUrl}/payouts` }));
  }));

  r.get('/me/payouts/:id/instant-quote', ah(async (req, res) => {
    res.json(await ctx.payments.quoteInstantPayout(session(req).userId, uuid.parse(req.params.id)));
  }));

  r.post('/me/payouts/:id/instant', ah(async (req, res) => {
    const s = financialSession(ctx, req);
    const b = body(z.object({ confirmedFeeCents: z.number().int().min(0) }), req);
    await ctx.payments.requestInstantPayout({ userId: s.userId, payoutId: uuid.parse(req.params.id), stepUpAt: s.stepUpAt, confirmedFeeCents: b.confirmedFeeCents });
    res.json({ speed: 'instant' });
  }));

  // ── admin (role + step-up) ──────────────────────────────────────────────
  r.post('/admin/pools/:id/publish', ah(async (req, res) => {
    adminSession(ctx, req);
    const b = body(z.object({ capacity: z.number().int().min(1), minEntries: z.number().int().min(1), rakeBps: z.number().int().min(0).max(9999).optional() }), req);
    res.json(await ctx.payments.publishPool(uuid.parse(req.params.id), b));
  }));

  r.post('/admin/pools/:id/settlement/compute', ah(async (req, res) => {
    adminSession(ctx, req);
    res.json(await ctx.payments.computeSettlement(uuid.parse(req.params.id)));
  }));

  r.post('/admin/pools/:id/settlement/approve', ah(async (req, res) => {
    const s = adminSession(ctx, req);
    res.json(await ctx.payments.approveSettlement(uuid.parse(req.params.id), { userId: s.userId, stepUpAt: s.stepUpAt }));
  }));

  r.get('/admin/integrity', ah(async (req, res) => {
    adminSession(ctx, req);
    res.json(await ctx.payments.runIntegrityCheck());
  }));

  r.post('/admin/transfers', ah(async (req, res) => {
    adminSession(ctx, req);
    const b = body(z.object({ from: z.enum(['operating_bank', 'prize_bank']), to: z.enum(['operating_bank', 'prize_bank']), amountCents: z.number().int().min(1), reference: z.string().min(3).max(100) }), req);
    res.json({ posted: await ctx.payments.recordTransfer(b) });
  }));

  r.post('/admin/identity-verifications', ah(async (req, res) => {
    const s = adminSession(ctx, req);
    const b = body(z.object({
      userId: uuid, providerRef: z.string().min(3).max(255), providerPersonId: z.string().min(3).max(255),
      birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), region: z.string().length(2),
    }), req);
    await ctx.payments.recordIdentityVerification({ ...b, provider: 'manual' });
    ctx.log('info', 'manual identity verification recorded', { by: s.userId, userId: b.userId });
    res.status(201).json({ verified: true });
  }));

  r.post('/admin/users/:id/suspend', ah(async (req, res) => {
    const s = adminSession(ctx, req);
    await auth.suspendUser(ctx, s, uuid.parse(req.params.id), body(z.object({ reason: z.string().min(3).max(500) }), req).reason);
    res.json({ suspended: true });
  }));

  return r;
}
