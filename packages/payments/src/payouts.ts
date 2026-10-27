/**
 * Payouts — PRD-004 §10.1, §10.2
 *
 * One payout per award. A payout exists only for a user whose payout
 * account has payoutsEnabled AND tinVerified (W-9 on file) and who has no
 * open hold. Everyone else's award stays in payable:{user}.
 */
import { hasOpenHold, notify, PaymentsError, requireStepUp, type PaymentsContext } from './context';
import { checkJurisdiction } from './checkout';
import type { SqlRunner } from './sql';

async function payoutEligible(q: SqlRunner, userId: string): Promise<{ ok: boolean; missing: string[] }> {
  const [a] = await q.query<{ payouts_enabled: boolean; tin_verified: boolean }>(
    `SELECT payouts_enabled, tin_verified FROM payout_accounts WHERE user_id = $1::uuid`,
    [userId]
  );
  const missing: string[] = [];
  if (!a?.payouts_enabled) missing.push('BANK_ACCOUNT');
  if (!a?.tin_verified) missing.push('W9');
  if (await hasOpenHold(q, userId)) missing.push('ACCOUNT_HOLD');
  return { ok: missing.length === 0, missing };
}

interface OpenAward {
  pool_id: string;
  user_id: string;
  amount: string;
  approved_at: Date;
  pool_name: string;
}

/** Approved awards with no live payout (pending / sent / paid). */
async function openAwards(q: SqlRunner, userId?: string): Promise<OpenAward[]> {
  return q.query<OpenAward>(
    `SELECT a.pool_id::text AS pool_id, a.user_id::text AS user_id, SUM(a.amount_cents)::text AS amount, s.approved_at, p.name AS pool_name
       FROM settlement_awards a
       JOIN settlements s ON s.pool_id = a.pool_id AND s.status = 'approved'
       JOIN contest_pools p ON p.id = a.pool_id
      WHERE a.amount_cents > 0 AND ($1::uuid IS NULL OR a.user_id = $1::uuid)
        AND NOT EXISTS (SELECT 1 FROM payouts po WHERE po.pool_id = a.pool_id AND po.user_id = a.user_id AND po.status IN ('pending', 'sent', 'paid'))
      GROUP BY a.pool_id, a.user_id, s.approved_at, p.name`,
    [userId ?? null]
  );
}

/**
 * Creates pending payouts for eligible winners and sends blocked winners
 * their notice / reminders (day 0, 1, 7, 30 after approval by default).
 */
export async function queuePayouts(ctx: PaymentsContext, opts: { userId?: string } = {}): Promise<{ queued: number; blocked: number }> {
  const now = ctx.now();
  let queued = 0;
  let blocked = 0;
  for (const award of await openAwards(ctx.db, opts.userId)) {
    await ctx.db.transaction(async (tx) => {
      const elig = await payoutEligible(tx, award.user_id);
      // After a failed payout, wait for the user to update their payout account before trying again.
      const [retryBlocked] = await tx.query<{ blocked: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM payouts po
            WHERE po.pool_id = $1::uuid AND po.user_id = $2::uuid AND po.status = 'failed'
              AND NOT EXISTS (SELECT 1 FROM payout_accounts pa WHERE pa.user_id = po.user_id AND pa.updated_at > COALESCE(po.sent_at, po.created_at))
              AND po.attempt = (SELECT max(attempt) FROM payouts WHERE pool_id = $1::uuid AND user_id = $2::uuid)) AS blocked`,
        [award.pool_id, award.user_id]
      );
      if (retryBlocked.blocked) {
        elig.ok = false;
        elig.missing.push('PAYOUT_ACCOUNT_UPDATE');
      }
      if (elig.ok) {
        const [{ n }] = await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM payouts WHERE pool_id = $1::uuid AND user_id = $2::uuid`,
          [award.pool_id, award.user_id]
        );
        const attempt = n + 1;
        const rows = await tx.query(
          `INSERT INTO payouts (user_id, pool_id, attempt, amount_cents, speed, status, idempotency_key, created_at)
           VALUES ($1, $2, $3, $4, 'standard', 'pending', $5, $6) ON CONFLICT DO NOTHING RETURNING 1`,
          [award.user_id, award.pool_id, attempt, award.amount, `payout:${award.pool_id}:${award.user_id}:${attempt}`, now]
        );
        queued += rows.length;
        return;
      }
      blocked++;
      const elapsedDays = Math.floor((now.getTime() - award.approved_at.getTime()) / 86_400_000);
      for (const day of ctx.config.payoutReminderDays.filter((d) => d <= elapsedDays)) {
        await tx.query(
          `INSERT INTO notification_queue (user_id, kind, payload)
           SELECT $1, 'PAYOUT_BLOCKED', $2::jsonb
            WHERE NOT EXISTS (SELECT 1 FROM notification_queue WHERE user_id = $1::uuid AND kind = 'PAYOUT_BLOCKED'
                                AND payload->>'poolId' = $3 AND (payload->>'day')::int = $4)`,
          [award.user_id, JSON.stringify({ poolId: award.pool_id, poolName: award.pool_name, amountCents: Number(award.amount), missing: elig.missing, day }), award.pool_id, day]
        );
      }
    });
  }
  return { queued, blocked };
}

