/**
 * Eligibility gate and checkout — PRD-004 §8.1, §8.2
 */
import { createHash } from 'node:crypto';
import { ACTIVE_ENTRY, hasOpenHold, lockPool, PaymentsError, type PaymentsContext, type PoolRow } from './context';
import { activeEntryCount, liveHoldCount } from './pools';
import type { SqlRunner } from './sql';

export type GateReason =
  | 'STEP_UP_REQUIRED' | 'ENTRY_CLOSED' | 'ACCOUNT_HOLD' | 'IDENTITY_UNVERIFIED' | 'UNDER_AGE'
  | 'JURISDICTION_BLOCKED' | 'ALREADY_ENTERED' | 'POOL_FULL';

export interface CheckoutRequest {
  userId: string;
  poolId: string;
  /** State derived from the request IP, e.g. 'GA'. */
  ipRegion: string;
  ipSubRegion?: string;
  /** Billing-address state entered at checkout. */
  billingRegion: string;
  billingSubRegion?: string;
  stepUpAt: Date | null;
  successUrl: string;
  cancelUrl: string;
}

export type CheckoutResult =
  | { ok: true; intentId: string; checkoutUrl: string; holdExpiresAt: Date }
  | { ok: false; reason: GateReason };

interface JurisdictionCheck {
  allowed: boolean;
  minAge: number;
}

/** Default deny: a region with no allowed row in force, or any blocked matching row, is blocked (§11.2). */
export async function checkJurisdiction(q: SqlRunner, region: string, subRegion: string | undefined, at: Date): Promise<JurisdictionCheck> {
  const rows = await q.query<{ sub_region: string; status: string; min_age: number }>(
    `SELECT sub_region, status, min_age FROM jurisdictions
      WHERE country = 'US' AND region = $1 AND sub_region IN ('', $2)
        AND effective_from <= $3 AND (effective_to IS NULL OR effective_to > $3)`,
    [region.toUpperCase(), subRegion ?? '', at]
  );
  const base = rows.find((r) => r.sub_region === '');
  const allowed = !!base && base.status === 'allowed' && rows.every((r) => r.status === 'allowed');
  return { allowed, minAge: rows.reduce((m, r) => Math.max(m, r.min_age), 18) };
}

