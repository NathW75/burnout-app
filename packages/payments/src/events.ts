/**
 * Processor webhooks — PRD-004 §7.2, §8.3, §10
 *
 * Each event is stored once under (processor, event_id), then handled in one
 * transaction with a row lock on the stored event, so duplicates and
 * concurrent deliveries post exactly once. A handler that finds its
 * precondition not yet met returns 'retry' and the event stays unprocessed.
 */
import { ACTIVE_ENTRY, lockPool, notify, type PaymentsContext } from './context';
import { acct, credit, debit, post } from './ledger';
import { liveHoldCount, activeEntryCount } from './pools';
import { reviveEvent, type ProcessorEvent } from './processor';
import { refundUnenteredPayment, type RefundReason } from './refunds';
import type { SqlRunner } from './sql';

type Outcome = 'done' | 'retry';
export type WebhookResult = { status: 'processed' | 'duplicate' | 'deferred'; eventId: string; type: string };

export async function handleWebhook(ctx: PaymentsContext, rawBody: Buffer, headers: Record<string, string>): Promise<WebhookResult> {
  const event = ctx.processor.parseWebhook(rawBody, headers); // throws on a bad signature
  await ctx.db.query(
    `INSERT INTO processor_events (processor, event_id, type, payload, received_at)
     VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (processor, event_id) DO NOTHING`,
    [ctx.processor.name, event.eventId, event.type, JSON.stringify(event), ctx.now()]
  );
  return processStoredEvent(ctx, event.eventId);
}

/** Re-runs events left unprocessed (precondition not met, or a crash mid-handling). */
export async function retryUnprocessedEvents(ctx: PaymentsContext): Promise<WebhookResult[]> {
  const rows = await ctx.db.query<{ event_id: string }>(
    `SELECT event_id FROM processor_events WHERE processor = $1 AND processed_at IS NULL ORDER BY received_at`,
    [ctx.processor.name]
  );
  const out: WebhookResult[] = [];
  for (const r of rows) out.push(await processStoredEvent(ctx, r.event_id));
  return out;
}

async function processStoredEvent(ctx: PaymentsContext, eventId: string): Promise<WebhookResult> {
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx.query<{ payload: unknown; processed_at: Date | null; type: string }>(
      `SELECT payload, processed_at, type FROM processor_events WHERE processor = $1 AND event_id = $2 FOR UPDATE`,
      [ctx.processor.name, eventId]
    );
    if (row.processed_at) return { status: 'duplicate' as const, eventId, type: row.type };
    const event = reviveEvent(row.payload);
    const outcome = await dispatch(tx, ctx, event);
    if (outcome === 'retry') {
      ctx.log('warn', `event ${eventId} (${event.type}) deferred: precondition not met`);
      return { status: 'deferred' as const, eventId, type: row.type };
    }
    await tx.query(`UPDATE processor_events SET processed_at = $3 WHERE processor = $1 AND event_id = $2`, [ctx.processor.name, eventId, ctx.now()]);
    return { status: 'processed' as const, eventId, type: row.type };
  });
}

function dispatch(tx: SqlRunner, ctx: PaymentsContext, e: ProcessorEvent): Promise<Outcome> {
  switch (e.type) {
    case 'payment_captured': return onCaptured(tx, ctx, e);
    case 'payment_failed': return onFailed(tx, e);
    case 'fee_reported': return onFee(tx, ctx, e);
    case 'funds_settled': return onFundsSettled(tx, ctx, e);
    case 'refund_succeeded': return onRefundSucceeded(tx, e);
    case 'dispute_opened': return onDisputeOpened(tx, e);
    case 'dispute_closed': return onDisputeClosed(tx, ctx, e);
    case 'payout_paid': return onPayoutPaid(tx, e);
    case 'payout_failed': return onPayoutFailed(tx, e);
    case 'account_updated': return onAccountUpdated(tx, ctx, e);
  }
}

// ── capture (§8.3) ──────────────────────────────────────────────────────────

interface IntentRow {
  id: string; user_id: string; pool_id: string; amount_cents: number; rake_cents: number;
  status: string; payment_ref: string | null; hold_expires_at: Date;
}