/** Sends pending payouts to the processor. Each call is keyed, so a retry after a crash can't pay twice. */
export async function sendPendingPayouts(ctx: PaymentsContext): Promise<number> {
  const pending = await ctx.db.query<{ id: string; user_id: string; pool_id: string; amount_cents: string; speed: 'standard' | 'instant'; idempotency_key: string }>(
    `SELECT id::text AS id, user_id::text AS user_id, pool_id::text AS pool_id, amount_cents::text AS amount_cents, speed, idempotency_key
       FROM payouts WHERE status = 'pending' ORDER BY created_at`
  );
  let sent = 0;
  for (const p of pending) {
    if (!(await payoutEligible(ctx.db, p.user_id)).ok) continue; // e.g. a dispute opened since queueing
    try {
      const res = await ctx.processor.sendPayout({ payoutId: p.id, userId: p.user_id, amountCents: Number(p.amount_cents), speed: p.speed, idempotencyKey: p.idempotency_key });
      await ctx.db.transaction(async (tx) => {
        const rows = await tx.query(
          `UPDATE payouts SET status = 'sent', payout_ref = $2, fee_cents = $3, sent_at = $4 WHERE id = $1::uuid AND status = 'pending' RETURNING 1`,
          [p.id, res.payoutRef, res.feeCents, ctx.now()]
        );
        if (rows.length) {
          await notify(tx, p.user_id, 'PAYOUT_SENT', { poolId: p.pool_id, amountCents: Number(p.amount_cents), feeCents: res.feeCents, speed: p.speed });
          sent++;
        }
      });
    } catch (err) {
      ctx.log('error', `payout ${p.id} not sent; will retry`, { error: String(err) });
    }
  }
  return sent;
}

/** Fee for switching a pending payout to instant, shown before the user confirms. */
export async function quoteInstantPayout(ctx: PaymentsContext, userId: string, payoutId: string): Promise<{ amountCents: number; feeCents: number; netCents: number }> {
  const [p] = await ctx.db.query<{ amount_cents: string; status: string; instant_eligible: boolean | null }>(
    `SELECT po.amount_cents::text AS amount_cents, po.status, pa.instant_eligible
       FROM payouts po LEFT JOIN payout_accounts pa ON pa.user_id = po.user_id
      WHERE po.id = $1::uuid AND po.user_id = $2::uuid`,
    [payoutId, userId]
  );
  if (!p || p.status !== 'pending') throw new PaymentsError('PAYOUT_NOT_PENDING', payoutId);
  if (!p.instant_eligible) throw new PaymentsError('INSTANT_NOT_AVAILABLE', 'this payout account does not support instant payouts');
  const amount = Number(p.amount_cents);
  const fee = ctx.processor.instantPayoutFeeCents(amount);
  return { amountCents: amount, feeCents: fee, netCents: amount - fee };
}

