/**
 * Double-entry ledger — PRD-004 §6
 *
 * Postgres enforces the invariants (balanced at commit, append-only, prize
 * liability debited only by refunds and settlement). This module only builds
 * postings and makes them idempotent.
 */
import type { SqlRunner } from './sql';

export type AccountKind = 'asset' | 'liability' | 'revenue' | 'expense';

export type TxnKind =
  | 'capture' | 'capture_rejected' | 'fee' | 'funds_settled' | 'overlay' | 'transfer'
  | 'refund_entry' | 'refund_confirmed' | 'settlement_approve' | 'payout_paid' | 'payout_returned' | 'chargeback_lost';

/** Account codes, PRD-004 §6.2. */
export const acct = {
  clearingPrize: 'processor_clearing:prize',
  clearingOperating: 'processor_clearing:operating',
  prizeBank: 'prize_bank',
  operatingBank: 'operating_bank',
  rakeRevenue: 'rake_revenue',
  processingFees: 'processing_fees',
  overlayExpense: 'overlay_expense',
  chargebackLoss: 'chargeback_loss',
  prizeLiability: (poolId: string) => `prize_liability:${poolId}`,
  payable: (userId: string) => `payable:${userId}`,
  refundPayable: (userId: string) => `refund_payable:${userId}`,
} as const;

function describeAccount(code: string): { kind: AccountKind; poolId: string | null; userId: string | null } {
  const [head, id] = code.split(':');
  switch (head) {
    case 'prize_liability': return { kind: 'liability', poolId: id, userId: null };
    case 'payable':
    case 'refund_payable': return { kind: 'liability', poolId: null, userId: id };
    case 'processor_clearing':
    case 'prize_bank':
    case 'operating_bank': return { kind: 'asset', poolId: null, userId: null };
    case 'rake_revenue': return { kind: 'revenue', poolId: null, userId: null };
    case 'processing_fees':
    case 'overlay_expense':
    case 'chargeback_loss': return { kind: 'expense', poolId: null, userId: null };
    default: throw new Error(`Unknown ledger account ${code}`);
  }
}

export interface Posting {
  /** Debit positive, credit negative. */
  account: string;
  amountCents: number;
}

export interface TxnInput {
  kind: TxnKind;
  refType: string;
  refId: string;
  idempotencyKey: string;
  occurredAt: Date;
  postings: Posting[];
}

export const debit = (account: string, amountCents: number): Posting => ({ account, amountCents });
export const credit = (account: string, amountCents: number): Posting => ({ account, amountCents: -amountCents });

/**
 * Posts one balanced transaction. Returns false (and writes nothing) if a
 * transaction with the same idempotency key already exists. Zero postings
 * are dropped, so callers can pass computed amounts directly.
 */
export async function post(tx: SqlRunner, t: TxnInput): Promise<boolean> {
  const postings = t.postings.filter((p) => p.amountCents !== 0);
  for (const p of postings) if (!Number.isSafeInteger(p.amountCents)) throw new Error(`non-integer cents on ${p.account}`);
  if (postings.length === 0) return false;

  const [txn] = await tx.query<{ id: string }>(
    `INSERT INTO ledger_transactions (kind, ref_type, ref_id, idempotency_key, occurred_at)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id::text AS id`,
    [t.kind, t.refType, t.refId, t.idempotencyKey, t.occurredAt]
  );
  if (!txn) return false;

  const codes = [...new Set(postings.map((p) => p.account))];
  const meta = codes.map(describeAccount);
  await tx.query(
    `INSERT INTO ledger_accounts (code, kind, pool_id, user_id)
     SELECT * FROM unnest($1::text[], $2::text[], $3::uuid[], $4::uuid[]) ON CONFLICT (code) DO NOTHING`,
    [codes, meta.map((m) => m.kind), meta.map((m) => m.poolId), meta.map((m) => m.userId)]
  );
  await tx.query(
    `INSERT INTO ledger_entries (txn_id, account, amount_cents)
     SELECT $1::uuid, a, c FROM unnest($2::text[], $3::bigint[]) AS u(a, c)`,
    [txn.id, postings.map((p) => p.account), postings.map((p) => String(p.amountCents))]
  );
  return true;
}

/** Balance as debits minus credits (assets positive, liabilities negative). */
export async function balance(q: SqlRunner, account: string): Promise<number> {
  const [r] = await q.query<{ b: string }>(
    `SELECT COALESCE(SUM(amount_cents), 0)::text AS b FROM ledger_entries WHERE account = $1`,
    [account]
  );
  return Number(r.b);
}

/** What a liability account owes (credit balance as a positive number). */
export async function owed(q: SqlRunner, account: string): Promise<number> {
  return 0 - (await balance(q, account));
}
