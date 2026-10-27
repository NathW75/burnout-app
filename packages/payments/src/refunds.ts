/**
 * Refunds — PRD-004 §10.3
 *
 * Every refund returns the full buy-in; the platform absorbs the processing
 * fee. The database state and ledger posting happen in the caller's
 * transaction; the processor call happens afterwards (sendPendingRefunds),
 * keyed by the refund id so retries are safe.
 */
import { lockPool, notify, PaymentsError, type PaymentsContext } from './context';
import { acct, credit, debit, post } from './ledger';
import type { SqlRunner } from './sql';

export type RefundReason = 'CAPTURE_AFTER_CLOSE' | 'POOL_CANCELLED' | 'DUPLICATE_CHARGE' | 'PLATFORM_ERROR';

interface IntentRow {
  id: string;
  user_id: string;
  pool_id: string;
  amount_cents: number;
  rake_cents: number;
  payment_ref: string | null;
}

/**
 * Refunds an entry that was captured and entered: reverses the capture
 * (prize liability + rake → refund payable), voids the entry, and queues the
 * processor refund. No-op if the intent is not currently captured.
 */
export async function refundCapturedIntent(tx: SqlRunner, intentId: string, reason: RefundReason, now: Date): Promise<boolean> {
  const [i] = await tx.query<IntentRow>(
    `UPDATE entry_intents SET status = 'refunded' WHERE id = $1::uuid AND status = 'captured'
     RETURNING id::text AS id, user_id::text AS user_id, pool_id::text AS pool_id, amount_cents, rake_cents, payment_ref`,
    [intentId]
  );
  if (!i) return false;
  const contribution = i.amount_cents - i.rake_cents;
  await post(tx, {
    kind: 'refund_entry', refType: 'entry_intent', refId: i.id, idempotencyKey: `refund_entry:${i.id}`, occurredAt: now,
    postings: [
      debit(acct.prizeLiability(i.pool_id), contribution),
      debit(acct.rakeRevenue, i.rake_cents),
      credit(acct.refundPayable(i.user_id), i.amount_cents),
    ],
  });
  await tx.query(
    `INSERT INTO contest_entry_voids (entry_id, reason, voided_at)
     SELECT ce.id, $3, $4 FROM contest_entries ce WHERE ce.pool_id = $1::uuid AND ce.user_id = $2::uuid
     ON CONFLICT (entry_id) DO NOTHING`,
    [i.pool_id, i.user_id, reason, now]
  );
  await insertRefund(tx, { userId: i.user_id, intentId: i.id, paymentRef: i.payment_ref!, amountCents: i.amount_cents, prizeShareCents: contribution, reason, now });
  await notify(tx, i.user_id, 'REFUND', { poolId: i.pool_id, amountCents: i.amount_cents, reason });
  return true;
}

/**
 * Refunds a payment that never became an entry (capture after close, pool
 * full, already entered, amount mismatch). The money never reached the
 * prize pool: clearing → refund payable, so the user's ledger nets to zero.
 */
export async function refundUnenteredPayment(
  tx: SqlRunner,
  p: { userId: string; intentId: string; poolId: string; paymentRef: string; amountCents: number; reason: RefundReason; now: Date }
): Promise<void> {
  await post(tx, {
    kind: 'capture_rejected', refType: 'payment', refId: p.paymentRef, idempotencyKey: `capture_rejected:${p.paymentRef}`, occurredAt: p.now,
    postings: [debit(acct.clearingOperating, p.amountCents), credit(acct.refundPayable(p.userId), p.amountCents)],
  });
  await insertRefund(tx, { ...p, prizeShareCents: 0 });
  await notify(tx, p.userId, 'REFUND', { poolId: p.poolId, amountCents: p.amountCents, reason: p.reason });
}

async function insertRefund(
  tx: SqlRunner,
  r: { userId: string; intentId: string; paymentRef: string; amountCents: number; prizeShareCents: number; reason: RefundReason; now: Date }
): Promise<void> {
  await tx.query(
    `INSERT INTO refunds (user_id, intent_id, payment_ref, amount_cents, prize_share_cents, reason, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`,
    [r.userId, r.intentId, r.paymentRef, r.amountCents, r.prizeShareCents, r.reason, r.now]
  );
}

/** Calls the processor for refunds not yet sent. Failures stay pending and are retried on the next run. */
export async function sendPendingRefunds(ctx: PaymentsContext): Promise<number> {
  const pending = await ctx.db.query<{ id: string; payment_ref: string; amount_cents: number }>(
    `SELECT id::text AS id, payment_ref, amount_cents FROM refunds WHERE status = 'pending' AND refund_ref IS NULL ORDER BY created_at`
  );
  let sent = 0;
  for (const r of pending) {
    try {
      const { refundRef } = await ctx.processor.refund({ paymentRef: r.payment_ref, amountCents: r.amount_cents, idempotencyKey: `refund:${r.id}` });
      await ctx.db.query(`UPDATE refunds SET refund_ref = $2 WHERE id = $1::uuid AND refund_ref IS NULL`, [r.id, refundRef]);
      sent++;
    } catch (err) {
      ctx.log('error', `refund ${r.id} not sent; will retry`, { error: String(err) });
    }
  }
  return sent;
}

/** Ops refund for platform error (§10.3). Only before entry close; the void trigger enforces it too. */
export async function refundForPlatformError(ctx: PaymentsContext, intentId: string, reason: string): Promise<void> {
  if (!reason.trim()) throw new PaymentsError('REASON_REQUIRED', 'a written reason is required');
  await ctx.db.transaction(async (tx) => {
    const [i] = await tx.query<{ pool_id: string }>(`SELECT pool_id::text AS pool_id FROM entry_intents WHERE id = $1::uuid`, [intentId]);
    if (!i) throw new PaymentsError('INTENT_NOT_FOUND', intentId);
    const pool = await lockPool(tx, i.pool_id);
    const now = ctx.now();
    if (!pool || pool.status !== 'open' || now >= pool.entry_closes_at) {
      throw new PaymentsError('ENTRY_CLOSED', 'platform-error refunds are only possible before entry close');
    }
    if (!(await refundCapturedIntent(tx, intentId, 'PLATFORM_ERROR', now))) {
      throw new PaymentsError('NOT_REFUNDABLE', `intent ${intentId} is not a captured entry`);
    }
    ctx.log('warn', `platform-error refund for intent ${intentId}`, { reason });
  });
  await sendPendingRefunds(ctx);
}
