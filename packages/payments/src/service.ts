/**
 * Payments service — PRD-004
 *
 * createPaymentsService refuses to start a live processor unless
 * PAYMENTS_LIVE=true AND a written approval for that processor is recorded
 * (§7.3). Until then only FakeProcessor runs.
 */
import { DEFAULT_CONFIG, LivePaymentsDisabledError, PaymentsError, type Log, type PaymentsConfig, type PaymentsContext } from './context';
import { expireHolds, recordIdentityVerification, startCheckout, type CheckoutRequest, type IdentityResult } from './checkout';
import { handleWebhook, retryUnprocessedEvents } from './events';
import { runIntegrityCheck } from './integrity';
import { closeEntries, getPrizes, publishPool, recordTransfer, type PublishTerms } from './pools';
import { createPayoutOnboardingLink, getMyPayouts, queuePayouts, quoteInstantPayout, requestInstantPayout, sendPendingPayouts } from './payouts';
import type { PaymentProcessor } from './processor';
import { refundForPlatformError, sendPendingRefunds } from './refunds';
import { approveSettlement, computeSettlement, getSettlement } from './settlement';
import type { SqlDatabase } from './sql';

export interface PaymentsServiceDeps {
  db: SqlDatabase;
  processor: PaymentProcessor;
  getServerTime?: () => Date;
  log?: Log;
  config?: Partial<PaymentsConfig>;
  /** Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/** §7.3 live-money guard. */
export async function assertProcessorAllowed(db: SqlDatabase, processor: PaymentProcessor, env: Record<string, string | undefined>): Promise<void> {
  if (!processor.live) return;
  if (env.PAYMENTS_LIVE !== 'true') throw new LivePaymentsDisabledError(`PAYMENTS_LIVE is not "true"; refusing to start live processor ${processor.name}`);
  const [approval] = await db.query(`SELECT 1 FROM processor_approvals WHERE processor = $1 LIMIT 1`, [processor.name]);
  if (!approval) throw new LivePaymentsDisabledError(`no written approval recorded for processor ${processor.name}`);
}

export async function createPaymentsService(deps: PaymentsServiceDeps) {
  const log: Log = deps.log ?? (() => {});
  try {
    await assertProcessorAllowed(deps.db, deps.processor, deps.env ?? process.env);
  } catch (err) {
    log('error', String((err as Error).message));
    throw err;
  }
  const ctx: PaymentsContext = {
    db: deps.db,
    processor: deps.processor,
    now: deps.getServerTime ?? (() => new Date()),
    log,
    config: { ...DEFAULT_CONFIG, ...deps.config },
  };

  /** Follow-up work after anything that may have queued refunds or released payouts. */
  async function afterEvents(): Promise<void> {
    await sendPendingRefunds(ctx);
    await queuePayouts(ctx);
    await sendPendingPayouts(ctx);
  }

  return {
    context: ctx,

    // pools
    publishPool: (poolId: string, terms: PublishTerms) => publishPool(ctx, poolId, terms),
    getPrizes: (poolId: string) => getPrizes(ctx, poolId),
    closeEntries: async () => {
      const out = await closeEntries(ctx);
      await sendPendingRefunds(ctx);
      return out;
    },
    recordTransfer: (t: Parameters<typeof recordTransfer>[1]) => recordTransfer(ctx, t),

    // identity and checkout
    recordIdentityVerification: (r: IdentityResult) => recordIdentityVerification(ctx, r),
    startCheckout: (req: CheckoutRequest) => startCheckout(ctx, req),
    expireHolds: () => expireHolds(ctx),

    // webhooks
    handleWebhook: async (rawBody: Buffer, headers: Record<string, string>) => {
      const result = await handleWebhook(ctx, rawBody, headers);
      if (result.status === 'processed') await afterEvents();
      return result;
    },
    retryUnprocessedEvents: async () => {
      const out = await retryUnprocessedEvents(ctx);
      await afterEvents();
      return out;
    },

    // refunds
    refundForPlatformError: (intentId: string, reason: string) => refundForPlatformError(ctx, intentId, reason),
    sendPendingRefunds: () => sendPendingRefunds(ctx),

    // settlement
    computeSettlement: (poolId: string) => computeSettlement(ctx, poolId),
    approveSettlement: async (poolId: string, admin: { userId: string; stepUpAt: Date | null }) => {
      const r = await approveSettlement(ctx, poolId, admin);
      if (r.approved) {
        await queuePayouts(ctx);
        await sendPendingPayouts(ctx);
      }
      return r;
    },
    getSettlement: (poolId: string) => getSettlement(ctx, poolId),

    // payouts
    queuePayouts: (opts?: { userId?: string }) => queuePayouts(ctx, opts),
    sendPendingPayouts: () => sendPendingPayouts(ctx),
    quoteInstantPayout: (userId: string, payoutId: string) => quoteInstantPayout(ctx, userId, payoutId),
    requestInstantPayout: (req: Parameters<typeof requestInstantPayout>[1]) => requestInstantPayout(ctx, req),
    createPayoutOnboardingLink: (req: Parameters<typeof createPayoutOnboardingLink>[1]) => createPayoutOnboardingLink(ctx, req),
    getMyPayouts: (userId: string) => getMyPayouts(ctx, userId),

    // integrity
    runIntegrityCheck: (opts?: { poolId?: string }) => runIntegrityCheck(ctx.db, opts),

    /** One scheduler tick: expire holds, close pools, retry events, send refunds and payouts. */
    async runJobs() {
      await expireHolds(ctx);
      const closed = await closeEntries(ctx);
      await retryUnprocessedEvents(ctx);
      await afterEvents();
      return { closed };
    },
  };
}

export type PaymentsService = Awaited<ReturnType<typeof createPaymentsService>>;
export { PaymentsError };