async function gate(tx: SqlRunner, ctx: PaymentsContext, req: CheckoutRequest, pool: PoolRow | null, now: Date): Promise<GateReason | null> {
  if (!req.stepUpAt || now.getTime() - req.stepUpAt.getTime() > ctx.config.stepUpMaxAgeMs || req.stepUpAt > now) return 'STEP_UP_REQUIRED';
  if (!pool || pool.status !== 'open' || now >= pool.entry_closes_at) return 'ENTRY_CLOSED';
  if (await hasOpenHold(tx, req.userId)) return 'ACCOUNT_HOLD';

  const [idv] = await tx.query<{ birth_date: string }>(
    `SELECT birth_date::text AS birth_date FROM identity_verifications WHERE user_id = $1::uuid AND status = 'verified'`,
    [req.userId]
  );
  if (!idv) return 'IDENTITY_UNVERIFIED';

  const ip = await checkJurisdiction(tx, req.ipRegion, req.ipSubRegion, now);
  const billing = await checkJurisdiction(tx, req.billingRegion, req.billingSubRegion, now);
  const minAge = Math.max(ip.minAge, billing.minAge);
  const [age] = await tx.query<{ old_enough: boolean }>(
    `SELECT ($1::date + make_interval(years => $2)) <= ($3::timestamptz AT TIME ZONE 'America/New_York')::date AS old_enough`,
    [idv.birth_date, minAge, now]
  );
  if (!age.old_enough) return 'UNDER_AGE';
  if (!ip.allowed || !billing.allowed) return 'JURISDICTION_BLOCKED';

  const [dup] = await tx.query<{ entered: boolean; holding: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM contest_entries ce WHERE ce.pool_id = $1::uuid AND ce.user_id = $2::uuid AND ${ACTIVE_ENTRY}) AS entered,
            EXISTS (SELECT 1 FROM entry_intents WHERE pool_id = $1::uuid AND user_id = $2::uuid AND status = 'pending' AND hold_expires_at > $3) AS holding`,
    [req.poolId, req.userId, now]
  );
  if (dup.entered || dup.holding) return 'ALREADY_ENTERED';

  const taken = (await activeEntryCount(tx, req.poolId)) + (await liveHoldCount(tx, req.poolId, now));
  if (taken >= pool.capacity!) return 'POOL_FULL';
  return null;
}

/**
 * Runs the gate and takes a seat under the pool row lock (so two users can't
 * take the last seat), then asks the processor for a hosted checkout.
 */
export async function startCheckout(ctx: PaymentsContext, req: CheckoutRequest): Promise<CheckoutResult> {
  const now = ctx.now();
  const held = await ctx.db.transaction(async (tx) => {
    const pool = await lockPool(tx, req.poolId);
    const reason = await gate(tx, ctx, req, pool, now);
    if (reason) return { ok: false as const, reason };
    // An expired-but-unswept hold would block the one-pending index; release it first.
    await tx.query(
      `UPDATE entry_intents SET status = 'expired' WHERE pool_id = $1::uuid AND user_id = $2::uuid AND status = 'pending' AND hold_expires_at <= $3`,
      [req.poolId, req.userId, now]
    );
    const holdExpiresAt = new Date(Math.min(now.getTime() + ctx.config.holdMs, pool!.entry_closes_at.getTime()));
    const rake = Math.floor((pool!.buy_in_cents * pool!.rake_bps!) / 10000);
    const [i] = await tx.query<{ id: string }>(
      `INSERT INTO entry_intents (user_id, pool_id, amount_cents, rake_cents, status, hold_expires_at, processor, ip_region, billing_region, created_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9) RETURNING id::text AS id`,
      [req.userId, req.poolId, pool!.buy_in_cents, rake, holdExpiresAt, ctx.processor.name, req.ipRegion.toUpperCase(), req.billingRegion.toUpperCase(), now]
    );
    return { ok: true as const, intentId: i.id, holdExpiresAt, amountCents: pool!.buy_in_cents, poolName: pool!.name };
  });
  if (!held.ok) return held;

  try {
    const { checkoutUrl, checkoutRef } = await ctx.processor.createCheckout({
      intentId: held.intentId,
      userId: req.userId,
      amountCents: held.amountCents,
      description: `Burnout League — ${held.poolName}`,
      expiresAt: held.holdExpiresAt,
      successUrl: req.successUrl,
      cancelUrl: req.cancelUrl,
      idempotencyKey: `checkout:${held.intentId}`,
    });
    await ctx.db.query(`UPDATE entry_intents SET checkout_ref = $2 WHERE id = $1::uuid`, [held.intentId, checkoutRef]);
    return { ok: true, intentId: held.intentId, checkoutUrl, holdExpiresAt: held.holdExpiresAt };
  } catch (err) {
    await ctx.db.query(`UPDATE entry_intents SET status = 'failed' WHERE id = $1::uuid AND status = 'pending'`, [held.intentId]);
    throw err;
  }
}

/** Releases seats whose checkout hold has run out. */
export async function expireHolds(ctx: PaymentsContext): Promise<number> {
  const rows = await ctx.db.query(
    `UPDATE entry_intents SET status = 'expired' WHERE status = 'pending' AND hold_expires_at <= $1 RETURNING 1`,
    [ctx.now()]
  );
  return rows.length;
}

// ── identity (§11.1) ────────────────────────────────────────────────────────

export interface IdentityResult {
  userId: string;
  provider: string;
  providerRef: string;
  /** The provider's stable identifier for the person. Only its hash is stored. */
  providerPersonId: string;
  birthDate: string; // YYYY-MM-DD
  region: string;
}

export function personHash(provider: string, providerPersonId: string): string {
  return createHash('sha256').update(`${provider}:${providerPersonId}`).digest('hex');
}

/** Records a passed verification. One verified account per person (unique person hash). */
export async function recordIdentityVerification(ctx: PaymentsContext, r: IdentityResult): Promise<void> {
  try {
    await ctx.db.query(
      `INSERT INTO identity_verifications (user_id, provider, provider_ref, person_hash, status, verified_region, birth_date, verified_at)
       VALUES ($1, $2, $3, $4, 'verified', $5, $6::date, $7)`,
      [r.userId, r.provider, r.providerRef, personHash(r.provider, r.providerPersonId), r.region.toUpperCase(), r.birthDate, ctx.now()]
    );
  } catch (err) {
    const msg = String((err as Error).message);
    if (msg.includes('identity_verifications_person_once')) throw new PaymentsError('IDENTITY_IN_USE', 'this person has already verified another account');
    if (msg.includes('identity_verifications_user_once')) throw new PaymentsError('IDENTITY_EXISTS', 'this account is already verified');
    throw err;
  }
}