/** User opts into instant payout (user-paid fee, D12). The fee they confirmed must still be the fee. */
export async function requestInstantPayout(
  ctx: PaymentsContext,
  req: { userId: string; payoutId: string; stepUpAt: Date | null; confirmedFeeCents: number }
): Promise<void> {
  requireStepUp(ctx, req.stepUpAt);
  const quote = await quoteInstantPayout(ctx, req.userId, req.payoutId);
  if (quote.feeCents !== req.confirmedFeeCents) throw new PaymentsError('INSTANT_FEE_CHANGED', `fee is now ${quote.feeCents}`);
  const rows = await ctx.db.query(
    `UPDATE payouts SET speed = 'instant' WHERE id = $1::uuid AND user_id = $2::uuid AND status = 'pending' RETURNING 1`,
    [req.payoutId, req.userId]
  );
  if (!rows.length) throw new PaymentsError('PAYOUT_NOT_PENDING', req.payoutId);
}

/** POST /me/payout-account/link: bank account + W-9 onboarding, hosted by the processor. */
export async function createPayoutOnboardingLink(ctx: PaymentsContext, req: { userId: string; stepUpAt: Date | null; returnUrl: string }): Promise<{ url: string }> {
  requireStepUp(ctx, req.stepUpAt);
  const [idv] = await ctx.db.query<{ verified_region: string }>(
    `SELECT verified_region FROM identity_verifications WHERE user_id = $1::uuid AND status = 'verified'`,
    [req.userId]
  );
  if (!idv) throw new PaymentsError('IDENTITY_UNVERIFIED', 'verify your identity first');
  if (!(await checkJurisdiction(ctx.db, idv.verified_region, undefined, ctx.now())).allowed) {
    throw new PaymentsError('JURISDICTION_BLOCKED', `payouts are not available in ${idv.verified_region}`);
  }
  return ctx.processor.createPayoutOnboardingLink({ userId: req.userId, returnUrl: req.returnUrl });
}

/** GET /me/payouts: awards, payout status, and what is blocking a payout. */
export async function getMyPayouts(ctx: PaymentsContext, userId: string) {
  const awards = await ctx.db.query<{ pool_id: string; pool_name: string; amount: string; rank: number; tie_size: number }>(
    `SELECT a.pool_id::text AS pool_id, p.name AS pool_name, a.amount_cents::text AS amount, a.rank, a.tie_size
       FROM settlement_awards a JOIN settlements s ON s.pool_id = a.pool_id AND s.status = 'approved'
       JOIN contest_pools p ON p.id = a.pool_id
      WHERE a.user_id = $1::uuid AND a.amount_cents > 0 ORDER BY s.approved_at`,
    [userId]
  );
  const payouts = await ctx.db.query<{ id: string; pool_id: string; status: string; speed: string; amount_cents: string; fee_cents: string; failure_reason: string | null }>(
    `SELECT id::text AS id, pool_id::text AS pool_id, status, speed, amount_cents::text, fee_cents::text, failure_reason
       FROM payouts WHERE user_id = $1::uuid ORDER BY created_at`,
    [userId]
  );
  const elig = await payoutEligible(ctx.db, userId);
  return {
    blockedBy: elig.missing,
    awards: awards.map((a) => ({
      poolId: a.pool_id, poolName: a.pool_name, amountCents: Number(a.amount), rank: a.rank, tieSize: a.tie_size,
      payouts: payouts.filter((p) => p.pool_id === a.pool_id).map((p) => ({
        id: p.id, status: p.status, speed: p.speed, amountCents: Number(p.amount_cents), feeCents: Number(p.fee_cents), failureReason: p.failure_reason,
      })),
    })),
  };
}
