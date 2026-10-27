/**
 * Integrity check — PRD-004 §6.4
 *
 * Runs weekly, before settlement approval, and on demand. Any failure blocks
 * settlement. It recomputes everything from source rows; it never trusts a
 * stored total.
 */
import { ACTIVE_ENTRY } from './context';
import { acct } from './ledger';
import type { SqlRunner } from './sql';

export interface IntegrityFailure {
  check: string;
  detail: string;
}

export interface IntegrityReport {
  ok: boolean;
  failures: IntegrityFailure[];
}

export async function runIntegrityCheck(q: SqlRunner, opts: { poolId?: string } = {}): Promise<IntegrityReport> {
  const failures: IntegrityFailure[] = [];

  // 1. Every ledger transaction balances (re-proves the trigger).
  const unbalanced = await q.query<{ id: string; total: string; n: number }>(
    `SELECT t.id::text AS id, COALESCE(SUM(e.amount_cents), 0)::text AS total, count(e.id)::int AS n
       FROM ledger_transactions t LEFT JOIN ledger_entries e ON e.txn_id = t.id
      GROUP BY t.id HAVING COALESCE(SUM(e.amount_cents), 0) <> 0 OR count(e.id) < 2`
  );
  for (const u of unbalanced) failures.push({ check: 'LEDGER_BALANCED', detail: `transaction ${u.id}: ${u.n} entries summing to ${u.total}` });

  // 2–4. Per pool.
  const pools = await q.query<{
    id: string; status: string; prize_pool_cents: string; liability: string; expected: string;
    entries: number; captured: number; awarded: string | null; settlement: string | null;
  }>(
    `SELECT p.id::text AS id, p.status, p.prize_pool_cents::text AS prize_pool_cents,
            (-COALESCE((SELECT SUM(amount_cents) FROM ledger_entries WHERE account = 'prize_liability:' || p.id), 0))::text AS liability,
            (COALESCE((SELECT SUM(amount_cents - rake_cents) FROM entry_intents WHERE pool_id = p.id AND status = 'captured'), 0)
             + COALESCE((SELECT -SUM(e.amount_cents) FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.txn_id
                          WHERE t.kind = 'overlay' AND e.account = 'prize_liability:' || p.id), 0))::text AS expected,
            (SELECT count(*)::int FROM contest_entries ce WHERE ce.pool_id = p.id AND ${ACTIVE_ENTRY}) AS entries,
            (SELECT count(*)::int FROM entry_intents WHERE pool_id = p.id AND status = 'captured') AS captured,
            (SELECT SUM(amount_cents)::text FROM settlement_awards WHERE pool_id = p.id) AS awarded,
            (SELECT status FROM settlements WHERE pool_id = p.id) AS settlement
       FROM contest_pools p
      WHERE p.status <> 'draft' AND ($1::uuid IS NULL OR p.id = $1::uuid)`,
    [opts.poolId ?? null]
  );
  for (const p of pools) {
    if (p.status === 'settled') {
      if (Number(p.liability) !== 0) failures.push({ check: 'POOL_LIABILITY', detail: `settled pool ${p.id} still owes ${p.liability}` });
      if (p.settlement !== 'approved' || Number(p.awarded) !== Number(p.prize_pool_cents)) {
        failures.push({ check: 'SETTLEMENT_SUM', detail: `pool ${p.id}: awards ${p.awarded} vs prize pool ${p.prize_pool_cents} (${p.settlement})` });
      }
    } else if (Number(p.liability) !== Number(p.expected)) {
      failures.push({ check: 'POOL_LIABILITY', detail: `pool ${p.id}: liability ${p.liability}, contributions + overlay ${p.expected}` });
    }
    if (p.settlement && p.status !== 'settled' && p.awarded !== null && Number(p.awarded) !== Number(p.prize_pool_cents)) {
      failures.push({ check: 'SETTLEMENT_SUM', detail: `pool ${p.id}: computed awards ${p.awarded} vs prize pool ${p.prize_pool_cents}` });
    }
    if (p.entries !== p.captured) {
      failures.push({ check: 'ENTRIES_MATCH_CAPTURES', detail: `pool ${p.id}: ${p.entries} entries, ${p.captured} captured payments` });
    }
  }

  // 5. Prize-side liabilities are covered by prize-side assets.
  const [cover] = await q.query<{ owed: string; held: string }>(
    `SELECT (-COALESCE(SUM(amount_cents) FILTER (WHERE account LIKE 'payable:%' OR account LIKE 'prize_liability:%'), 0))::text AS owed,
            COALESCE(SUM(amount_cents) FILTER (WHERE account IN ($1, $2)), 0)::text AS held
       FROM ledger_entries`,
    [acct.prizeBank, acct.clearingPrize]
  );
  if (Number(cover.owed) > Number(cover.held)) {
    failures.push({ check: 'PRIZE_FUNDS_COVER', detail: `prize liabilities ${cover.owed} exceed prize funds ${cover.held}` });
  }

  // 6. Latest ops-entered bank statement per account matches the ledger as of that date.
  const recs = await q.query<{ account: string; statement_date: string; balance_cents: string; ledger: string }>(
    `SELECT DISTINCT ON (r.account) r.account, r.statement_date::text, r.balance_cents::text,
            COALESCE((SELECT SUM(e.amount_cents) FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.txn_id
                       WHERE e.account = r.account
                         AND (t.occurred_at AT TIME ZONE 'America/New_York')::date <= r.statement_date), 0)::text AS ledger
       FROM bank_reconciliations r ORDER BY r.account, r.statement_date DESC, r.entered_at DESC`
  );
  for (const r of recs) {
    if (r.balance_cents !== r.ledger) {
      failures.push({ check: 'BANK_RECONCILIATION', detail: `${r.account} on ${r.statement_date}: statement ${r.balance_cents}, ledger ${r.ledger}` });
    }
  }

  return { ok: failures.length === 0, failures };
}
