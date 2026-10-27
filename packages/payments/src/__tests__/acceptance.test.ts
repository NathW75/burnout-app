/**
 * PRD-004 §14 acceptance criteria against real Postgres (shipped migrations).
 * AC1 and AC10 (pure math) live in prize-table.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { computeBoard, writeSnapshots } from '@burnout/leaderboard';
import { count, createTestDb, createUser, createWindow, describeDb, SEASON, TestClock, type TestDb } from '@burnout/test-support';
import { acct, owed, balance, post, debit, credit } from '../ledger';
import { FakeProcessor, WebhookSignatureError, type ProcessorEventInput } from '../processor';
import { createPaymentsService, type PaymentsService } from '../service';
import { PaymentsError, StepUpRequiredError, LivePaymentsDisabledError } from '../context';
import type { CheckoutRequest } from '../checkout';

const NOW = new Date('2026-09-01T16:00:00Z');
const CLOSE = new Date('2026-09-11T00:20:00Z'); // Week 1 first lock
const MIN = 60_000;
const DAY = 86_400_000;

describeDb('PRD-004 §14 acceptance (Postgres)', () => {
  let t: TestDb;
  let clock: TestClock;
  let fake: FakeProcessor;
  let pay: PaymentsService;

  beforeEach(async () => {
    t = await createTestDb();
    clock = new TestClock(NOW);
    fake = new FakeProcessor();
    pay = await createPaymentsService({ db: t.db, processor: fake, getServerTime: clock.get, env: {} });
  });
  afterEach(async () => {
    await t.close();
  });

  // ── fixtures ──────────────────────────────────────────────────────────────
  async function draftPool(buyIn = 2500, closes = CLOSE): Promise<string> {
    const [p] = await t.sql<{ id: string }>(
      `INSERT INTO contest_pools (season, kind, buy_in_cents, name, entry_closes_at)
       VALUES ($1, 'season_open', $2, $3, $4) RETURNING id::text AS id`,
      [SEASON, buyIn, `$${buyIn / 100} Open`, closes]
    );
    return p.id;
  }
  async function openPool(o: { buyIn?: number; capacity?: number; minEntries?: number } = {}): Promise<string> {
    const id = await draftPool(o.buyIn ?? 2500);
    await pay.publishPool(id, { capacity: o.capacity ?? 10, minEntries: o.minEntries ?? 2 });
    return id;
  }
  async function verifiedUser(label = 'user', o: { region?: string; birthDate?: string } = {}): Promise<string> {
    const id = await createUser(t, label);
    await pay.recordIdentityVerification({
      userId: id, provider: 'idv-test', providerRef: `ref-${randomUUID()}`, providerPersonId: `person-${randomUUID()}`,
      birthDate: o.birthDate ?? '1990-01-01', region: o.region ?? 'GA',
    });
    return id;
  }
  const req = (userId: string, poolId: string, over: Partial<CheckoutRequest> = {}): CheckoutRequest => ({
    userId, poolId, ipRegion: 'GA', billingRegion: 'GA', stepUpAt: clock.get(),
    successUrl: 'https://burnoutfantasy.com/ok', cancelUrl: 'https://burnoutfantasy.com/cancel', ...over,
  });
  async function deliver(event: ProcessorEventInput) {
    const w = fake.webhook(event);
    const result = await pay.handleWebhook(w.body, w.headers);
    return { ...w, result };
  }
  async function capture(intentId: string, o: { amountCents?: number; paymentRef?: string; at?: Date } = {}) {
    const paymentRef = o.paymentRef ?? `pi_${randomUUID()}`;
    const r = await deliver({ type: 'payment_captured', intentId, paymentRef, amountCents: o.amountCents ?? 2500, occurredAt: o.at ?? clock.get() });
    return { ...r, paymentRef };
  }
  async function enter(poolId: string, label = 'entrant', buyIn = 2500) {
    const userId = await verifiedUser(label);
    const c = await pay.startCheckout(req(userId, poolId));
    if (!c.ok) throw new Error(`checkout failed: ${c.reason}`);
    const cap = await capture(c.intentId, { amountCents: buyIn });
    return { userId, intentId: c.intentId, paymentRef: cap.paymentRef };
  }
  async function reason(p: Promise<unknown>): Promise<string> {
    try {
      await p;
    } catch (e) {
      return String((e as Error).message);
    }
    return 'NO ERROR';
  }
  const entries = (poolId: string) => count(t, 'contest_entries ce', `ce.pool_id = $1 AND NOT EXISTS (SELECT 1 FROM contest_entry_voids v WHERE v.entry_id = ce.id)`, [poolId]);
  const txns = (kind: string) => count(t, 'ledger_transactions', 'kind = $1', [kind]);
  const notes = (kind: string, userId?: string) =>
    count(t, 'notification_queue', userId ? 'kind = $1 AND user_id = $2' : 'kind = $1', userId ? [kind, userId] : [kind]);

  /** Close the pool, fund the overlay, freeze 18 weeks, score, and write the official week 18 snapshot. */
  async function finishSeason(poolId: string, points: Map<string, number>) {
    clock.set(new Date(CLOSE.getTime() + 20 * MIN));
    const [closed] = await pay.closeEntries();
    if (closed.outcome === 'closed' && closed.overlayCents > 0) {
      await pay.recordTransfer({ from: 'operating_bank', to: 'prize_bank', amountCents: closed.overlayCents, reference: `overlay-${poolId}` });
    }
    for (const [userId, x100] of points) {
      await t.sql(
        `INSERT INTO user_week_scores (user_id, season, week, points_x100, slots_scored, status, updated_at)
         VALUES ($1, $2, 18, $3, 9, 'final', now())`,
        [userId, SEASON, x100]
      );
    }
    for (let w = 1; w <= 18; w++) {
      await t.sql(`INSERT INTO week_freezes (season, week, last_final_at, frozen_at, scores_frozen) VALUES ($1, $2, now(), now(), 0)`, [SEASON, w]);
    }
    await t.db.transaction((tx) => writeSnapshots(tx, 'official', { season: SEASON, week: 18, serverNow: clock.get() }));
    clock.set(new Date('2027-01-12T15:00:00Z'));
  }
  async function enableBank(userId: string, o: { tin?: boolean; instant?: boolean } = {}) {
    clock.advanceMs(1000);
    return deliver({
      type: 'account_updated', userId, accountRef: `acct_${userId.slice(0, 8)}`,
      status: { payoutsEnabled: true, tinVerified: o.tin ?? true, instantEligible: o.instant ?? true }, occurredAt: clock.get(),
    });
  }
  const payoutOf = async (userId: string) =>
    (await t.sql<{ id: string; status: string; payout_ref: string | null; amount_cents: string; attempt: number; speed: string; fee_cents: string }>(
      `SELECT id::text, status, payout_ref, amount_cents::text, attempt, speed, fee_cents::text FROM payouts WHERE user_id = $1 ORDER BY attempt`,
      [userId]
    ));

  // ── End to end ────────────────────────────────────────────────────────────
  it('end to end: publish → 6 entries → close with overlay → settle from snapshot → pay → integrity clean', async () => {
    const poolId = await openPool({ capacity: 10, minEntries: 2 }); // $25 × 10: pool $212.50, 2 paid
    const users: string[] = [];
    for (let i = 0; i < 6; i++) {
      const e = await enter(poolId, `e2e${i}`);
      users.push(e.userId);
      await deliver({ type: 'fee_reported', paymentRef: e.paymentRef, feeCents: 103, occurredAt: clock.get() });
    }
    await deliver({ type: 'funds_settled', prizeCents: 6 * 2125, operatingCents: 6 * 375 - 6 * 103, occurredAt: clock.get() });
    expect(await owed(t.db, acct.prizeLiability(poolId))).toBe(6 * 2125);

    await finishSeason(poolId, new Map(users.map((u, i) => [u, 10_000 - i * 100])));
    expect(await owed(t.db, acct.prizeLiability(poolId))).toBe(21250); // overlay brought it to the guaranteed pool

    const s = await pay.computeSettlement(poolId);
    expect(s.awards.filter((a) => a.amountCents > 0).map((a) => [a.userId, a.amountCents])).toEqual([[users[0], 13350], [users[1], 7900]]);

    const admin = await createUser(t, 'admin');
    await pay.approveSettlement(poolId, { userId: admin, stepUpAt: clock.get() });
    expect(await owed(t.db, acct.prizeLiability(poolId))).toBe(0);
    expect(await owed(t.db, acct.payable(users[0]))).toBe(13350);

    for (const u of users.slice(0, 2)) await enableBank(u);
    for (const u of users.slice(0, 2)) {
      const [p] = await payoutOf(u);
      expect(p.status).toBe('sent');
      await deliver({ type: 'payout_paid', payoutRef: p.payout_ref!, occurredAt: clock.get() });
      expect(await owed(t.db, acct.payable(u))).toBe(0);
    }
    expect(await balance(t.db, acct.prizeBank)).toBe(6 * 2125 + (21250 - 6 * 2125) - 21250);
    const report = await pay.runIntegrityCheck();
    expect(report).toEqual({ ok: true, failures: [] });
    const [pool] = await t.sql<{ status: string }>(`SELECT status FROM contest_pools WHERE id = $1`, [poolId]);
    expect(pool.status).toBe('settled');
  });

  // ── AC2 ───────────────────────────────────────────────────────────────────
  it('AC2: a published prize table and the pool money terms are immutable at the database level', async () => {
    const poolId = await openPool({ capacity: 1000, minEntries: 200 });
    expect(await reason(t.sql(`UPDATE prize_table_bands SET prize_cents = prize_cents + 100 WHERE pool_id = $1 AND from_place = 1`, [poolId]))).toMatch(/PRIZE_TABLE_PUBLISHED/);
    expect(await reason(t.sql(`INSERT INTO prize_table_bands (pool_id, from_place, to_place, prize_cents) VALUES ($1, 201, 201, 100)`, [poolId]))).toMatch(/PRIZE_TABLE_PUBLISHED/);
    expect(await reason(t.sql(`DELETE FROM prize_table_bands WHERE pool_id = $1`, [poolId]))).toMatch(/PRIZE_TABLE_PUBLISHED/);
    expect(await reason(t.sql(`TRUNCATE prize_table_bands`))).toMatch(/APPEND_ONLY/);
    for (const set of ['prize_pool_cents = 1', 'capacity = 2000', 'rake_bps = 0', 'buy_in_cents = 100', 'min_entries = 1000', 'paid_places = 1']) {
      expect(await reason(t.sql(`UPDATE contest_pools SET ${set} WHERE id = $1`, [poolId]))).toMatch(/POOL_TERMS_FROZEN/);
    }
    expect(await reason(t.sql(`DELETE FROM contest_pools WHERE id = $1`, [poolId]))).toMatch(/POOL_TERMS_FROZEN/);
    expect(await reason(t.sql(`UPDATE contest_pools SET status = 'draft' WHERE id = $1`, [poolId]))).toMatch(/POOL_STATUS/);
    const [sum] = await t.sql<{ s: string }>(`SELECT SUM(prize_cents * (to_place - from_place + 1))::text AS s FROM prize_table_bands WHERE pool_id = $1`, [poolId]);
    expect(Number(sum.s)).toBe(2125000);
  });

  it('D7: publishing sets entry to close at the Week 3 lock once the schedule is imported, and refuses after it', async () => {
    // No schedule yet: the draft's close time stands.
    const a = await draftPool(2500, new Date('2026-10-01T17:00:00Z'));
    await pay.publishPool(a, { capacity: 10, minEntries: 2 });
    const closes = async (id: string) => new Date((await t.sql<{ c: Date }>(`SELECT entry_closes_at AS c FROM contest_pools WHERE id = $1`, [id]))[0].c).toISOString();
    expect(await closes(a)).toBe('2026-10-01T17:00:00.000Z');

    // Week 3's first window (canceled and empty ones don't count) sets it.
    await createWindow(t, { week: 3, scheduledEt: new Date('2026-09-24T17:00:00Z'), status: 'canceled' });
    await createWindow(t, { week: 3, scheduledEt: new Date('2026-09-24T18:00:00Z'), msfGameIds: [] });
    await createWindow(t, { week: 3, scheduledEt: new Date('2026-09-25T00:15:00Z') });
    await createWindow(t, { week: 3, scheduledEt: new Date('2026-09-27T17:00:00Z') });
    const b = await draftPool(5000, new Date('2026-12-01T00:00:00Z'));
    await pay.publishPool(b, { capacity: 10, minEntries: 2 });
    expect(await closes(b)).toBe('2026-09-25T00:15:00.000Z');

    clock.set(new Date('2026-09-25T00:15:00Z'));
    const c = await draftPool(10000);
    expect(await reason(pay.publishPool(c, { capacity: 10, minEntries: 2 }))).toMatch(/ENTRY_CUTOFF_PASSED/);
    const [{ status }] = await t.sql<{ status: string }>(`SELECT status FROM contest_pools WHERE id = $1`, [c]);
    expect(status).toBe('draft');
  });

  it('AC2: publishing requires a consistent table and a minimum field between paid places and capacity', async () => {
    const a = await draftPool();
    expect(await reason(pay.publishPool(a, { capacity: 1000, minEntries: 199 }))).toMatch(/MIN_ENTRIES_RANGE/);
    expect(await reason(pay.publishPool(a, { capacity: 1000, minEntries: 1001 }))).toMatch(/MIN_ENTRIES_RANGE/);
    const b = await draftPool(5000);
    await t.sql(
      `UPDATE contest_pools SET capacity = 10, min_entries = 2, rake_bps = 1200, prize_pool_cents = 44000, paid_places = 2,
              min_cash_cents = 7500, prize_algorithm = 'manual' WHERE id = $1`, [b]);
    await t.sql(`INSERT INTO prize_table_bands (pool_id, from_place, to_place, prize_cents) VALUES ($1, 1, 1, 30000), ($1, 2, 2, 10000)`, [b]);
    expect(await reason(t.sql(`UPDATE contest_pools SET status = 'open', published_at = now() WHERE id = $1`, [b]))).toMatch(/PRIZE_TABLE_INVALID/);
    expect(await reason(t.sql(`UPDATE contest_pools SET min_entries = 1 WHERE id = $1`, [b]))).toMatch(/contest_pools_terms_range_check/);
  });

  // ── AC3 ───────────────────────────────────────────────────────────────────
  it('AC3: the gate returns the right reason code for each check', async () => {
    const poolId = await openPool({ capacity: 5, minEntries: 1 });
    const ok = await verifiedUser('ok');

    expect(await pay.startCheckout(req(ok, poolId, { stepUpAt: null }))).toEqual({ ok: false, reason: 'STEP_UP_REQUIRED' });
    expect(await pay.startCheckout(req(ok, poolId, { stepUpAt: new Date(clock.get().getTime() - 6 * MIN) }))).toEqual({ ok: false, reason: 'STEP_UP_REQUIRED' });

    expect(await pay.startCheckout(req(ok, await draftPool(10000)))).toEqual({ ok: false, reason: 'ENTRY_CLOSED' });

    const unverified = await createUser(t, 'unverified');
    expect(await pay.startCheckout(req(unverified, poolId))).toEqual({ ok: false, reason: 'IDENTITY_UNVERIFIED' });

    const nineteen = await verifiedUser('nineteen', { birthDate: '2007-03-01' });
    expect(await pay.startCheckout(req(nineteen, poolId, { billingRegion: 'MA' }))).toEqual({ ok: false, reason: 'UNDER_AGE' });
    const seventeen = await verifiedUser('seventeen', { birthDate: '2009-06-01' });
    expect(await pay.startCheckout(req(seventeen, poolId))).toEqual({ ok: false, reason: 'UNDER_AGE' });

    for (const over of [{ ipRegion: 'WA' }, { billingRegion: 'NV' }, { ipRegion: 'LA' }, { billingRegion: 'XX' }]) {
      expect(await pay.startCheckout(req(ok, poolId, over))).toEqual({ ok: false, reason: 'JURISDICTION_BLOCKED' });
    }

    const held = await verifiedUser('held');
    await t.sql(`INSERT INTO account_holds (user_id, reason, opened_at) VALUES ($1, 'ADMIN', now())`, [held]);
    expect(await pay.startCheckout(req(held, poolId))).toEqual({ ok: false, reason: 'ACCOUNT_HOLD' });

    const first = await pay.startCheckout(req(ok, poolId));
    expect(first.ok).toBe(true);
    expect(await pay.startCheckout(req(ok, poolId))).toEqual({ ok: false, reason: 'ALREADY_ENTERED' }); // live hold
    await capture((first as { intentId: string }).intentId);
    expect(await pay.startCheckout(req(ok, poolId))).toEqual({ ok: false, reason: 'ALREADY_ENTERED' }); // entered
    expect(await pay.startCheckout(req(nineteen, poolId))).toMatchObject({ ok: true }); // 19 is fine in GA

    for (let i = 0; i < 3; i++) expect((await pay.startCheckout(req(await verifiedUser(`fill${i}`), poolId))).ok).toBe(true);
    expect(await pay.startCheckout(req(await verifiedUser('late'), poolId))).toEqual({ ok: false, reason: 'POOL_FULL' });

    clock.set(CLOSE);
    expect(await pay.startCheckout(req(await verifiedUser('closed'), poolId))).toEqual({ ok: false, reason: 'ENTRY_CLOSED' });
  });

  it('AC3: holds expire and release their seat; the hold never outlives entry close', async () => {
    const poolId = await openPool({ capacity: 5, minEntries: 1 });
    const users = await Promise.all([0, 1, 2, 3, 4].map((i) => verifiedUser(`h${i}`)));
    for (const u of users) expect((await pay.startCheckout(req(u, poolId))).ok).toBe(true);
    const late = await verifiedUser('late');
    expect(await pay.startCheckout(req(late, poolId))).toEqual({ ok: false, reason: 'POOL_FULL' });
    clock.advanceMs(16 * MIN);
    expect(await pay.expireHolds()).toBe(5);
    expect(await pay.startCheckout(req(late, poolId, { stepUpAt: clock.get() }))).toMatchObject({ ok: true });
    clock.set(new Date(CLOSE.getTime() - 5 * MIN));
    const nearClose = await pay.startCheckout(req(users[0], poolId, { stepUpAt: clock.get() }));
    expect(nearClose.ok && nearClose.holdExpiresAt.getTime()).toBe(CLOSE.getTime());
    const [call] = fake.calls.filter((c) => c.method === 'createCheckout').slice(-1);
    expect((call.args.expiresAt as Date).getTime()).toBe(CLOSE.getTime());
  });

  // ── AC4 ───────────────────────────────────────────────────────────────────
  it('AC4: 50 concurrent checkouts for 3 remaining seats produce exactly 3 holds', async () => {
    // Fewer seats than test connections (5), so parallel transactions must contend for them.
    const poolId = await openPool({ capacity: 3, minEntries: 1 });
    const users: string[] = [];
    for (let i = 0; i < 50; i++) users.push(await verifiedUser(`race${i}`));
    // Delay every seat insert so concurrent transactions all count before any of them inserts:
    // without the pool row lock this oversells every time.
    const jitter = (sql: string): Promise<void> =>
      new Promise((r) => setTimeout(r, sql.trimStart().startsWith('INSERT INTO entry_intents') ? 25 : Math.random() * 4));
    const slowDb = {
      query: t.db.query.bind(t.db),
      transaction: <R>(fn: (tx: { query: typeof t.db.query }) => Promise<R>) =>
        t.db.transaction((tx) => fn({ query: async (sql: string, params?: unknown[]) => { await jitter(sql); return tx.query(sql, params); } } as typeof tx)),
    } as typeof t.db;
    const racing = await createPaymentsService({ db: slowDb, processor: fake, getServerTime: clock.get, env: {} });
    const results = await Promise.all(users.map((u) => racing.startCheckout(req(u, poolId))));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok && r.reason === 'POOL_FULL')).toHaveLength(47);
    expect(await count(t, 'entry_intents', `pool_id = $1 AND status = 'pending'`, [poolId])).toBe(3);
  });

  // ── AC5 ───────────────────────────────────────────────────────────────────
  it('AC5: the same capture delivered twice (or concurrently, or under a new event id) yields one entry and one posting', async () => {
    const poolId = await openPool();
    const user = await verifiedUser('dup');
    const c = await pay.startCheckout(req(user, poolId));
    if (!c.ok) throw new Error(c.reason);
    const w = fake.webhook({ type: 'payment_captured', intentId: c.intentId, paymentRef: 'pi_once', amountCents: 2500, occurredAt: clock.get() });
    const [a, b] = await Promise.all([pay.handleWebhook(w.body, w.headers), pay.handleWebhook(w.body, w.headers)]);
    expect([a.status, b.status].sort()).toEqual(['duplicate', 'processed']);
    expect((await pay.handleWebhook(w.body, w.headers)).status).toBe('duplicate');
    await capture(c.intentId, { paymentRef: 'pi_once' }); // same payment, new event id
    expect(await entries(poolId)).toBe(1);
    expect(await txns('capture')).toBe(1);
    expect(await notes('ENTRY_RECEIPT', user)).toBe(1);
    expect(await count(t, 'refunds')).toBe(0);
  });

  it('AC5: a webhook with a bad signature is rejected and stored nowhere', async () => {
    const w = fake.webhook({ type: 'payment_failed', intentId: randomUUID(), occurredAt: clock.get() });
    await expect(pay.handleWebhook(w.body, { 'x-fake-signature': 'deadbeef'.repeat(8) })).rejects.toBeInstanceOf(WebhookSignatureError);
    const tampered = Buffer.from(w.body.toString().replace('payment_failed', 'payment_captured'));
    await expect(pay.handleWebhook(tampered, w.headers)).rejects.toBeInstanceOf(WebhookSignatureError);
    expect(await count(t, 'processor_events')).toBe(0);
  });

  // ── AC6 ───────────────────────────────────────────────────────────────────
  it('AC6: a capture after close produces no entry and a full refund; the user nets to zero', async () => {
    const poolId = await openPool();
    const user = await verifiedUser('late');
    clock.set(new Date(CLOSE.getTime() - 2 * MIN));
    const c = await pay.startCheckout(req(user, poolId));
    if (!c.ok) throw new Error(c.reason);
    clock.set(new Date(CLOSE.getTime() + 30_000));
    const { paymentRef } = await capture(c.intentId, { at: clock.get() });
    expect(await entries(poolId)).toBe(0);
    const [r] = await t.sql<{ reason: string; amount_cents: number; refund_ref: string }>(`SELECT reason, amount_cents, refund_ref FROM refunds WHERE payment_ref = $1`, [paymentRef]);
    expect(r).toMatchObject({ reason: 'CAPTURE_AFTER_CLOSE', amount_cents: 2500 });
    expect(r.refund_ref).toMatch(/^re_/); // sent to the processor straight away
    expect(await owed(t.db, acct.refundPayable(user))).toBe(2500);
    await deliver({ type: 'refund_succeeded', refundRef: r.refund_ref, occurredAt: clock.get() });
    expect(await owed(t.db, acct.refundPayable(user))).toBe(0);
    expect(await balance(t.db, acct.clearingOperating)).toBe(0);
    expect(await owed(t.db, acct.prizeLiability(poolId))).toBe(0);
    expect(await count(t, 'ledger_entries', `account = 'rake_revenue'`)).toBe(0);
  });

  it('AC6: a late capture into a full pool, a second payment for one intent, and a wrong amount are all refunded', async () => {
    const poolId = await openPool({ capacity: 5, minEntries: 1 });
    const slow = await verifiedUser('slow');
    const c = await pay.startCheckout(req(slow, poolId));
    if (!c.ok) throw new Error(c.reason);
    clock.advanceMs(16 * MIN);
    await pay.expireHolds();
    for (let i = 0; i < 5; i++) await enter(poolId, `fast${i}`);
    await capture(c.intentId);
    expect(await entries(poolId)).toBe(5);
    expect(await count(t, 'refunds', `reason = 'CAPTURE_AFTER_CLOSE' AND user_id = $1`, [slow])).toBe(1);

    const pool2 = await openPool({ buyIn: 5000 });
    const twice = await verifiedUser('twice');
    const c2 = await pay.startCheckout(req(twice, pool2));
    if (!c2.ok) throw new Error(c2.reason);
    await capture(c2.intentId, { amountCents: 5000 });
    await capture(c2.intentId, { amountCents: 5000 }); // a second, different payment for the same intent
    expect(await entries(pool2)).toBe(1);
    expect(await count(t, 'refunds', `reason = 'DUPLICATE_CHARGE' AND user_id = $1`, [twice])).toBe(1);

    const wrong = await verifiedUser('wrong');
    const c3 = await pay.startCheckout(req(wrong, pool2));
    if (!c3.ok) throw new Error(c3.reason);
    await capture(c3.intentId, { amountCents: 100 });
    expect(await count(t, 'refunds', `reason = 'PLATFORM_ERROR' AND user_id = $1`, [wrong])).toBe(1);
    expect(await entries(pool2)).toBe(1);
    expect(await pay.runIntegrityCheck()).toMatchObject({ ok: true });
  });

  // ── AC7 ───────────────────────────────────────────────────────────────────
  it('AC7: unbalanced ledger transactions are rejected at commit; the ledger is append-only', async () => {
    const insertTxn = async (entriesSql: string) =>
      t.db.transaction(async (tx) => {
        const [txn] = await tx.query<{ id: string }>(
          `INSERT INTO ledger_transactions (kind, ref_type, ref_id, idempotency_key, occurred_at)
           VALUES ('transfer', 'test', 'x', $1, now()) RETURNING id::text AS id`,
          [randomUUID()]
        );
        await tx.query(`INSERT INTO ledger_accounts (code, kind) VALUES ('prize_bank', 'asset'), ('operating_bank', 'asset') ON CONFLICT DO NOTHING`);
        if (entriesSql) await tx.query(entriesSql.replace(/\$TXN/g, `'${txn.id}'`));
      });
    expect(await reason(insertTxn(`INSERT INTO ledger_entries (txn_id, account, amount_cents) VALUES ($TXN, 'prize_bank', 100), ($TXN, 'operating_bank', -99)`))).toMatch(/LEDGER_UNBALANCED/);
    expect(await reason(insertTxn(''))).toMatch(/LEDGER_UNBALANCED/);
    expect(await reason(insertTxn(`INSERT INTO ledger_entries (txn_id, account, amount_cents) VALUES ($TXN, 'prize_bank', 0), ($TXN, 'operating_bank', 0)`))).toMatch(/nonzero/);
    expect(await count(t, 'ledger_transactions')).toBe(0);
    await insertTxn(`INSERT INTO ledger_entries (txn_id, account, amount_cents) VALUES ($TXN, 'prize_bank', 100), ($TXN, 'operating_bank', -100)`);
    expect(await reason(t.sql(`UPDATE ledger_entries SET amount_cents = amount_cents * 2`))).toMatch(/APPEND_ONLY/);
    expect(await reason(t.sql(`DELETE FROM ledger_entries`))).toMatch(/APPEND_ONLY/);
    expect(await reason(t.sql(`UPDATE ledger_transactions SET kind = 'fee'`))).toMatch(/APPEND_ONLY/);
    expect(await reason(t.sql(`DELETE FROM ledger_transactions`))).toMatch(/APPEND_ONLY/);
    expect(await reason(t.sql(`TRUNCATE ledger_entries, ledger_transactions`))).toMatch(/APPEND_ONLY/);
    expect(await reason(t.sql(`UPDATE ledger_accounts SET kind = 'revenue'`))).toMatch(/APPEND_ONLY/);
  });

  // ── AC8 ───────────────────────────────────────────────────────────────────
  it('AC8: processor fees never touch the prize liability', async () => {
    const poolId = await openPool();
    for (let i = 0; i < 7; i++) {
      const e = await enter(poolId, `fee${i}`);
      await deliver({ type: 'fee_reported', paymentRef: e.paymentRef, feeCents: 103, occurredAt: clock.get() });
    }
    expect(await owed(t.db, acct.prizeLiability(poolId))).toBe(7 * 2125);
    expect(await balance(t.db, acct.processingFees)).toBe(7 * 103);
    // No posting path may debit a prize liability for a fee, even a hand-written one.
    const attempt = t.db.transaction(async (tx) => {
      const [txn] = await tx.query<{ id: string }>(
        `INSERT INTO ledger_transactions (kind, ref_type, ref_id, idempotency_key, occurred_at) VALUES ('fee', 'x', 'x', 'sneaky', now()) RETURNING id`
      );
      await tx.query(`INSERT INTO ledger_entries (txn_id, account, amount_cents) VALUES ($1, $2, 103), ($1, 'processing_fees', -103)`, [txn.id, acct.prizeLiability(poolId)]);
    });
    expect(await reason(attempt)).toMatch(/PRIZE_POOL_PROTECTED/);
  });

  // ── AC9 ───────────────────────────────────────────────────────────────────
  it('AC9: settlement refuses without a closed pool, 18 frozen weeks, and a matching official snapshot', async () => {
    const poolId = await openPool({ capacity: 10, minEntries: 2 });
    const a = await enter(poolId, 'a');
    const b = await enter(poolId, 'b');
    expect(await reason(pay.computeSettlement(poolId))).toMatch(/POOL_NOT_CLOSED/);

    clock.set(new Date(CLOSE.getTime() + 20 * MIN));
    const [closed] = await pay.closeEntries();
    expect(closed.outcome).toBe('closed');
    await pay.recordTransfer({ from: 'operating_bank', to: 'prize_bank', amountCents: (closed as { overlayCents: number }).overlayCents, reference: 'ov' });
    for (let w = 1; w <= 17; w++) await t.sql(`INSERT INTO week_freezes (season, week, last_final_at, frozen_at, scores_frozen) VALUES ($1, $2, now(), now(), 0)`, [SEASON, w]);
    expect(await reason(pay.computeSettlement(poolId))).toMatch(/WEEKS_NOT_FROZEN: 17 of 18/);
    await t.sql(`INSERT INTO week_freezes (season, week, last_final_at, frozen_at, scores_frozen) VALUES ($1, 18, now(), now(), 0)`, [SEASON]);
    expect(await reason(pay.computeSettlement(poolId))).toMatch(/SNAPSHOT_MISSING/);
    expect(await count(t, 'settlements')).toBe(0);
  });

  it('AC9: settlement reads only the snapshot: later score changes do not move money', async () => {
    const poolId = await openPool({ capacity: 10, minEntries: 2 });
    const a = await enter(poolId, 'a');
    const b = await enter(poolId, 'b');
    await finishSeason(poolId, new Map([[a.userId, 5000], [b.userId, 4000]]));
    await t.sql(`UPDATE user_week_scores SET points_x100 = 99999 WHERE user_id = $1`, [b.userId]); // after the snapshot
    const s = await pay.computeSettlement(poolId);
    expect(s.awards.map((x) => [x.userId, x.rank, x.amountCents])).toEqual([[a.userId, 1, 13350], [b.userId, 2, 7900]]);
  });

  it('AC9: a snapshot whose ranks do not match its own points is refused', async () => {
    const poolId = await openPool({ capacity: 10, minEntries: 2 });
    const a = await enter(poolId, 'a');
    const b = await enter(poolId, 'b');
    clock.set(new Date(CLOSE.getTime() + 20 * MIN));
    const [closed] = await pay.closeEntries();
    await pay.recordTransfer({ from: 'operating_bank', to: 'prize_bank', amountCents: (closed as { overlayCents: number }).overlayCents, reference: 'ov' });
    for (let w = 1; w <= 18; w++) await t.sql(`INSERT INTO week_freezes (season, week, last_final_at, frozen_at, scores_frozen) VALUES ($1, $2, now(), now(), 0)`, [SEASON, w]);
    await t.sql(
      `INSERT INTO leaderboard_snapshots (pool_id, week, kind, user_id, handle, rank, points_x100, taken_at)
       VALUES ($1, 18, 'official', $2, 'a', 1, 100, now()), ($1, 18, 'official', $3, 'b', 1, 50, now())`,
      [poolId, a.userId, b.userId]
    );
    expect(await reason(pay.computeSettlement(poolId))).toMatch(/STANDINGS_INCONSISTENT/);
  });

  // ── AC11 ──────────────────────────────────────────────────────────────────
  it('AC11: compute and approve are idempotent; awards are immutable; approval needs step-up', async () => {
    const poolId = await openPool({ capacity: 10, minEntries: 2 });
    const a = await enter(poolId, 'a');
    const b = await enter(poolId, 'b');
    await finishSeason(poolId, new Map([[a.userId, 5000], [b.userId, 5000]])); // tied for 1st: split 1st + 2nd
    const first = await pay.computeSettlement(poolId);
    const again = await pay.computeSettlement(poolId);
    expect(again).toEqual(first);
    expect(first.awards.map((x) => x.amountCents).sort()).toEqual([10625, 10625]);

    const admin = await createUser(t, 'admin');
    await expect(pay.approveSettlement(poolId, { userId: admin, stepUpAt: null })).rejects.toBeInstanceOf(StepUpRequiredError);
    const [r1, r2] = await Promise.all([
      pay.approveSettlement(poolId, { userId: admin, stepUpAt: clock.get() }),
      pay.approveSettlement(poolId, { userId: admin, stepUpAt: clock.get() }),
    ]);
    expect([r1.approved, r2.approved].sort()).toEqual([false, true]);
    expect(await txns('settlement_approve')).toBe(1);
    expect(await reason(t.sql(`UPDATE settlement_awards SET amount_cents = 0`))).toMatch(/APPEND_ONLY/);
    expect(await reason(t.sql(`DELETE FROM settlement_awards`))).toMatch(/APPEND_ONLY/);
    expect(await reason(t.sql(`INSERT INTO settlement_awards (pool_id, entry_id, user_id, rank, tie_size, amount_cents) VALUES ($1, gen_random_uuid(), $2, 9, 1, 1)`, [poolId, a.userId]))).toMatch(/SETTLEMENT_IMMUTABLE/);
    expect(await reason(t.sql(`UPDATE settlements SET status = 'computed'`))).toMatch(/SETTLEMENT_IMMUTABLE/);
  });

  // ── AC12 / AC13 ───────────────────────────────────────────────────────────
  it('AC12: no payout without payoutsEnabled AND tinVerified; account_updated releases the held award', async () => {
    const poolId = await openPool({ capacity: 10, minEntries: 2 });
    const a = await enter(poolId, 'a');
    const b = await enter(poolId, 'b');
    await finishSeason(poolId, new Map([[a.userId, 5000], [b.userId, 4000]]));
    await pay.computeSettlement(poolId);
    await pay.approveSettlement(poolId, { userId: await createUser(t, 'admin'), stepUpAt: clock.get() });

    expect(await payoutOf(a.userId)).toEqual([]);
    expect(await notes('PAYOUT_BLOCKED', a.userId)).toBe(1); // day-0 notice
    expect(await pay.getMyPayouts(a.userId)).toMatchObject({ blockedBy: ['BANK_ACCOUNT', 'W9'], awards: [{ amountCents: 13350, payouts: [] }] });

    await enableBank(a.userId, { tin: false }); // bank attached, no W-9 yet
    expect(await payoutOf(a.userId)).toEqual([]);
    clock.advanceMs(8 * DAY);
    await pay.queuePayouts();
    expect(await notes('PAYOUT_BLOCKED', a.userId)).toBe(3); // day 1 and day 7 reminders, once each
    await pay.queuePayouts();
    expect(await notes('PAYOUT_BLOCKED', a.userId)).toBe(3);

    await enableBank(a.userId, { tin: true });
    const [p] = await payoutOf(a.userId);
    expect(p).toMatchObject({ status: 'sent', amount_cents: '13350', speed: 'standard', fee_cents: '0' });
    expect(await owed(t.db, acct.payable(a.userId))).toBe(13350); // still owed until paid
  });

  it('AC13: payout webhooks are idempotent; failures reverse to payable and wait for an account update', async () => {
    const poolId = await openPool({ capacity: 10, minEntries: 2 });
    const a = await enter(poolId, 'a');
    const b = await enter(poolId, 'b');
    await finishSeason(poolId, new Map([[a.userId, 5000], [b.userId, 4000]]));
    await pay.computeSettlement(poolId);
    await pay.approveSettlement(poolId, { userId: await createUser(t, 'admin'), stepUpAt: clock.get() });
    await enableBank(a.userId);

    let [p] = await payoutOf(a.userId);
    await deliver({ type: 'payout_failed', payoutRef: p.payout_ref!, reason: 'account_closed', occurredAt: clock.get() });
    expect((await payoutOf(a.userId))[0].status).toBe('failed');
    expect(await notes('PAYOUT_FAILED', a.userId)).toBe(1);
    expect(await owed(t.db, acct.payable(a.userId))).toBe(13350);
    await pay.queuePayouts();
    expect(await payoutOf(a.userId)).toHaveLength(1); // no retry until the account changes

    await enableBank(a.userId);
    const attempts = await payoutOf(a.userId);
    expect(attempts.map((x) => [x.attempt, x.status])).toEqual([[1, 'failed'], [2, 'sent']]);
    p = attempts[1];
    const paid = fake.webhook({ type: 'payout_paid', payoutRef: p.payout_ref!, occurredAt: clock.get() });
    await pay.handleWebhook(paid.body, paid.headers);
    await pay.handleWebhook(paid.body, paid.headers);
    await deliver({ type: 'payout_paid', payoutRef: p.payout_ref!, occurredAt: clock.get() }); // new event id, same payout
    expect(await txns('payout_paid')).toBe(1);
    expect(await owed(t.db, acct.payable(a.userId))).toBe(0);

    // Returned after being paid: money back in the prize bank, owed to the user again.
    await deliver({ type: 'payout_failed', payoutRef: p.payout_ref!, reason: 'returned_by_bank', occurredAt: clock.get() });
    expect(await owed(t.db, acct.payable(a.userId))).toBe(13350);
    expect(await txns('payout_returned')).toBe(1);
  });

  it('AC13: an event that arrives before its precondition is deferred and retried', async () => {
    const r = await deliver({ type: 'payout_paid', payoutRef: 'po_not_yet_stored', occurredAt: clock.get() });
    expect(r.result.status).toBe('deferred');
    expect((await pay.retryUnprocessedEvents())[0].status).toBe('deferred');
    expect(await count(t, 'processor_events', 'processed_at IS NULL')).toBe(1);
  });

  it('AC12: instant payout is opt-in with step-up, and the fee shown is the fee charged', async () => {
    const poolId = await openPool({ capacity: 10, minEntries: 2 });
    const a = await enter(poolId, 'a');
    const b = await enter(poolId, 'b');
    await finishSeason(poolId, new Map([[a.userId, 5000], [b.userId, 4000]]));
    await pay.computeSettlement(poolId);
    await pay.approveSettlement(poolId, { userId: await createUser(t, 'admin'), stepUpAt: clock.get() });
    // Queue without sending, so the user has a window to choose instant.
    await t.sql(`INSERT INTO payout_accounts (user_id, processor, account_ref, payouts_enabled, tin_verified, instant_eligible, updated_at) VALUES ($1, 'fake', 'acct', true, true, true, now())`, [a.userId]);
    await pay.queuePayouts();
    const [p] = await payoutOf(a.userId);
    const quote = await pay.quoteInstantPayout(a.userId, p.id);
    expect(quote).toEqual({ amountCents: 13350, feeCents: 201, netCents: 13149 });
    await expect(pay.requestInstantPayout({ userId: a.userId, payoutId: p.id, stepUpAt: null, confirmedFeeCents: 201 })).rejects.toBeInstanceOf(StepUpRequiredError);
    expect(await reason(pay.requestInstantPayout({ userId: a.userId, payoutId: p.id, stepUpAt: clock.get(), confirmedFeeCents: 100 }))).toMatch(/INSTANT_FEE_CHANGED/);
    expect(await reason(pay.requestInstantPayout({ userId: b.userId, payoutId: p.id, stepUpAt: clock.get(), confirmedFeeCents: 201 }))).toMatch(/PAYOUT_NOT_PENDING/);
    await pay.requestInstantPayout({ userId: a.userId, payoutId: p.id, stepUpAt: clock.get(), confirmedFeeCents: 201 });
    await pay.sendPendingPayouts();
    expect((await payoutOf(a.userId))[0]).toMatchObject({ status: 'sent', speed: 'instant', fee_cents: '201' });
    expect(await reason(t.sql(`UPDATE payouts SET speed = 'standard' WHERE id = $1`, [p.id]))).toMatch(/PAYOUT_IMMUTABLE/);
  });

  // ── AC14 ──────────────────────────────────────────────────────────────────
  it('AC14: a dispute holds the account; a lost chargeback is the platform\'s loss, never the prize pool\'s', async () => {
    const poolId = await openPool();
    const e = await enter(poolId, 'disputer');
    await deliver({ type: 'dispute_opened', paymentRef: e.paymentRef, amountCents: 2500, occurredAt: clock.get() });
    const other = await openPool({ buyIn: 5000 });
    expect(await pay.startCheckout(req(e.userId, other))).toEqual({ ok: false, reason: 'ACCOUNT_HOLD' });
    expect(await entries(poolId)).toBe(1); // the entry stays in the field
    const before = await owed(t.db, acct.prizeLiability(poolId));
    await deliver({ type: 'dispute_closed', paymentRef: e.paymentRef, outcome: 'lost', feeCents: 1500, occurredAt: clock.get() });
    expect(await owed(t.db, acct.prizeLiability(poolId))).toBe(before);
    expect(await balance(t.db, acct.chargebackLoss)).toBe(4000);
    expect(await count(t, 'account_holds', 'user_id = $1 AND closed_at IS NULL', [e.userId])).toBe(1); // stays held

    const f = await enter(poolId, 'winner-of-dispute');
    await deliver({ type: 'dispute_opened', paymentRef: f.paymentRef, amountCents: 2500, occurredAt: clock.get() });
    await deliver({ type: 'dispute_closed', paymentRef: f.paymentRef, outcome: 'won', feeCents: 0, occurredAt: clock.get() });
    expect(await count(t, 'account_holds', 'user_id = $1 AND closed_at IS NULL', [f.userId])).toBe(0);
  });

  it('AC14: an open dispute blocks a payout even after the award is released', async () => {
    const poolId = await openPool({ capacity: 10, minEntries: 2 });
    const a = await enter(poolId, 'a');
    const b = await enter(poolId, 'b');
    await finishSeason(poolId, new Map([[a.userId, 5000], [b.userId, 4000]]));
    await pay.computeSettlement(poolId);
    await pay.approveSettlement(poolId, { userId: await createUser(t, 'admin'), stepUpAt: clock.get() });
    await deliver({ type: 'dispute_opened', paymentRef: a.paymentRef, amountCents: 2500, occurredAt: clock.get() });
    await enableBank(a.userId);
    expect(await payoutOf(a.userId)).toEqual([]);
    expect((await pay.getMyPayouts(a.userId)).blockedBy).toEqual(['ACCOUNT_HOLD']);
  });

  // ── AC15 ──────────────────────────────────────────────────────────────────
  it('AC15: below the minimum field at close, the pool is cancelled and every entry refunded in full', async () => {
    const poolId = await openPool({ capacity: 10, minEntries: 5 });
    const es = [await enter(poolId, 'c1'), await enter(poolId, 'c2'), await enter(poolId, 'c3')];
    clock.set(new Date(CLOSE.getTime() + 5 * MIN));
    expect(await pay.closeEntries()).toEqual([]); // still inside the grace period
    clock.set(new Date(CLOSE.getTime() + 16 * MIN));
    expect(await pay.closeEntries()).toEqual([{ poolId, outcome: 'cancelled', entries: 3, refunds: 3 }]);
    expect(fake.calls.filter((c) => c.method === 'refund')).toHaveLength(3);
    expect(await count(t, 'refunds', `reason = 'POOL_CANCELLED' AND amount_cents = 2500`)).toBe(3);
    expect(await entries(poolId)).toBe(0);
    expect(await owed(t.db, acct.prizeLiability(poolId))).toBe(0);
    expect(await notes('POOL_CANCELLED')).toBe(3);
    for (const e of es) {
      const [r] = await t.sql<{ refund_ref: string }>(`SELECT refund_ref FROM refunds WHERE payment_ref = $1`, [e.paymentRef]);
      await deliver({ type: 'refund_succeeded', refundRef: r.refund_ref, occurredAt: clock.get() });
      expect(await owed(t.db, acct.refundPayable(e.userId))).toBe(0);
    }
    expect(await balance(t.db, acct.clearingPrize)).toBe(0);
    expect(await balance(t.db, acct.clearingOperating)).toBe(0);
    expect(await pay.runIntegrityCheck()).toMatchObject({ ok: true });
  });

  it('AC15: a field between the minimum and capacity posts exactly P − collected as overlay', async () => {
    const poolId = await openPool({ capacity: 10, minEntries: 2 });
    for (let i = 0; i < 4; i++) await enter(poolId, `o${i}`);
    clock.set(new Date(CLOSE.getTime() + 16 * MIN));
    expect(await pay.closeEntries()).toEqual([{ poolId, outcome: 'closed', entries: 4, overlayCents: 21250 - 4 * 2125 }]);
    expect(await owed(t.db, acct.prizeLiability(poolId))).toBe(21250);
    expect(await balance(t.db, acct.overlayExpense)).toBe(12750);
    expect(await pay.closeEntries()).toEqual([]);
    expect(await txns('overlay')).toBe(1);
  });

  // ── AC16 ──────────────────────────────────────────────────────────────────
  it('AC16: tax-year totals by year of payment (Eastern), gross and net, against that year\'s threshold', async () => {
    const poolId = await openPool({ capacity: 10, minEntries: 2 });
    const a = await enter(poolId, 'a');
    const b = await enter(poolId, 'b');
    await finishSeason(poolId, new Map([[a.userId, 5000], [b.userId, 4000]]));
    await pay.computeSettlement(poolId);
    await pay.approveSettlement(poolId, { userId: await createUser(t, 'admin'), stepUpAt: clock.get() });
    await enableBank(a.userId);
    await enableBank(b.userId);
    const [pa] = await payoutOf(a.userId);
    const [pb] = await payoutOf(b.userId);
    await deliver({ type: 'payout_paid', payoutRef: pa.payout_ref!, occurredAt: new Date('2027-01-15T15:00:00Z') });
    await deliver({ type: 'payout_paid', payoutRef: pb.payout_ref!, occurredAt: new Date('2027-01-01T03:00:00Z') }); // Dec 31 ET
    await t.sql(`INSERT INTO tax_thresholds (tax_year, form, threshold_cents) VALUES (2027, '1099-MISC', 10000)`); // test value
    const rows = await t.sql<Record<string, unknown>>(
      `SELECT user_id::text, tax_year, prizes_paid_cents::int, entry_fees_cents::int, net_winnings_cents::int, threshold_cents::int,
              meets_gross_threshold, meets_net_threshold FROM user_tax_year_totals WHERE user_id IN ($1, $2) ORDER BY user_id, tax_year`,
      [a.userId, b.userId]
    );
    const byUser = (u: string) => rows.filter((r) => r.user_id === u).map(({ user_id, ...rest }) => rest);
    expect(byUser(a.userId)).toEqual([
      { tax_year: 2026, prizes_paid_cents: 0, entry_fees_cents: 2500, net_winnings_cents: -2500, threshold_cents: 200000, meets_gross_threshold: false, meets_net_threshold: false },
      { tax_year: 2027, prizes_paid_cents: 13350, entry_fees_cents: 0, net_winnings_cents: 13350, threshold_cents: 10000, meets_gross_threshold: true, meets_net_threshold: true },
    ]);
    expect(byUser(b.userId)).toEqual([
      { tax_year: 2026, prizes_paid_cents: 7900, entry_fees_cents: 2500, net_winnings_cents: 5400, threshold_cents: 200000, meets_gross_threshold: false, meets_net_threshold: false },
    ]);
  });

  // ── AC17 ──────────────────────────────────────────────────────────────────
  it('AC17: a live processor starts only with PAYMENTS_LIVE=true and a recorded written approval', async () => {
    class LiveFake extends FakeProcessor {
      readonly live = true;
      readonly name = 'stripe';
    }
    const live = new LiveFake();
    await expect(createPaymentsService({ db: t.db, processor: live, env: {} })).rejects.toBeInstanceOf(LivePaymentsDisabledError);
    await expect(createPaymentsService({ db: t.db, processor: live, env: { PAYMENTS_LIVE: 'true' } })).rejects.toThrow(/no written approval/);
    const admin = await createUser(t, 'admin');
    await t.sql(`INSERT INTO processor_approvals (processor, approved_at, document_ref, recorded_by) VALUES ('paysafe', now(), 'doc-1', $1)`, [admin]);
    await expect(createPaymentsService({ db: t.db, processor: live, env: { PAYMENTS_LIVE: 'true' } })).rejects.toThrow(/no written approval/);
    await t.sql(`INSERT INTO processor_approvals (processor, approved_at, document_ref, recorded_by) VALUES ('stripe', now(), 'stripe-approval-letter', $1)`, [admin]);
    await expect(createPaymentsService({ db: t.db, processor: live, env: { PAYMENTS_LIVE: 'yes' } })).rejects.toBeInstanceOf(LivePaymentsDisabledError);
    await expect(createPaymentsService({ db: t.db, processor: live, env: { PAYMENTS_LIVE: 'true' } })).resolves.toBeDefined();
    expect(await reason(t.sql(`DELETE FROM processor_approvals`))).toMatch(/APPEND_ONLY/);
  });

  // ── AC18 ──────────────────────────────────────────────────────────────────
  it('AC18: the integrity check catches each planted fault', async () => {
    const poolId = await openPool({ capacity: 10, minEntries: 2 });
    await enter(poolId, 'a');
    await enter(poolId, 'b');
    expect(await pay.runIntegrityCheck()).toEqual({ ok: true, failures: [] });

    const checks = async () => (await pay.runIntegrityCheck()).failures.map((f) => f.check);

    // (a) an entry with no captured payment
    await t.sql(`INSERT INTO contest_entries (pool_id, user_id, entered_at) VALUES ($1, $2, $3)`, [poolId, await createUser(t, 'ghost'), clock.get()]);
    expect(await checks()).toEqual(['ENTRIES_MATCH_CAPTURES']);

    // (b) a liability that doesn't match contributions + overlay
    const pool2 = await openPool({ buyIn: 5000 });
    await t.db.transaction(async (tx) => {
      await post(tx, { kind: 'transfer', refType: 'test', refId: 'x', idempotencyKey: 'plant', occurredAt: clock.get(), postings: [debit(acct.operatingBank, 500), credit(acct.prizeLiability(pool2), 500)] });
    });
    expect(await checks()).toEqual(expect.arrayContaining(['POOL_LIABILITY', 'PRIZE_FUNDS_COVER']));

    // (c) awards that do not sum to the prize pool
    const pool3 = await openPool({ buyIn: 10000 });
    await t.sql(`INSERT INTO settlements (pool_id, snapshot_week, status, computed_at) VALUES ($1, 18, 'computed', now())`, [pool3]);
    await t.sql(`INSERT INTO settlement_awards (pool_id, entry_id, user_id, rank, tie_size, amount_cents) VALUES ($1, gen_random_uuid(), $2, 1, 1, 100)`, [pool3, await createUser(t, 'x')]);
    expect(await checks()).toContain('SETTLEMENT_SUM');
  });

  it('AC18: prize funds must cover prize liabilities (an unfunded overlay blocks settlement), and bank statements reconcile', async () => {
    const poolId = await openPool({ capacity: 10, minEntries: 2 });
    const a = await enter(poolId, 'a');
    const b = await enter(poolId, 'b');
    clock.set(new Date(CLOSE.getTime() + 20 * MIN));
    const [closed] = await pay.closeEntries();
    const overlay = (closed as { overlayCents: number }).overlayCents;
    expect((await pay.runIntegrityCheck()).failures.map((f) => f.check)).toEqual(['PRIZE_FUNDS_COVER']);
    for (let w = 1; w <= 18; w++) await t.sql(`INSERT INTO week_freezes (season, week, last_final_at, frozen_at, scores_frozen) VALUES ($1, $2, now(), now(), 0)`, [SEASON, w]);
    await t.sql(`INSERT INTO user_week_scores (user_id, season, week, points_x100, slots_scored, status, updated_at) VALUES ($1, $2, 18, 100, 9, 'final', now()), ($3, $2, 18, 50, 9, 'final', now())`, [a.userId, SEASON, b.userId]);
    await t.db.transaction((tx) => writeSnapshots(tx, 'official', { season: SEASON, week: 18, serverNow: clock.get() }));
    expect(await reason(pay.computeSettlement(poolId))).toMatch(/INTEGRITY_FAILED: PRIZE_FUNDS_COVER/);

    await pay.recordTransfer({ from: 'operating_bank', to: 'prize_bank', amountCents: overlay, reference: 'overlay' });
    expect(await pay.runIntegrityCheck()).toMatchObject({ ok: true });
    const admin = await createUser(t, 'admin');
    await t.sql(`INSERT INTO bank_reconciliations (account, statement_date, balance_cents, entered_by, entered_at) VALUES ('prize_bank', '2026-09-30', $1, $2, now())`, [overlay - 1, admin]);
    expect((await pay.runIntegrityCheck()).failures.map((f) => f.check)).toEqual(['BANK_RECONCILIATION']);
    await t.sql(`INSERT INTO bank_reconciliations (account, statement_date, balance_cents, entered_by, entered_at) VALUES ('prize_bank', '2026-09-30', $1, $2, now())`, [overlay, admin]);
    expect(await pay.runIntegrityCheck()).toMatchObject({ ok: true });
    expect((await pay.computeSettlement(poolId)).status).toBe('computed');
  });

  // ── AC19 ──────────────────────────────────────────────────────────────────
  it('AC19: no column could hold a card number, bank account number, SSN or TIN', async () => {
    const cols = await t.sql<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`
    );
    const forbidden = /(card|pan$|cvv|cvc|expiry|account_number|routing|iban|swift|ssn|social_security|tax_id|^tin$|_tin$|tin_number|ein$|itin)/i;
    const allowed = new Set(['payout_accounts.tin_verified']);
    const hits = cols.map((c) => `${c.table_name}.${c.column_name}`).filter((n) => forbidden.test(n.split('.')[1]) && !allowed.has(n));
    expect(hits).toEqual([]);
    expect(cols.length).toBeGreaterThan(100); // sanity: we really scanned the schema
  });

  // ── AC20 ──────────────────────────────────────────────────────────────────
  it('AC20: voided entries leave PRD-003 boards and snapshots; a void after close is rejected', async () => {
    const poolId = await openPool({ capacity: 10, minEntries: 2 });
    const a = await enter(poolId, 'a');
    const b = await enter(poolId, 'b');
    const c = await enter(poolId, 'c');
    await pay.refundForPlatformError(c.intentId, 'charged twice by a checkout bug');
    expect((await computeBoard(t.db, poolId)).rows.map((r) => r.userId).sort()).toEqual([a.userId, b.userId].sort());
    expect(await reason(pay.refundForPlatformError(c.intentId, 'again'))).toMatch(/NOT_REFUNDABLE/);
    expect(await reason(pay.refundForPlatformError(a.intentId, ' '))).toMatch(/REASON_REQUIRED/);

    clock.set(new Date(CLOSE.getTime() + 20 * MIN));
    await pay.closeEntries();
    expect(await reason(pay.refundForPlatformError(a.intentId, 'too late'))).toMatch(/ENTRY_CLOSED/);
    const [entry] = await t.sql<{ id: string }>(`SELECT id::text FROM contest_entries WHERE user_id = $1`, [a.userId]);
    // Backdating doesn't help: the pool has closed.
    expect(await reason(t.sql(`INSERT INTO contest_entry_voids (entry_id, reason, voided_at) VALUES ($1, 'PLATFORM_ERROR', '2026-09-02')`, [entry.id]))).toMatch(/ENTRY_VOID_AFTER_CLOSE/);
    expect(await reason(t.sql(`INSERT INTO contest_entries (pool_id, user_id, entered_at) VALUES ($1, $2, '2026-09-02')`, [poolId, await createUser(t, 'sneak')]))).toMatch(/ENTRY_CLOSED/);
    expect(await reason(t.sql(`DELETE FROM contest_entry_voids`))).toMatch(/APPEND_ONLY/);

    await t.sql(`INSERT INTO user_week_scores (user_id, season, week, points_x100, slots_scored, status, updated_at) VALUES ($1, $2, 1, 100, 9, 'final', now())`, [c.userId, SEASON]);
    await t.db.transaction((tx) => writeSnapshots(tx, 'official', { season: SEASON, week: 1, serverNow: clock.get() }));
    expect(await count(t, 'leaderboard_snapshots', 'pool_id = $1', [poolId])).toBe(2);
    expect(await count(t, 'leaderboard_snapshots', 'user_id = $1', [c.userId])).toBe(0);
  });

  // ── identity ──────────────────────────────────────────────────────────────
  it('§11.1: one verified account per person; the person id is stored only as a hash', async () => {
    const u1 = await createUser(t, 'one');
    const u2 = await createUser(t, 'two');
    const r = { provider: 'idv-test', providerRef: 'r1', providerPersonId: 'person-42', birthDate: '1990-01-01', region: 'GA' };
    await pay.recordIdentityVerification({ ...r, userId: u1 });
    await expect(pay.recordIdentityVerification({ ...r, userId: u2, providerRef: 'r2' })).rejects.toThrow(/IDENTITY_IN_USE/);
    await expect(pay.recordIdentityVerification({ ...r, userId: u1, providerPersonId: 'person-43' })).rejects.toThrow(/IDENTITY_EXISTS/);
    const raw = await t.sql<{ row: string }>(`SELECT row_to_json(i)::text AS row FROM identity_verifications i`);
    expect(raw[0].row).not.toContain('person-42');
  });

  it('§11.1: payout onboarding needs step-up, a verified identity, and an allowed state', async () => {
    const u = await verifiedUser('mover', { region: 'WA' });
    await expect(pay.createPayoutOnboardingLink({ userId: u, stepUpAt: null, returnUrl: 'x' })).rejects.toBeInstanceOf(StepUpRequiredError);
    expect(await reason(pay.createPayoutOnboardingLink({ userId: u, stepUpAt: clock.get(), returnUrl: 'x' }))).toMatch(/JURISDICTION_BLOCKED/);
    const ok = await verifiedUser('ga');
    await expect(pay.createPayoutOnboardingLink({ userId: ok, stepUpAt: clock.get(), returnUrl: 'x' })).resolves.toMatchObject({ url: expect.stringContaining(ok) });
    expect(await reason(pay.createPayoutOnboardingLink({ userId: await createUser(t, 'nobody'), stepUpAt: clock.get(), returnUrl: 'x' }))).toMatch(/IDENTITY_UNVERIFIED/);
  });

  it('§13: GET /pools/:id/prizes shows the guaranteed pool, the table, and seats left', async () => {
    const poolId = await openPool({ capacity: 10, minEntries: 2 });
    await enter(poolId, 'a');
    const prizes = await pay.getPrizes(poolId);
    expect(prizes).toMatchObject({ status: 'open', guaranteedPrizePoolCents: 21250, minCashCents: 3800, paidPlaces: 2, capacity: 10, seatsLeft: 9 });
    expect(prizes.bands).toEqual([{ fromPlace: 1, toPlace: 1, prizeCents: 13350 }, { fromPlace: 2, toPlace: 2, prizeCents: 7900 }]);
    expect(await reason(pay.getPrizes(await draftPool(10000)))).toMatch(/POOL_NOT_FOUND/);
    expect(PaymentsError).toBeDefined();
  });
});
