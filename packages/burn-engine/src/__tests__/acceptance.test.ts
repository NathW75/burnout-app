/**
 * PRD-001 §11 acceptance criteria, verified end to end against real Postgres
 * with the shipped migrations. Each describe block maps to one criterion.
 */
import { evaluateAndFireLocks } from '../lock-engine';
import { evaluateAndCommitBurns } from '../burn-evaluator';
import { handleGameCancellation } from '../disruption-handler';
import { createPostgresBurnStore } from '../adapters/postgres-store';
import {
  addPoolEntry,
  count,
  createTestDb,
  createUser,
  createWindow,
  describeDb,
  silentLog,
  submitSeason,
  submitWeekly,
  TestClock,
  type TestDb,
} from './support/test-db';

const KICKOFF = new Date('2026-11-01T18:00:00.000Z'); // Sun Nov 1, 1:00 PM ET
const MIN = 60_000;

function engine(t: TestDb, clock: TestClock) {
  const store = createPostgresBurnStore(t.db);
  const base = { ...store, getServerTime: clock.get, log: silentLog };
  return {
    lock: () => evaluateAndFireLocks(base),
    final: (gameWindowId: string, finalMsfGameIds: string[]) =>
      evaluateAndCommitBurns({ gameWindowId, finalMsfGameIds }, base),
    cancel: (gameWindowId: string, adminUserId: string, ref = 'OPS-TICKET-1') =>
      handleGameCancellation(gameWindowId, adminUserId, ref, base),
  };
}

async function submission(t: TestDb, id: string) {
  const [row] = await t.sql<{ locked_at: Date | null; void_reason: string | null }>(
    `SELECT locked_at, void_reason FROM season_submissions WHERE id = $1`,
    [id]
  );
  return row;
}

async function poolEntry(t: TestDb, userId: string, playerId: string) {
  const [row] = await t.sql<{ burned: boolean; burned_at: Date | null }>(
    `SELECT burned, burned_at FROM pool_entries WHERE user_id = $1 AND player_id = $2`,
    [userId, playerId]
  );
  return row;
}

async function windowStatus(t: TestDb, id: string) {
  const [row] = await t.sql<{ status: string }>(`SELECT status FROM game_windows WHERE id = $1`, [id]);
  return row.status;
}

