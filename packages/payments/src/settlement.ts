/**
 * Settlement — PRD-004 §9
 *
 * Reads only the OFFICIAL final-week snapshot (PRD-003 §8). Never live
 * scores, the cache, or the board API.
 */
import { computeAwards, type Award, type StandingRow } from './awards';
import { lockPool, PaymentsError, requireStepUp, type PaymentsContext } from './context';
import { runIntegrityCheck } from './integrity';
import { acct, credit, debit, owed, post } from './ledger';
import { activeEntryCount, loadBands } from './pools';
import type { SqlRunner } from './sql';

export class SettlementNotReadyError extends PaymentsError {}

export interface SettlementView {
  poolId: string;
  status: 'computed' | 'approved';
  snapshotWeek: number;
  awards: Award[];
}

async function loadSettlement(q: SqlRunner, poolId: string): Promise<SettlementView | null> {
  const [s] = await q.query<{ status: 'computed' | 'approved'; snapshot_week: number }>(
    `SELECT status, snapshot_week FROM settlements WHERE pool_id = $1::uuid`,
    [poolId]
  );
  if (!s) return null;
  const awards = await q.query<{ entry_id: string; user_id: string; rank: number; tie_size: number; amount_cents: string }>(
    `SELECT entry_id::text, user_id::text, rank, tie_size, amount_cents::text FROM settlement_awards
      WHERE pool_id = $1::uuid ORDER BY rank, entry_id`,
    [poolId]
  );
  return {
    poolId,
    status: s.status,
    snapshotWeek: s.snapshot_week,
    awards: awards.map((a) => ({ entryId: a.entry_id, userId: a.user_id, rank: a.rank, tieSize: a.tie_size, amountCents: Number(a.amount_cents) })),
  };
}

/** Step 1–2: compute and verify awards. Idempotent: a computed pool returns its stored result. */
export async function computeSettlement(ctx: PaymentsContext, poolId: string): Promise<SettlementView> {
  return ctx.db.transaction(async (tx) => {
    const existing = await loadSettlement(tx, poolId);
    if (existing) return existing;

    const pool = await lockPool(tx, poolId);
    if (!pool) throw new PaymentsError('POOL_NOT_FOUND', poolId);
    if (pool.status !== 'closed') throw new SettlementNotReadyError('POOL_NOT_CLOSED', `pool ${poolId} is ${pool.status}`);

    const week = ctx.config.finalWeek;
    const [frozen] = await tx.query<{ n: number }>(
      `SELECT count(DISTINCT week)::int AS n FROM week_freezes WHERE season = $1 AND week BETWEEN 1 AND $2`,
      [pool.season, week]
    );
    if (frozen.n !== week) throw new SettlementNotReadyError('WEEKS_NOT_FROZEN', `${frozen.n} of ${week} weeks frozen for ${pool.season}`);

    const snap = await tx.query<{ entry_id: string | null; user_id: string; rank: number; points_x100: string }>(
      `SELECT ce.id::text AS entry_id, s.user_id::text AS user_id, s.rank, s.points_x100::text AS points_x100
         FROM leaderboard_snapshots s
         LEFT JOIN contest_entries ce ON ce.pool_id = s.pool_id AND ce.user_id = s.user_id
        WHERE s.pool_id = $1::uuid AND s.week = $2 AND s.kind = 'official'`,
      [poolId, week]
    );
    if (snap.length === 0) throw new SettlementNotReadyError('SNAPSHOT_MISSING', `no official week ${week} snapshot for pool ${poolId}`);
    const entries = await activeEntryCount(tx, poolId);
    if (snap.some((r) => r.entry_id === null) || snap.length !== entries) {
      throw new SettlementNotReadyError('SNAPSHOT_MISMATCH', `snapshot has ${snap.length} rows, pool has ${entries} entries`);
    }

    const integrity = await runIntegrityCheck(tx, { poolId });
    if (!integrity.ok) throw new SettlementNotReadyError('INTEGRITY_FAILED', integrity.failures.map((f) => `${f.check}: ${f.detail}`).join('; '));

    const rows: StandingRow[] = snap.map((r) => ({ entryId: r.entry_id!, userId: r.user_id, rank: r.rank, pointsX100: Number(r.points_x100) }));
    const bands = await loadBands(tx, poolId);
    const awards = computeAwards(bands, rows); // verifies the snapshot's ranks against its own points
    const total = awards.reduce((s, a) => s + a.amountCents, 0);
    if (total !== Number(pool.prize_pool_cents)) {
      throw new PaymentsError('SETTLEMENT_SUM_MISMATCH', `awards ${total} ≠ prize pool ${pool.prize_pool_cents}`);
    }

    await tx.query(`INSERT INTO settlements (pool_id, snapshot_week, status, computed_at) VALUES ($1, $2, 'computed', $3)`, [poolId, week, ctx.now()]);
    await tx.query(
      `INSERT INTO settlement_awards (pool_id, entry_id, user_id, rank, tie_size, amount_cents)
       SELECT $1::uuid, e, u, r, t, a FROM unnest($2::uuid[], $3::uuid[], $4::int[], $5::int[], $6::bigint[]) AS x(e, u, r, t, a)`,
      [poolId, awards.map((a) => a.entryId), awards.map((a) => a.userId), awards.map((a) => a.rank), awards.map((a) => a.tieSize), awards.map((a) => String(a.amountCents))]
    );
    ctx.log('info', `settlement computed for pool ${poolId}`, { awards: awards.length, total });
    return (await loadSettlement(tx, poolId))!;
  });
}

