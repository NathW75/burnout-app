/**
 * Pool publication and entry close — PRD-004 §5, §6.3, §10.3
 */
import { ACTIVE_ENTRY, lockPool, notify, PaymentsError, type PaymentsContext } from './context';
import { acct, credit, debit, owed, post } from './ledger';
import { computePrizeTable, defaultRakeBps, type PrizeBand, type PrizeTable } from './prize-table';
import { refundCapturedIntent } from './refunds';
import type { SqlRunner } from './sql';

/**
 * Late entry and free play close at this week's first lock (PRD-004 D7,
 * decision 2026-10-27: free play is Weeks 1–2).
 */
export const PAID_ENTRY_CUTOFF_WEEK = 3;

export interface PublishTerms {
  capacity: number;
  minEntries: number;
  /** Defaults to the §4.2 schedule. */
  rakeBps?: number;
}

/**
 * Computes the prize table, stores it, and opens the pool. After this the
 * money terms and the table are frozen by the database.
 */
export async function publishPool(ctx: PaymentsContext, poolId: string, terms: PublishTerms): Promise<PrizeTable> {
  return ctx.db.transaction(async (tx) => {
    const pool = await lockPool(tx, poolId);
    if (!pool) throw new PaymentsError('POOL_NOT_FOUND', poolId);
    if (pool.status !== 'draft') throw new PaymentsError('POOL_PUBLISHED', `pool ${poolId} is ${pool.status}`);
    const rakeBps = terms.rakeBps ?? defaultRakeBps(pool.buy_in_cents);
    const table = computePrizeTable({ capacity: terms.capacity, buyInCents: pool.buy_in_cents, rakeBps });
    if (!Number.isInteger(terms.minEntries) || terms.minEntries < table.paidPlaces || terms.minEntries > terms.capacity) {
      throw new PaymentsError(
        'MIN_ENTRIES_RANGE',
        `minimum field must be between the paid places (${table.paidPlaces}) and capacity (${terms.capacity})`
      );
    }
    await tx.query(
      `UPDATE contest_pools SET capacity = $2, min_entries = $3, rake_bps = $4, prize_pool_cents = $5, paid_places = $6,
              min_cash_cents = $7, prize_algorithm = $8 WHERE id = $1::uuid`,
      [poolId, terms.capacity, terms.minEntries, rakeBps, table.prizePoolCents, table.paidPlaces, table.minCashCents, table.algorithm]
    );
    await tx.query(
      `INSERT INTO prize_table_bands (pool_id, from_place, to_place, prize_cents)
       SELECT $1::uuid, f, t, c FROM unnest($2::int[], $3::int[], $4::bigint[]) AS u(f, t, c)`,
      [poolId, table.bands.map((b) => b.fromPlace), table.bands.map((b) => b.toPlace), table.bands.map((b) => String(b.prizeCents))]
    );
    // D7: entry closes at the Week 3 lock. Once the schedule is imported the
    // close time comes from it, whatever the draft said; a pool can't open
    // after the cutoff has passed.
    const [cutoff] = await tx.query<{ t: Date | null }>(
      `SELECT min(scheduled_et) AS t FROM game_windows
        WHERE season = $1 AND week = $2 AND status IN ('pending', 'locked', 'final') AND cardinality(msf_game_ids) > 0`,
      [pool.season, PAID_ENTRY_CUTOFF_WEEK]
    );
    if (cutoff?.t) {
      if (ctx.now() >= new Date(cutoff.t)) {
        throw new PaymentsError('ENTRY_CUTOFF_PASSED', `entry for ${pool.season} closed at the Week ${PAID_ENTRY_CUTOFF_WEEK} lock`);
      }
      await tx.query(`UPDATE contest_pools SET entry_closes_at = $2 WHERE id = $1::uuid`, [poolId, cutoff.t]);
    }
    await tx.query(`UPDATE contest_pools SET status = 'open', published_at = $2 WHERE id = $1::uuid`, [poolId, ctx.now()]);
    return table;
  });
}

export async function loadBands(q: SqlRunner, poolId: string): Promise<PrizeBand[]> {
  const rows = await q.query<{ f: number; t: number; c: string }>(
    `SELECT from_place AS f, to_place AS t, prize_cents::text AS c FROM prize_table_bands WHERE pool_id = $1::uuid ORDER BY from_place`,
    [poolId]
  );
  return rows.map((r) => ({ fromPlace: r.f, toPlace: r.t, prizeCents: Number(r.c) }));
}

export async function activeEntryCount(q: SqlRunner, poolId: string): Promise<number> {
  const [r] = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM contest_entries ce WHERE ce.pool_id = $1::uuid AND ${ACTIVE_ENTRY}`,
    [poolId]
  );
  return r.n;
}

/** Live checkout holds that still reserve a seat. */
export async function liveHoldCount(q: SqlRunner, poolId: string, now: Date, excludeIntentId?: string): Promise<number> {
  const [r] = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM entry_intents
      WHERE pool_id = $1::uuid AND status = 'pending' AND hold_expires_at > $2 AND id IS DISTINCT FROM $3::uuid`,
    [poolId, now, excludeIntentId ?? null]
  );
  return r.n;
}