describeDb('PRD-001 §11 acceptance (Postgres)', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  // ── AC1 ───────────────────────────────────────────────────────────────────
  describe('AC1: lock fires at scheduled_et regardless of actual kickoff', () => {
    it('does not lock before scheduled_et, locks once it passes, and stays locked while the real kickoff is delayed', async () => {
      const clock = new TestClock(new Date(KICKOFF.getTime() - MIN)); // scheduled_et is 1 minute in the future
      const e = engine(t, clock);
      const u = await createUser(t);
      await addPoolEntry(t, u, 'p-rb');
      const w = await createWindow(t, { scheduledEt: KICKOFF, msfGameIds: ['g1'] });
      const s = await submitSeason(t, { userId: u, windowId: w, playerId: 'p-rb' });

      expect(await e.lock()).toEqual([]);
      expect((await submission(t, s)).locked_at).toBeNull();
      expect(await windowStatus(t, w)).toBe('pending');

      // Cron fires 20s after scheduled_et. locked_at is the cron-fire server time, not scheduled_et (§4.4).
      const fire = new Date(KICKOFF.getTime() + 20_000);
      clock.set(fire);
      const fired = await e.lock();
      expect(fired).toEqual([{ gameWindowId: w, firedAt: fire, submissionsLocked: 1, notificationsQueued: 1 }]);
      expect((await submission(t, s)).locked_at).toEqual(fire);
      expect(await windowStatus(t, w)).toBe('locked');
      expect(await count(t, 'lock_events', 'game_window_id = $1', [w])).toBe(1);

      // Mock MSF: the game actually kicks off late. The feed shows nothing Final.
      clock.advanceMs(4 * MIN);
      const notFinal = await e.final(w, []);
      expect(notFinal.outcome).toBe('awaiting_final');
      expect((await submission(t, s)).locked_at).toEqual(fire);
      expect(await count(t, 'burn_records')).toBe(0);

      // Re-running the cron is a no-op: no second lock event, locked_at unchanged.
      expect(await e.lock()).toEqual([]);
      expect((await submission(t, s)).locked_at).toEqual(fire);
      expect(await count(t, 'lock_events')).toBe(1);
    });

    it('locks at exactly scheduled_et', async () => {
      const clock = new TestClock(KICKOFF);
      const w = await createWindow(t, { scheduledEt: KICKOFF });
      expect(await engine(t, clock).lock()).toHaveLength(1);
      expect(await windowStatus(t, w)).toBe('locked');
    });

    it('§6.4: a window rescheduled later before its lock does not lock at the old time', async () => {
      const clock = new TestClock(new Date(KICKOFF.getTime() + MIN));
      const w = await createWindow(t, { scheduledEt: KICKOFF });
      await t.sql(`UPDATE game_windows SET scheduled_et = $2 WHERE id = $1`, [w, new Date(KICKOFF.getTime() + 60 * MIN)]);
      expect(await engine(t, clock).lock()).toEqual([]);
      expect(await windowStatus(t, w)).toBe('pending');
    });

    it('two cron workers firing at once produce exactly one lock', async () => {
      const clock = new TestClock(KICKOFF);
      const u = await createUser(t);
      const w = await createWindow(t, { scheduledEt: KICKOFF });
      await submitSeason(t, { userId: u, windowId: w, playerId: 'p1' });
      const [a, b] = await Promise.all([engine(t, clock).lock(), engine(t, clock).lock()]);
      expect(a.length + b.length).toBe(1);
      expect(await count(t, 'lock_events')).toBe(1);
      expect(await count(t, 'notification_queue', `kind = 'LOCK'`)).toBe(1);
    });
  });

  // ── AC2 ───────────────────────────────────────────────────────────────────
  describe('AC2: burn requires both lock AND final', () => {
    it('a locked player is not burned until Final posts, then is burned', async () => {
      const clock = new TestClock(KICKOFF);
      const e = engine(t, clock);
      const u = await createUser(t);
      await addPoolEntry(t, u, 'p-wr');
      const w = await createWindow(t, { scheduledEt: KICKOFF, msfGameIds: ['g1'] });
      const s = await submitSeason(t, { userId: u, windowId: w, playerId: 'p-wr', slotKey: 'wr1' });

      await e.lock();
      expect(await count(t, 'burn_records')).toBe(0);
      expect((await poolEntry(t, u, 'p-wr')).burned).toBe(false);

      const finalAt = new Date(KICKOFF.getTime() + 190 * MIN);
      clock.set(finalAt);
      const res = await e.final(w, ['g1']);
      expect(res).toMatchObject({ outcome: 'burned', burnsCreated: 1, usersAffected: [u] });

      const [burn] = await t.sql<{ submission_id: string; locked_at: Date; burned_at: Date; week: number }>(
        `SELECT submission_id, locked_at, burned_at, week FROM burn_records WHERE user_id = $1 AND player_id = 'p-wr'`,
        [u]
      );
      expect(burn.submission_id).toBe(s);
      expect(burn.locked_at).toEqual(KICKOFF);
      expect(burn.burned_at).toEqual(finalAt);
      expect(burn.week).toBe(8);
      expect(await poolEntry(t, u, 'p-wr')).toEqual({ burned: true, burned_at: finalAt });
      expect(await windowStatus(t, w)).toBe('final');
      expect(await count(t, 'notification_queue', `kind = 'BURN' AND user_id = $1`, [u])).toBe(1);
    });

    it('Final without a lock never burns', async () => {
      const clock = new TestClock(new Date(KICKOFF.getTime() - MIN));
      const u = await createUser(t);
      await addPoolEntry(t, u, 'p1');
      const w = await createWindow(t, { scheduledEt: KICKOFF, msfGameIds: ['g1'] });
      await submitSeason(t, { userId: u, windowId: w, playerId: 'p1' });
      const res = await engine(t, clock).final(w, ['g1']);
      expect(res.outcome).toBe('rejected');
      expect(await count(t, 'burn_records')).toBe(0);
      expect((await poolEntry(t, u, 'p1')).burned).toBe(false);
    });

    it('in a multi-game window, nobody burns until every game in the window is Final', async () => {
      const clock = new TestClock(KICKOFF);
      const e = engine(t, clock);
      const u = await createUser(t);
      const w = await createWindow(t, { scheduledEt: KICKOFF, msfGameIds: ['g1', 'g2', 'g3'] });
      await addPoolEntry(t, u, 'p1');
      await submitSeason(t, { userId: u, windowId: w, playerId: 'p1' });
      await e.lock();

      const partial = await e.final(w, ['g1', 'g3']);
      expect(partial).toMatchObject({ outcome: 'awaiting_final', pendingMsfGameIds: ['g2'] });
      expect(await count(t, 'burn_records')).toBe(0);

      expect((await e.final(w, ['g1', 'g2', 'g3'])).outcome).toBe('burned');
      expect(await count(t, 'burn_records')).toBe(1);
    });

    it('re-reported Final is idempotent, and concurrent Final handlers burn exactly once', async () => {
      const clock = new TestClock(KICKOFF);
      const u1 = await createUser(t);
      const u2 = await createUser(t);
      const w = await createWindow(t, { scheduledEt: KICKOFF, msfGameIds: ['g1'] });
      await submitSeason(t, { userId: u1, windowId: w, playerId: 'p1' });
      await submitSeason(t, { userId: u2, windowId: w, playerId: 'p1' });
      await engine(t, clock).lock();

      const [a, b] = await Promise.all([engine(t, clock).final(w, ['g1']), engine(t, clock).final(w, ['g1'])]);
      expect([a.outcome, b.outcome].sort()).toEqual(['already_final', 'burned']);
      expect(await count(t, 'burn_records')).toBe(2);
      expect((await engine(t, clock).final(w, ['g1'])).outcome).toBe('already_final');
      expect(await count(t, 'burn_records')).toBe(2);
    });

    it('burns a player even if no pool_entries row was seeded for him', async () => {
      const clock = new TestClock(KICKOFF);
      const u = await createUser(t);
      const w = await createWindow(t, { scheduledEt: KICKOFF, msfGameIds: ['g1'] });
      await submitSeason(t, { userId: u, windowId: w, playerId: 'p-unseeded' });
      await engine(t, clock).lock();
      await engine(t, clock).final(w, ['g1']);
      expect((await poolEntry(t, u, 'p-unseeded')).burned).toBe(true);
    });
  });

  // ── AC3 ───────────────────────────────────────────────────────────────────
  describe('AC3: empty slot does not burn', () => {
    it('a user with nothing submitted in a window gets no burns and an unchanged pool', async () => {
      const clock = new TestClock(KICKOFF);
      const e = engine(t, clock);
      const empty = await createUser(t, 'empty');
      const other = await createUser(t, 'other');
      await addPoolEntry(t, empty, 'p-qb');
      await addPoolEntry(t, empty, 'p-te');
      const w = await createWindow(t, { scheduledEt: KICKOFF, msfGameIds: ['g1'] });
      await submitSeason(t, { userId: other, windowId: w, playerId: 'p-qb', slotKey: 'qb' });

      const poolBefore = await t.sql(`SELECT * FROM pool_entries WHERE user_id = $1 ORDER BY player_id`, [empty]);
      await e.lock();
      await e.final(w, ['g1']);

      expect(await count(t, 'burn_records', 'user_id = $1', [empty])).toBe(0);
      expect(await t.sql(`SELECT * FROM pool_entries WHERE user_id = $1 ORDER BY player_id`, [empty])).toEqual(poolBefore);
      expect(await count(t, 'notification_queue', 'user_id = $1', [empty])).toBe(0);
    });
  });

  // ── AC4 ───────────────────────────────────────────────────────────────────
  describe('AC4: weekly contest does not burn', () => {
    it('a weekly_submissions entry through lock and Final creates no burn and leaves the pool unchanged', async () => {
      const clock = new TestClock(KICKOFF);
      const e = engine(t, clock);
      const u = await createUser(t);
      await addPoolEntry(t, u, 'p-weekly');
      await addPoolEntry(t, u, 'p-season');
      const w = await createWindow(t, { scheduledEt: KICKOFF, msfGameIds: ['g1'] });
      await submitWeekly(t, { userId: u, windowId: w, playerId: 'p-weekly' });
      await submitSeason(t, { userId: u, windowId: w, playerId: 'p-season' });

      await e.lock();
      await e.final(w, ['g1']);

      expect(await count(t, 'burn_records', `player_id = 'p-weekly'`)).toBe(0);
      expect((await poolEntry(t, u, 'p-weekly')).burned).toBe(false);
      // Control: the season-long pick in the same window did burn.
      expect(await count(t, 'burn_records', `player_id = 'p-season'`)).toBe(1);
    });

    it('is architectural: the database will not accept a burn sourced from a weekly submission', async () => {
      const clock = new TestClock(KICKOFF);
      const u = await createUser(t);
      await addPoolEntry(t, u, 'p1');
      const w = await createWindow(t, { scheduledEt: KICKOFF, status: 'final' });
      const weeklyId = await submitWeekly(t, { userId: u, windowId: w, playerId: 'p1' });
      await expect(
        t.sql(
          `INSERT INTO burn_records (user_id, player_id, season, week, game_window_id, submission_id, locked_at)
           VALUES ($1, 'p1', '2026-2027-regular', 8, $2, $3, $4)`,
          [u, w, weeklyId, clock.get()]
        )
      ).rejects.toThrow(/BURN_CRITERION|foreign key/);
    });
  });

  // ── AC5 ───────────────────────────────────────────────────────────────────
  describe('AC5: game cancellation un-burns and reopens the slot', () => {
    it('voids the lock, keeps the player available, writes SLOT_REOPENED, and blocks any later burn', async () => {
      const clock = new TestClock(KICKOFF);
      const e = engine(t, clock);
      const admin = await createUser(t, 'admin');
      const u = await createUser(t);
      await addPoolEntry(t, u, 'p-k');
      const w = await createWindow(t, { scheduledEt: KICKOFF, msfGameIds: ['g1'] });
      const s = await submitSeason(t, { userId: u, windowId: w, playerId: 'p-k', slotKey: 'k' });

      await e.lock();
      clock.advanceMs(30 * MIN);
      const res = await e.cancel(w, admin, 'NFL-OPS-2026-W8-001');
      expect(res).toMatchObject({ outcome: 'reopened', slotsReopened: 1 });
      expect(res.auditLogIds).toHaveLength(1);

      expect(await submission(t, s)).toEqual({ locked_at: null, void_reason: 'GAME_CANCELED' });
      expect((await poolEntry(t, u, 'p-k')).burned).toBe(false);
      expect(await windowStatus(t, w)).toBe('canceled');

      const [audit] = await t.sql<Record<string, unknown>>(`SELECT * FROM security_audit_log`);
      expect(audit).toMatchObject({
        id: res.auditLogIds[0],
        event_type: 'SLOT_REOPENED',
        game_id: w,
        user_id: u,
        slot_key: 'k',
        authorization_reference: 'NFL-OPS-2026-W8-001',
        performed_by: admin,
      });
      expect(await count(t, 'notification_queue', `kind = 'SLOT_REOPENED' AND user_id = $1`, [u])).toBe(1);

      // A Final arriving for the canceled window must not burn anyone.
      expect((await e.final(w, ['g1'])).outcome).toBe('rejected');
      expect(await count(t, 'burn_records')).toBe(0);
    });

    it('canceling before the lock fires means the window never locks', async () => {
      const clock = new TestClock(new Date(KICKOFF.getTime() - 60 * MIN));
      const e = engine(t, clock);
      const admin = await createUser(t, 'admin');
      const w = await createWindow(t, { scheduledEt: KICKOFF });
      const res = await e.cancel(w, admin);
      expect(res).toMatchObject({ outcome: 'reopened', slotsReopened: 0 });
      clock.set(new Date(KICKOFF.getTime() + MIN));
      expect(await e.lock()).toEqual([]);
      expect(await windowStatus(t, w)).toBe('canceled');
    });

    it('refuses to cancel a window that is already Final; burns stand', async () => {
      const clock = new TestClock(KICKOFF);
      const e = engine(t, clock);
      const admin = await createUser(t, 'admin');
      const u = await createUser(t);
      const w = await createWindow(t, { scheduledEt: KICKOFF, msfGameIds: ['g1'] });
      await submitSeason(t, { userId: u, windowId: w, playerId: 'p1' });
      await e.lock();
      await e.final(w, ['g1']);
      const res = await e.cancel(w, admin);
      expect(res.outcome).toBe('rejected');
      expect(await count(t, 'burn_records')).toBe(1);
      expect(await count(t, 'security_audit_log')).toBe(0);
    });

    it('requires an authorization reference', async () => {
      const clock = new TestClock(KICKOFF);
      const admin = await createUser(t, 'admin');
      const w = await createWindow(t, { scheduledEt: KICKOFF });
      const res = await engine(t, clock).cancel(w, admin, '  ');
      expect(res.outcome).toBe('rejected');
      expect(await windowStatus(t, w)).toBe('pending');
    });
  });

  // ── AC6 ───────────────────────────────────────────────────────────────────
  describe('AC6: burn_records is immutable', () => {
    async function oneBurn() {
      const clock = new TestClock(KICKOFF);
      const u = await createUser(t);
      const w = await createWindow(t, { scheduledEt: KICKOFF, msfGameIds: ['g1'] });
      await submitSeason(t, { userId: u, windowId: w, playerId: 'p1' });
      await engine(t, clock).lock();
      await engine(t, clock).final(w, ['g1']);
      const [b] = await t.sql<{ id: string }>(`SELECT id FROM burn_records`);
      return { burnId: b.id, userId: u, windowId: w };
    }

    it('rejects UPDATE, DELETE and TRUNCATE at the database', async () => {
      const { burnId } = await oneBurn();
      await expect(t.sql(`UPDATE burn_records SET week = 9 WHERE id = $1`, [burnId])).rejects.toThrow(/BURN_RECORD_IMMUTABLE/);
      await expect(t.sql(`DELETE FROM burn_records WHERE id = $1`, [burnId])).rejects.toThrow(/BURN_RECORD_IMMUTABLE/);
      await expect(t.sql(`TRUNCATE burn_records CASCADE`)).rejects.toThrow(/BURN_RECORD_IMMUTABLE/);
      expect(await count(t, 'burn_records')).toBe(1);
    });

    it('a modification is only possible with a matching SLOT_REOPENED audit entry', async () => {
      const { burnId, userId, windowId } = await oneBurn();
      const admin = await createUser(t, 'admin');

      // Wrong event type: still rejected.
      await expect(
        t.db.transaction(async (tx) => {
          const [a] = await tx.query<{ id: string }>(
            `INSERT INTO security_audit_log (event_type, performed_by, metadata) VALUES ('OTHER', $1, $2::jsonb) RETURNING id`,
            [admin, JSON.stringify({ burn_record_id: burnId })]
          );
          await tx.query(`SELECT set_config('burnout.slot_reopen_audit_id', $1, true)`, [a.id]);
          await tx.query(`DELETE FROM burn_records WHERE id = $1`, [burnId]);
        })
      ).rejects.toThrow(/BURN_RECORD_IMMUTABLE/);

      // Matching SLOT_REOPENED audit entry in the same transaction: allowed, and the audit trail exists.
      await t.db.transaction(async (tx) => {
        const [a] = await tx.query<{ id: string }>(
          `INSERT INTO security_audit_log (event_type, game_id, user_id, performed_by, authorization_reference, metadata)
           VALUES ('SLOT_REOPENED', $1, $2, $3, 'SYSADMIN-REVIEW-7', $4::jsonb) RETURNING id`,
          [windowId, userId, admin, JSON.stringify({ burn_record_id: burnId })]
        );
        await tx.query(`SELECT set_config('burnout.slot_reopen_audit_id', $1, true)`, [a.id]);
        await tx.query(`DELETE FROM burn_records WHERE id = $1`, [burnId]);
      });
      expect(await count(t, 'burn_records')).toBe(0);
      expect(await count(t, 'security_audit_log', `event_type = 'SLOT_REOPENED'`)).toBe(1);
    });

    it('the database refuses to create a burn that violates the two-part criterion', async () => {
      const clock = new TestClock(KICKOFF);
      const u = await createUser(t);
      await addPoolEntry(t, u, 'p1');
      const w = await createWindow(t, { scheduledEt: KICKOFF, msfGameIds: ['g1'] });
      const s = await submitSeason(t, { userId: u, windowId: w, playerId: 'p1' });
      const insert = () =>
        t.sql(
          `INSERT INTO burn_records (user_id, player_id, season, week, game_window_id, submission_id, locked_at)
           VALUES ($1, 'p1', '2026-2027-regular', 8, $2, $3, $4)`,
          [u, w, s, clock.get()]
        );
      await expect(insert()).rejects.toThrow(/condition a/); // not locked
      await engine(t, clock).lock();
      await expect(insert()).rejects.toThrow(/condition b/); // locked, not final
    });
  });

  // ── AC7 ───────────────────────────────────────────────────────────────────
  describe('AC7: lock notification is written in the lock transaction', () => {
    it('queues one LOCK notification per locked submission, committed with the lock', async () => {
      const clock = new TestClock(KICKOFF);
      const users = [await createUser(t), await createUser(t)];
      const w = await createWindow(t, { scheduledEt: KICKOFF, label: 'Sunday Early' });
      await submitSeason(t, { userId: users[0], windowId: w, playerId: 'p1', slotKey: 'rb1' });
      await submitSeason(t, { userId: users[0], windowId: w, playerId: 'p2', slotKey: 'wr1' });
      await submitSeason(t, { userId: users[1], windowId: w, playerId: 'p1', slotKey: 'flex' });
      const [res] = await engine(t, clock).lock();
      expect(res).toMatchObject({ submissionsLocked: 3, notificationsQueued: 3 });

      const rows = await t.sql<{ user_id: string; payload: Record<string, unknown>; dispatched_at: Date | null }>(
        `SELECT user_id, payload, dispatched_at FROM notification_queue WHERE kind = 'LOCK' ORDER BY payload->>'slotKey'`
      );
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.dispatched_at === null)).toBe(true);
      expect(rows[0].payload).toMatchObject({ playerId: 'p1', slotKey: 'flex', gameWindowId: w, windowLabel: 'Sunday Early' });
      const [ev] = await t.sql<{ notifications_queued: number }>(`SELECT notifications_queued FROM lock_events`);
      expect(ev.notifications_queued).toBe(3);
    });

    it('if the lock transaction fails, there are no orphaned notifications and nothing is locked', async () => {
      const clock = new TestClock(KICKOFF);
      const u = await createUser(t);
      const w = await createWindow(t, { scheduledEt: KICKOFF });
      const s = await submitSeason(t, { userId: u, windowId: w, playerId: 'p1' });

      // Force a failure on the last statement of the lock transaction (the lock_events insert).
      await t.sql(`CREATE FUNCTION fail_lock_event() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$ LANGUAGE plpgsql`);
      await t.sql(`CREATE TRIGGER fail_lock_event BEFORE INSERT ON lock_events FOR EACH ROW EXECUTE FUNCTION fail_lock_event()`);

      expect(await engine(t, clock).lock()).toEqual([]);
      expect(await count(t, 'notification_queue')).toBe(0);
      expect((await submission(t, s)).locked_at).toBeNull();
      expect(await windowStatus(t, w)).toBe('pending');

      // Once the fault clears, the next cron tick locks normally.
      await t.sql(`DROP TRIGGER fail_lock_event ON lock_events`);
      expect(await engine(t, clock).lock()).toHaveLength(1);
      expect(await count(t, 'notification_queue')).toBe(1);
    });
  });

  // ── AC8 ───────────────────────────────────────────────────────────────────
  describe('AC8: three-gate confirmation writes submission_receipts', () => {
    // Belongs to the API submission flow, not this package. Blocked on a schema
    // question: submission_receipts.submission_id is a single UUID but one
    // confirmed lineup writes nine season_submissions rows. See the open
    // questions in the build notes.
    it.todo('completing a submission writes a submission_receipts row with gate1_at, gate2_at and gate3_at');
  });
});