/** Step 3: admin approval with step-up. Posts prize liability → payables once; approving twice posts once. */
export async function approveSettlement(
  ctx: PaymentsContext,
  poolId: string,
  admin: { userId: string; stepUpAt: Date | null }
): Promise<{ approved: boolean; alreadyApproved: boolean }> {
  requireStepUp(ctx, admin.stepUpAt);
  return ctx.db.transaction(async (tx) => {
    const pool = await lockPool(tx, poolId);
    if (!pool) throw new PaymentsError('POOL_NOT_FOUND', poolId);
    const now = ctx.now();
    const [claimed] = await tx.query(
      `UPDATE settlements SET status = 'approved', approved_by = $2, approved_at = $3 WHERE pool_id = $1::uuid AND status = 'computed' RETURNING 1`,
      [poolId, admin.userId, now]
    );
    if (!claimed) {
      const s = await loadSettlement(tx, poolId);
      if (s?.status === 'approved') return { approved: false, alreadyApproved: true };
      throw new SettlementNotReadyError('NOT_COMPUTED', `pool ${poolId} has no computed settlement`);
    }

    const integrity = await runIntegrityCheck(tx, { poolId });
    if (!integrity.ok) throw new SettlementNotReadyError('INTEGRITY_FAILED', integrity.failures.map((f) => `${f.check}: ${f.detail}`).join('; '));
    const liability = await owed(tx, acct.prizeLiability(poolId));
    if (liability !== Number(pool.prize_pool_cents)) {
      throw new SettlementNotReadyError('LIABILITY_MISMATCH', `pool owes ${liability}, prize pool is ${pool.prize_pool_cents}`);
    }

    const perUser = await tx.query<{ user_id: string; amount: string }>(
      `SELECT user_id::text AS user_id, SUM(amount_cents)::text AS amount FROM settlement_awards
        WHERE pool_id = $1::uuid AND amount_cents > 0 GROUP BY user_id ORDER BY user_id`,
      [poolId]
    );
    await post(tx, {
      kind: 'settlement_approve', refType: 'pool', refId: poolId, idempotencyKey: `settle:${poolId}`, occurredAt: now,
      postings: [debit(acct.prizeLiability(poolId), liability), ...perUser.map((u) => credit(acct.payable(u.user_id), Number(u.amount)))],
    });
    await tx.query(`UPDATE contest_pools SET status = 'settled' WHERE id = $1::uuid`, [poolId]);
    ctx.log('info', `settlement approved for pool ${poolId}`, { by: admin.userId, winners: perUser.length });
    return { approved: true, alreadyApproved: false };
  });
}

export async function getSettlement(ctx: PaymentsContext, poolId: string): Promise<SettlementView | null> {
  return loadSettlement(ctx.db, poolId);
}
