/**
 * Shared context, configuration and errors for the payments service.
 */
import type { PaymentProcessor } from './processor';
import type { SqlDatabase, SqlRunner } from './sql';

export interface PaymentsConfig {
  /** How long a checkout holds a seat (§8.2). */
  holdMs: number;
  /** Maximum age of a step-up authentication for financial actions (§8.1, D15). */
  stepUpMaxAgeMs: number;
  /** Wait after entry close before closing a pool, so in-flight captures land first. */
  closeGraceMs: number;
  /** The week whose official snapshot settles the season (D8). */
  finalWeek: number;
  /** Days after settlement approval on which blocked winners are reminded (§10.1). */
  payoutReminderDays: number[];
}

export const DEFAULT_CONFIG: PaymentsConfig = {
  holdMs: 15 * 60_000,
  stepUpMaxAgeMs: 5 * 60_000,
  closeGraceMs: 15 * 60_000,
  finalWeek: 18,
  payoutReminderDays: [0, 1, 7, 30],
};

export type Log = (level: 'info' | 'warn' | 'error', message: string, meta?: object) => void;

export interface PaymentsContext {
  db: SqlDatabase;
  processor: PaymentProcessor;
  now: () => Date;
  log: Log;
  config: PaymentsConfig;
}

// ── errors ──────────────────────────────────────────────────────────────────

export class PaymentsError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'PaymentsError';
  }
}

export class StepUpRequiredError extends PaymentsError {
  constructor() {
    super('STEP_UP_REQUIRED', 'financial actions need a step-up authentication from the last few minutes');
  }
}

export class LivePaymentsDisabledError extends PaymentsError {
  constructor(reason: string) {
    super('LIVE_PAYMENTS_DISABLED', reason);
  }
}

export function requireStepUp(ctx: PaymentsContext, stepUpAt: Date | null | undefined): void {
  if (!stepUpAt) throw new StepUpRequiredError();
  const age = ctx.now().getTime() - stepUpAt.getTime();
  if (age < 0 || age > ctx.config.stepUpMaxAgeMs) throw new StepUpRequiredError();
}

// ── small SQL helpers ───────────────────────────────────────────────────────

export type NotificationKind = 'ENTRY_RECEIPT' | 'REFUND' | 'POOL_CANCELLED' | 'PAYOUT_BLOCKED' | 'PAYOUT_SENT' | 'PAYOUT_FAILED';

/** Transactional outbox (same table and dispatcher as PRD-001 §8). */
export async function notify(tx: SqlRunner, userId: string, kind: NotificationKind, payload: object): Promise<void> {
  await tx.query(`INSERT INTO notification_queue (user_id, kind, payload) VALUES ($1, $2, $3::jsonb)`, [
    userId,
    kind,
    JSON.stringify(payload),
  ]);
}

export async function hasOpenHold(q: SqlRunner, userId: string): Promise<boolean> {
  const [r] = await q.query<{ held: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM account_holds WHERE user_id = $1::uuid AND closed_at IS NULL) AS held`,
    [userId]
  );
  return r.held;
}

/** Entries still in the field: not voided (PRD-004 §10.3). */
export const ACTIVE_ENTRY = `NOT EXISTS (SELECT 1 FROM contest_entry_voids v WHERE v.entry_id = ce.id)`;

export interface PoolRow {
  id: string;
  season: string;
  status: string;
  buy_in_cents: number;
  entry_closes_at: Date;
  capacity: number | null;
  min_entries: number | null;
  rake_bps: number | null;
  prize_pool_cents: string | null;
  paid_places: number | null;
  name: string;
}

export async function lockPool(tx: SqlRunner, poolId: string): Promise<PoolRow | null> {
  const [p] = await tx.query<PoolRow>(
    `SELECT id::text AS id, season, status, buy_in_cents, entry_closes_at, capacity, min_entries, rake_bps,
            prize_pool_cents::text AS prize_pool_cents, paid_places, name
       FROM contest_pools WHERE id = $1::uuid FOR UPDATE`,
    [poolId]
  );
  return p ?? null;
}