async function onCaptured(tx: SqlRunner, ctx: PaymentsContext, e: Extract<ProcessorEvent, { type: 'payment_captured' }>): Promise<Outcome> {
  const [i] = await tx.query<IntentRow>(
    `SELECT id::text AS id, user_id::text AS user_id, pool_id::text AS pool_id, amount_cents, rake_cents, status, payment_ref, hold_expires_at
       FROM entry_intents WHERE id = $1::uuid FOR UPDATE`,
    [e.intentId]
  );
  if (!i) {
    ctx.log('error', `capture ${e.paymentRef} for unknown intent ${e.intentId}`);
    return 'retry';
  }
  if (i.payment_ref === e.paymentRef) return 'done'; // same payment delivered under another event id
  const pool = await lockPool(tx, i.pool_id);

  const reject = async (reason: RefundReason, intentStatus: 'refunded' | null) => {
    if (intentStatus) {
      await tx.query(
        `UPDATE entry_intents SET status = 'refunded', payment_ref = $2, captured_at = $3 WHERE id = $1::uuid`,
        [i.id, e.paymentRef, e.occurredAt]
      );
    }
    await refundUnenteredPayment(tx, { userId: i.user_id, intentId: i.id, poolId: i.pool_id, paymentRef: e.paymentRef, amountCents: e.amountCents, reason, now: ctx.now() });
    ctx.log('warn', `capture ${e.paymentRef} refunded: ${reason}`, { intentId: i.id });
    return 'done' as const;
  };

  // A second payment for an intent that already has one: refund it, leave the intent alone.
  if (i.status === 'captured' || i.status === 'refunded') return reject('DUPLICATE_CHARGE', null);
  if (e.amountCents !== i.amount_cents) return reject('PLATFORM_ERROR', 'refunded');

  const [dup] = await tx.query<{ entered: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM contest_entries ce WHERE ce.pool_id = $1::uuid AND ce.user_id = $2::uuid AND ${ACTIVE_ENTRY}) AS entered`,
    [i.pool_id, i.user_id]
  );
  if (dup.entered) return reject('DUPLICATE_CHARGE', 'refunded');

  if (!pool || pool.status !== 'open' || e.occurredAt >= pool.entry_closes_at) return reject('CAPTURE_AFTER_CLOSE', 'refunded');
  const seatHeld = i.status === 'pending' && i.hold_expires_at > e.occurredAt;
  if (!seatHeld) {
    const taken = (await activeEntryCount(tx, i.pool_id)) + (await liveHoldCount(tx, i.pool_id, ctx.now(), i.id));
    if (taken >= pool.capacity!) return reject('CAPTURE_AFTER_CLOSE', 'refunded');
  }

  await tx.query(
    `UPDATE entry_intents SET status = 'captured', payment_ref = $2, captured_at = $3 WHERE id = $1::uuid`,
    [i.id, e.paymentRef, e.occurredAt]
  );
  const contribution = i.amount_cents - i.rake_cents;
  await post(tx, {
    kind: 'capture', refType: 'payment', refId: e.paymentRef, idempotencyKey: `capture:${e.paymentRef}`, occurredAt: e.occurredAt,
    postings: [
      debit(acct.clearingPrize, contribution),
      debit(acct.clearingOperating, i.rake_cents),
      credit(acct.prizeLiability(i.pool_id), contribution),
      credit(acct.rakeRevenue, i.rake_cents),
    ],
  });
  await tx.query(`INSERT INTO contest_entries (pool_id, user_id, entered_at) VALUES ($1, $2, $3)`, [i.pool_id, i.user_id, e.occurredAt]);
  await notify(tx, i.user_id, 'ENTRY_RECEIPT', {
    poolId: i.pool_id, poolName: pool.name, entryFeeCents: i.amount_cents, serviceFeeCents: i.rake_cents,
    prizeContributionCents: contribution, guaranteedPrizePoolCents: Number(pool.prize_pool_cents),
  });
  return 'done';
}

async function onFailed(tx: SqlRunner, e: Extract<ProcessorEvent, { type: 'payment_failed' }>): Promise<Outcome> {
  await tx.query(`UPDATE entry_intents SET status = 'failed' WHERE id = $1::uuid AND status = 'pending'`, [e.intentId]);
  return 'done';
}

// ── fees and fund movements (§6.3) ──────────────────────────────────────────

async function onFee(tx: SqlRunner, ctx: PaymentsContext, e: Extract<ProcessorEvent, { type: 'fee_reported' }>): Promise<Outcome> {
  await post(tx, {
    kind: 'fee', refType: 'payment', refId: e.paymentRef, idempotencyKey: `fee:${ctx.processor.name}:${e.eventId}`, occurredAt: e.occurredAt,
    postings: [debit(acct.processingFees, e.feeCents), credit(acct.clearingOperating, e.feeCents)],
  });
  return 'done';
}

async function onFundsSettled(tx: SqlRunner, ctx: PaymentsContext, e: Extract<ProcessorEvent, { type: 'funds_settled' }>): Promise<Outcome> {
  await post(tx, {
    kind: 'funds_settled', refType: 'processor_event', refId: e.eventId, idempotencyKey: `funds_settled:${ctx.processor.name}:${e.eventId}`, occurredAt: e.occurredAt,
    postings: [
      debit(acct.prizeBank, e.prizeCents),
      debit(acct.operatingBank, e.operatingCents),
      credit(acct.clearingPrize, e.prizeCents),
      credit(acct.clearingOperating, e.operatingCents),
    ],
  });
  return 'done';
}

async function onRefundSucceeded(tx: SqlRunner, e: Extract<ProcessorEvent, { type: 'refund_succeeded' }>): Promise<Outcome> {
  const [r] = await tx.query<{ id: string; user_id: string; amount_cents: number; prize_share_cents: number }>(
    `UPDATE refunds SET status = 'succeeded', succeeded_at = $2 WHERE refund_ref = $1 AND status = 'pending'
     RETURNING id::text AS id, user_id::text AS user_id, amount_cents, prize_share_cents`,
    [e.refundRef, e.occurredAt]
  );
  if (!r) {
    const [known] = await tx.query(`SELECT 1 FROM refunds WHERE refund_ref = $1`, [e.refundRef]);
    return known ? 'done' : 'retry'; // unknown ref: our refund call hasn't stored it yet
  }
  await post(tx, {
    kind: 'refund_confirmed', refType: 'refund', refId: r.id, idempotencyKey: `refund_confirmed:${r.id}`, occurredAt: e.occurredAt,
    postings: [
      debit(acct.refundPayable(r.user_id), r.amount_cents),
      credit(acct.clearingPrize, r.prize_share_cents),
      credit(acct.clearingOperating, r.amount_cents - r.prize_share_cents),
    ],
  });
  return 'done';
}

// ── disputes (§10.4) ────────────────────────────────────────────────────────

async function paymentOwner(tx: SqlRunner, paymentRef: string): Promise<string | null> {
  const [r] = await tx.query<{ user_id: string }>(
    `SELECT user_id::text AS user_id FROM entry_intents WHERE payment_ref = $1
     UNION ALL SELECT user_id::text FROM refunds WHERE payment_ref = $1 LIMIT 1`,
    [paymentRef]
  );
  return r?.user_id ?? null;
}

async function onDisputeOpened(tx: SqlRunner, e: Extract<ProcessorEvent, { type: 'dispute_opened' }>): Promise<Outcome> {
  const userId = await paymentOwner(tx, e.paymentRef);
  if (!userId) return 'retry';
  await tx.query(
    `INSERT INTO account_holds (user_id, reason, ref_id, opened_at)
     SELECT $1::uuid, 'DISPUTE', $2::text, $3::timestamptz
      WHERE NOT EXISTS (SELECT 1 FROM account_holds WHERE reason = 'DISPUTE' AND ref_id = $2::text AND closed_at IS NULL)`,
    [userId, e.paymentRef, e.occurredAt]
  );
  return 'done';
}

async function onDisputeClosed(tx: SqlRunner, ctx: PaymentsContext, e: Extract<ProcessorEvent, { type: 'dispute_closed' }>): Promise<Outcome> {
  const userId = await paymentOwner(tx, e.paymentRef);
  if (!userId) return 'retry';
  if (e.outcome === 'won') {
    await tx.query(
      `UPDATE account_holds SET closed_at = $2 WHERE reason = 'DISPUTE' AND ref_id = $1 AND closed_at IS NULL`,
      [e.paymentRef, e.occurredAt]
    );
    await post(tx, {
      kind: 'fee', refType: 'payment', refId: e.paymentRef, idempotencyKey: `dispute_fee:${ctx.processor.name}:${e.eventId}`, occurredAt: e.occurredAt,
      postings: [debit(acct.processingFees, e.feeCents), credit(acct.clearingOperating, e.feeCents)],
    });
    return 'done';
  }
  // Lost: the platform absorbs it. The prize pool is never reduced; the hold stays (winnings held, §10.4).
  const [amt] = await tx.query<{ amount_cents: number }>(
    `SELECT amount_cents FROM entry_intents WHERE payment_ref = $1 UNION ALL SELECT amount_cents FROM refunds WHERE payment_ref = $1 LIMIT 1`,
    [e.paymentRef]
  );
  const loss = amt.amount_cents + e.feeCents;
  await post(tx, {
    kind: 'chargeback_lost', refType: 'payment', refId: e.paymentRef, idempotencyKey: `chargeback_lost:${e.paymentRef}`, occurredAt: e.occurredAt,
    postings: [debit(acct.chargebackLoss, loss), credit(acct.clearingOperating, loss)],
  });
  return 'done';
}

// ── payouts (§10.2) ─────────────────────────────────────────────────────────

async function onPayoutPaid(tx: SqlRunner, e: Extract<ProcessorEvent, { type: 'payout_paid' }>): Promise<Outcome> {
  const [p] = await tx.query<{ id: string; user_id: string; amount_cents: string; status: string }>(
    `SELECT id::text AS id, user_id::text AS user_id, amount_cents::text AS amount_cents, status FROM payouts WHERE payout_ref = $1 FOR UPDATE`,
    [e.payoutRef]
  );
  if (!p) return 'retry'; // sendPayout returned but the ref isn't stored yet
  if (p.status !== 'sent') return 'done';
  await tx.query(`UPDATE payouts SET status = 'paid', paid_at = $2 WHERE id = $1::uuid`, [p.id, e.occurredAt]);
  await post(tx, {
    kind: 'payout_paid', refType: 'payout', refId: p.id, idempotencyKey: `payout_paid:${p.id}`, occurredAt: e.occurredAt,
    postings: [debit(acct.payable(p.user_id), Number(p.amount_cents)), credit(acct.prizeBank, Number(p.amount_cents))],
  });
  return 'done';
}

async function onPayoutFailed(tx: SqlRunner, e: Extract<ProcessorEvent, { type: 'payout_failed' }>): Promise<Outcome> {
  const [p] = await tx.query<{ id: string; user_id: string; pool_id: string; amount_cents: string; status: string }>(
    `SELECT id::text AS id, user_id::text AS user_id, pool_id::text AS pool_id, amount_cents::text AS amount_cents, status
       FROM payouts WHERE payout_ref = $1 FOR UPDATE`,
    [e.payoutRef]
  );
  if (!p) return 'retry';
  if (p.status === 'failed') return 'done';
  await tx.query(`UPDATE payouts SET status = 'failed', failure_reason = $2 WHERE id = $1::uuid`, [p.id, e.reason.slice(0, 255)]);
  if (p.status === 'paid') {
    // Returned after it was paid: the money is back in the prize bank and owed to the user again.
    await post(tx, {
      kind: 'payout_returned', refType: 'payout', refId: p.id, idempotencyKey: `payout_returned:${p.id}`, occurredAt: e.occurredAt,
      postings: [debit(acct.prizeBank, Number(p.amount_cents)), credit(acct.payable(p.user_id), Number(p.amount_cents))],
    });
  }
  await notify(tx, p.user_id, 'PAYOUT_FAILED', { poolId: p.pool_id, amountCents: Number(p.amount_cents), reason: e.reason });
  return 'done';
}

async function onAccountUpdated(tx: SqlRunner, ctx: PaymentsContext, e: Extract<ProcessorEvent, { type: 'account_updated' }>): Promise<Outcome> {
  await tx.query(
    `INSERT INTO payout_accounts (user_id, processor, account_ref, payouts_enabled, tin_verified, instant_eligible, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id) DO UPDATE SET processor = EXCLUDED.processor, account_ref = EXCLUDED.account_ref,
       payouts_enabled = EXCLUDED.payouts_enabled, tin_verified = EXCLUDED.tin_verified,
       instant_eligible = EXCLUDED.instant_eligible, updated_at = EXCLUDED.updated_at
     WHERE payout_accounts.updated_at <= EXCLUDED.updated_at`,
    [e.userId, ctx.processor.name, e.accountRef, e.status.payoutsEnabled, e.status.tinVerified, e.status.instantEligible, e.occurredAt]
  );
  return 'done';
}
