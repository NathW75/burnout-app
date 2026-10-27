/**
 * Processor adapter — PRD-004 §7
 *
 * Everything that talks to a payment processor goes through this interface.
 * FakeProcessor is the only implementation in this package: a real adapter
 * is built only after a processor approves the use case in writing (§7.3).
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export interface PayoutAccountStatus {
  payoutsEnabled: boolean; // KYC done and a bank account attached
  tinVerified: boolean; // W-9 collected and the TIN matched
  instantEligible: boolean;
}

export type ProcessorEvent =
  | { type: 'payment_captured'; eventId: string; intentId: string; paymentRef: string; amountCents: number; occurredAt: Date }
  | { type: 'payment_failed'; eventId: string; intentId: string; occurredAt: Date }
  | { type: 'fee_reported'; eventId: string; paymentRef: string; feeCents: number; occurredAt: Date }
  | { type: 'funds_settled'; eventId: string; prizeCents: number; operatingCents: number; occurredAt: Date }
  | { type: 'refund_succeeded'; eventId: string; refundRef: string; occurredAt: Date }
  | { type: 'dispute_opened'; eventId: string; paymentRef: string; amountCents: number; occurredAt: Date }
  | { type: 'dispute_closed'; eventId: string; paymentRef: string; outcome: 'won' | 'lost'; feeCents: number; occurredAt: Date }
  | { type: 'payout_paid'; eventId: string; payoutRef: string; occurredAt: Date }
  | { type: 'payout_failed'; eventId: string; payoutRef: string; reason: string; occurredAt: Date }
  | { type: 'account_updated'; eventId: string; userId: string; accountRef: string; status: PayoutAccountStatus; occurredAt: Date };

export type ProcessorEventType = ProcessorEvent['type'];

/** An event without its id (distributes over the union, so each variant keeps its own fields). */
export type ProcessorEventInput = ProcessorEvent extends infer E ? (E extends ProcessorEvent ? Omit<E, 'eventId'> & { eventId?: string } : never) : never;

export interface PaymentProcessor {
  readonly name: string;
  readonly live: boolean;

  createCheckout(req: {
    intentId: string; userId: string; amountCents: number; description: string;
    expiresAt: Date; successUrl: string; cancelUrl: string; idempotencyKey: string;
  }): Promise<{ checkoutUrl: string; checkoutRef: string }>;

  refund(req: { paymentRef: string; amountCents: number; idempotencyKey: string }): Promise<{ refundRef: string }>;

  createPayoutOnboardingLink(req: { userId: string; returnUrl: string }): Promise<{ url: string }>;
  getPayoutAccount(userId: string): Promise<PayoutAccountStatus | null>;

  /** Fee the processor charges for an instant payout of this amount (shown before the user confirms). */
  instantPayoutFeeCents(amountCents: number): number;

  sendPayout(req: {
    payoutId: string; userId: string; amountCents: number;
    speed: 'standard' | 'instant'; idempotencyKey: string;
  }): Promise<{ payoutRef: string; feeCents: number }>;

  /** Verifies the signature and normalizes the payload. Throws WebhookSignatureError on a bad signature. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string>): ProcessorEvent;
}

export class WebhookSignatureError extends Error {
  constructor() {
    super('Webhook signature verification failed');
    this.name = 'WebhookSignatureError';
  }
}

/** Events round-trip through processor_events as JSON; dates come back as strings. */
export function reviveEvent(json: unknown): ProcessorEvent {
  const e = json as Record<string, unknown>;
  return { ...(e as object), occurredAt: new Date(e.occurredAt as string) } as ProcessorEvent;
}

// ── FakeProcessor ───────────────────────────────────────────────────────────

type Call = { method: string; args: Record<string, unknown> };

/**
 * In-memory processor for development and tests. Idempotency keys behave
 * like a real processor's: the same key returns the same result. Webhooks
 * are HMAC-signed with a test secret so the signature path is exercised.
 */
export class FakeProcessor implements PaymentProcessor {
  readonly name: string = 'fake';
  readonly live: boolean = false;
  readonly calls: Call[] = [];
  private readonly byKey = new Map<string, unknown>();
  private readonly accounts = new Map<string, PayoutAccountStatus>();
  /** Set to make the next call to a method throw (one-shot). */
  failNext = new Set<string>();

  constructor(private readonly secret = 'fake-webhook-secret', readonly instantFeeBps = 150) {}

  private once<T>(method: string, key: string, args: Record<string, unknown>, make: () => T): T {
    this.calls.push({ method, args });
    if (this.failNext.delete(method)) throw new Error(`FakeProcessor: ${method} failed`);
    const k = `${method}:${key}`;
    if (!this.byKey.has(k)) this.byKey.set(k, make());
    return this.byKey.get(k) as T;
  }

  async createCheckout(req: Parameters<PaymentProcessor['createCheckout']>[0]) {
    return this.once('createCheckout', req.idempotencyKey, req, () => {
      const ref = `cs_${randomUUID()}`;
      return { checkoutRef: ref, checkoutUrl: `https://checkout.fake.test/${ref}` };
    });
  }

  async refund(req: Parameters<PaymentProcessor['refund']>[0]) {
    return this.once('refund', req.idempotencyKey, req, () => ({ refundRef: `re_${randomUUID()}` }));
  }

  async createPayoutOnboardingLink(req: { userId: string; returnUrl: string }) {
    return this.once('createPayoutOnboardingLink', `${req.userId}:${randomUUID()}`, req, () => ({ url: `https://connect.fake.test/onboard/${req.userId}` }));
  }

  async getPayoutAccount(userId: string) {
    return this.accounts.get(userId) ?? null;
  }

  instantPayoutFeeCents(amountCents: number): number {
    return Math.ceil((amountCents * this.instantFeeBps) / 10000);
  }

  async sendPayout(req: Parameters<PaymentProcessor['sendPayout']>[0]) {
    return this.once('sendPayout', req.idempotencyKey, req, () => ({
      payoutRef: `po_${randomUUID()}`,
      feeCents: req.speed === 'instant' ? this.instantPayoutFeeCents(req.amountCents) : 0,
    }));
  }

  // ── webhooks ─────────────────────────────────────────────────────────────

  sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('hex');
  }

  /** Builds a signed webhook delivery for an event (eventId generated if omitted). */
  webhook(event: ProcessorEventInput): { body: Buffer; headers: Record<string, string>; event: ProcessorEvent } {
    const full = { eventId: `evt_${randomUUID()}`, ...event } as ProcessorEvent;
    if (full.type === 'account_updated') this.accounts.set(full.userId, full.status);
    const body = JSON.stringify(full);
    return { body: Buffer.from(body), headers: { 'x-fake-signature': this.sign(body) }, event: full };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string>): ProcessorEvent {
    const given = Buffer.from(headers['x-fake-signature'] ?? '', 'hex');
    const expected = Buffer.from(this.sign(rawBody.toString('utf8')), 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new WebhookSignatureError();
    return reviveEvent(JSON.parse(rawBody.toString('utf8')));
  }
}