/** GET /pools/:id/prizes (§13). */
export async function getPrizes(ctx: PaymentsContext, poolId: string) {
  const [p] = await ctx.db.query<{
    status: string; capacity: number | null; prize_pool_cents: string | null; min_cash_cents: string | null;
    paid_places: number | null; entry_closes_at: Date; buy_in_cents: number; rake_bps: number | null;
  }>(
    `SELECT status, capacity, prize_pool_cents::text, min_cash_cents::text, paid_places, entry_closes_at, buy_in_cents, rake_bps
       FROM contest_pools WHERE id = $1::uuid`,
    [poolId]
  );
  if (!p || p.status === 'draft') throw new PaymentsError('POOL_NOT_FOUND', poolId);
  const now = ctx.now();
  const taken = (await activeEntryCount(ctx.db, poolId)) + (await liveHoldCount(ctx.db, poolId, now));
  return {
    status: p.status,
    guaranteedPrizePoolCents: Number(p.prize_pool_cents),
    minCashCents: Number(p.min_cash_cents),
    paidPlaces: p.paid_places!,
    capacity: p.capacity!,
    seatsLeft: p.status === 'open' ? Math.max(0, p.capacity! - taken) : 0,
    entryClosesAt: p.entry_closes_at,
    buyInCents: p.buy_in_cents,
    bands: await loadBands(ctx.db, poolId),
  };
}

export type CloseOutcome = { poolId: string; outcome: 'closed'; entries: number; overlayCents: number } | { poolId: string; outcome: 'cancelled'; entries: number; refunds: number };

/**
 * Entry close (§5.1). For each open pool past entry_closes_at + grace:
 *   below the minimum field → cancel and refund every entry in full;
 *   otherwise → close and post the overlay (prize pool − contributions collected).
 */
export async function closeEntries(ctx: PaymentsContext): Promise<CloseOutcome[]> {
  const now = ctx.now();
  const due = await ctx.db.query<{ id: string }>(
    `SELECT id::text AS id FROM contest_pools WHERE status = 'open' AND entry_closes_at + make_interval(secs => $2) <= $1`,
    [now, ctx.config.closeGraceMs / 1000]
  );
  const results: CloseOutcome[] = [];
  for (const { id } of due) {
    const r = await ctx.db.transaction(async (tx): Promise<CloseOutcome | null> => {
      const pool = await lockPool(tx, id);
      if (!pool || pool.status !== 'open') return null;
      await tx.query(`UPDATE entry_intents SET status = 'expired' WHERE pool_id = $1::uuid AND status = 'pending'`, [id]);
      const entries = await activeEntryCount(tx, id);

      if (entries < pool.min_entries!) {
        await tx.query(`UPDATE contest_pools SET status = 'cancelled' WHERE id = $1::uuid`, [id]);
        const intents = await tx.query<{ id: string }>(
          `SELECT id::text AS id FROM entry_intents WHERE pool_id = $1::uuid AND status = 'captured' ORDER BY created_at`,
          [id]
        );
        for (const i of intents) await refundCapturedIntent(tx, i.id, 'POOL_CANCELLED', now);
        const users = await tx.query<{ user_id: string }>(
          `SELECT DISTINCT user_id::text AS user_id FROM entry_intents WHERE pool_id = $1::uuid AND status = 'refunded'`,
          [id]
        );
        for (const u of users) await notify(tx, u.user_id, 'POOL_CANCELLED', { poolId: id, poolName: pool.name, entries, minEntries: pool.min_entries });
        return { poolId: id, outcome: 'cancelled', entries, refunds: intents.length };
      }

      await tx.query(`UPDATE contest_pools SET status = 'closed' WHERE id = $1::uuid`, [id]);
      const overlay = Number(pool.prize_pool_cents) - (await owed(tx, acct.prizeLiability(id)));
      if (overlay < 0) throw new PaymentsError('LIABILITY_EXCEEDS_POOL', `pool ${id} owes more than its prize pool`);
      await post(tx, {
        kind: 'overlay', refType: 'pool', refId: id, idempotencyKey: `overlay:${id}`, occurredAt: now,
        postings: [debit(acct.overlayExpense, overlay), credit(acct.prizeLiability(id), overlay)],
      });
      return { poolId: id, outcome: 'closed', entries, overlayCents: overlay };
    });
    if (r) {
      ctx.log('info', `pool ${r.poolId} ${r.outcome}`, r);
      results.push(r);
    }
  }
  return results;
}

/** Ops-recorded movement between the platform's own bank accounts, e.g. funding an overlay (§6.3). */
export async function recordTransfer(
  ctx: PaymentsContext,
  t: { from: 'operating_bank' | 'prize_bank'; to: 'operating_bank' | 'prize_bank'; amountCents: number; reference: string }
): Promise<boolean> {
  if (t.from === t.to || !Number.isSafeInteger(t.amountCents) || t.amountCents <= 0) throw new PaymentsError('TRANSFER_INVALID', 'bad transfer');
  return ctx.db.transaction((tx) =>
    post(tx, {
      kind: 'transfer', refType: 'transfer', refId: t.reference, idempotencyKey: `transfer:${t.reference}`, occurredAt: ctx.now(),
      postings: [debit(t.to, t.amountCents), credit(t.from, t.amountCents)],
    })
  );
}
