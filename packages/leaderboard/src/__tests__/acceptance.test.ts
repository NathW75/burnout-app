/**
 * PRD-003 §11 acceptance criteria against real Postgres (shipped migrations)
 * and real Redis. AC9 drives the real burn-engine lock and scoring-engine
 * freeze with the leaderboard hooks wired in.
 */
import Redis from 'ioredis';
import { evaluateAndFireLocks, createPostgresBurnStore } from '@burnout/burn-engine';
import { createScoringStore } from '@burnout/scoring-engine';
import {
  count, createTestDb, createTestRedis, createUser, createWindow, describeDbRedis, SEASON, silentLog, submitSeason, TestClock,
  type TestDb, type TestRedis,
} from '@burnout/test-support';
import { computeBoard, leaderboardHooks } from '../board';
import { createLeaderboardService, EntryNotFoundError, LeaderboardAccessError, type LeaderboardView } from '../service';
import { HandleError } from '../handles';

const T0 = new Date('2026-10-28T12:00:00Z');
const DAY = 86_400_000;
const WEEK1_LOCK = new Date('2026-09-11T00:20:00Z');

describeDbRedis('PRD-003 §11 acceptance (Postgres + Redis)', () => {
  let t: TestDb;
  let r: TestRedis;
  let lb: ReturnType<typeof createLeaderboardService>;

  beforeEach(async () => {
    t = await createTestDb();
    r = await createTestRedis();
    lb = createLeaderboardService({ db: t.db, redis: r.redis, namespace: r.namespace });
  });
  afterEach(async () => {
    await r.close();
    await t.close();
  });

  // ── fixtures ──────────────────────────────────────────────────────────────
  async function pool(buyIn: number, closes = WEEK1_LOCK) {
    const [p] = await t.sql<{ id: string }>(
      `INSERT INTO contest_pools (season, kind, buy_in_cents, name, entry_closes_at)
       VALUES ($1, 'season_open', $2, $3, $4) RETURNING id::text AS id`,
      [SEASON, buyIn, `$${buyIn / 100} Open`, closes]
    );
    return p.id;
  }
  async function manager(handle: string) {
    const id = await createUser(t, handle);
    await lb.setHandle(id, handle, SEASON, new Date('2026-08-01T00:00:00Z'));
    return id;
  }
  async function enter(poolId: string, userId: string, at = new Date('2026-09-01T00:00:00Z')) {
    const [e] = await t.sql<{ id: string }>(
      `INSERT INTO contest_entries (pool_id, user_id, entered_at) VALUES ($1, $2, $3) RETURNING id::text AS id`,
      [poolId, userId, at]
    );
    return e.id;
  }
  async function score(userId: string, week: number, x100: number, status = 'final') {
    await t.sql(
      `INSERT INTO user_week_scores (user_id, season, week, points_x100, slots_scored, status, updated_at)
       VALUES ($1, $2, $3, $4, 9, $5, now())
       ON CONFLICT (user_id, season, week) DO UPDATE SET points_x100 = EXCLUDED.points_x100`,
      [userId, SEASON, week, x100, status]
    );
  }
  const board = async (viewer: string, poolId: string, limit = 100) =>
    (await lb.getBoard(viewer, poolId, { limit })) as LeaderboardView;
  const ranks = (b: LeaderboardView) => b.rows.map((row) => [row.handle, row.rank]);

  // ── Late entry (decision 2026-10-27) ─────────────────────────────────────
  it('late entry: weeks already under way at entry never count toward prize standings', async () => {
    await createWindow(t, { week: 1, scheduledEt: new Date('2026-09-11T00:20:00Z'), status: 'final' });
    await createWindow(t, { week: 2, scheduledEt: new Date('2026-09-18T00:15:00Z'), status: 'final' });
    await createWindow(t, { week: 3, scheduledEt: new Date('2026-09-25T00:15:00Z'), status: 'pending' });
    const p = await pool(2500, new Date('2026-10-01T17:00:00Z')); // late entry open through Week 4
    const early = await manager('early_bird');
    const late = await manager('late_comer');
    const midweek = await manager('mid_week');
    await enter(p, early, new Date('2026-09-01T00:00:00Z'));
    await enter(p, late, new Date('2026-09-16T12:00:00Z')); // Week 1 done, Week 2 not started
    await enter(p, midweek, new Date('2026-09-18T03:00:00Z')); // Week 2's first window already locked
    const from = await t.sql<{ user_id: string; scoring_from_week: number }>(`SELECT user_id::text, scoring_from_week FROM contest_entries`);
    const fromOf = (u: string) => from.find((r) => r.user_id === u)!.scoring_from_week;
    expect([fromOf(early), fromOf(late), fromOf(midweek)]).toEqual([1, 2, 3]);

    await score(early, 1, 10000); await score(early, 2, 5000);
    await score(late, 1, 90000); await score(late, 2, 6000); // a hot free Week 1 doesn't count
    await score(midweek, 1, 90000); await score(midweek, 2, 90000);
    const b = await computeBoard(t.db, p);
    expect(b.rows.map((r) => [r.handle, r.pointsX100, r.rank])).toEqual([['early_bird', 15000, 1], ['late_comer', 6000, 2], ['mid_week', 0, 3]]);
    await t.db.transaction((tx) => leaderboardHooks.afterFreeze(tx, { season: SEASON, week: 2, serverNow: T0 }));
    const snap = await t.sql<{ handle: string; points_x100: string }>(`SELECT handle, points_x100::text FROM leaderboard_snapshots WHERE pool_id = $1 ORDER BY rank`, [p]);
    expect(snap.map((s) => [s.handle, Number(s.points_x100)])).toEqual([['early_bird', 15000], ['late_comer', 6000], ['mid_week', 0]]);
  });

  // ── AC1 ───────────────────────────────────────────────────────────────────
  it('AC1: one lineup ranked in every pool entered; identical points, different fields', async () => {
    const p25 = await pool(2500);
    const p100 = await pool(10000);
    const both = await manager('both_tiers');
    const only25 = await manager('only25');
    const only100 = await manager('only100');
    await enter(p25, both); await enter(p100, both);
    await enter(p25, only25); await enter(p100, only100);
    await score(both, 7, 10000); await score(only25, 7, 9000); await score(only100, 7, 11000);
    await lb.rebuild(SEASON, T0);

    const b25 = await board(both, p25);
    const b100 = await board(both, p100);
    expect(ranks(b25)).toEqual([['both_tiers', 1], ['only25', 2]]);
    expect(ranks(b100)).toEqual([['only100', 1], ['both_tiers', 2]]);
    expect(b25.rows[0].pointsX100).toBe(b100.rows[1].pointsX100);
  });

  // ── AC2 + AC3 ─────────────────────────────────────────────────────────────
  it('AC2/AC3: competition ranking on exact centipoints; zero scorers ranked and tied at the bottom', async () => {
    const p = await pool(2500);
    const ids: Record<string, string> = {};
    for (const [h, pts] of [['alpha', 5000], ['bravo', 5000], ['charlie', 5000], ['delta', 4998], ['echo', 0], ['foxtrot', null]] as const) {
      ids[h] = await manager(h);
      await enter(p, ids[h]);
      if (pts !== null) await score(ids[h], 7, pts);
    }
    await lb.rebuild(SEASON, T0);
    expect(ranks(await board(ids.alpha, p))).toEqual([
      ['alpha', 1], ['bravo', 1], ['charlie', 1], ['delta', 4], ['echo', 5], ['foxtrot', 5],
    ]);
  });

  // ── AC4 ───────────────────────────────────────────────────────────────────
  it('AC4: after a rebuild the cached board equals the Postgres board, and the version tracks changes', async () => {
    const p = await pool(2500);
    const a = await manager('alpha'); const b = await manager('bravo');
    await enter(p, a); await enter(p, b);
    await score(a, 7, 3000); await score(b, 7, 4000);
    await lb.rebuild(SEASON, T0);
    const cached = await board(a, p);
    expect(cached.source).toBe('cache');
    const truth = await computeBoard(t.db, p);
    expect(cached.rows.map((x) => [x.entryId, x.rank, x.pointsX100])).toEqual(truth.rows.map((x) => [x.entryId, x.rank, x.pointsX100]));

    expect(await lb.getBoard(a, p, { ifVersion: cached.version })).toEqual({ notModified: true, version: cached.version });
    await score(a, 7, 5000);
    await lb.rebuild(SEASON, new Date(T0.getTime() + 60_000));
    const after = await board(a, p);
    expect(after.version).not.toBe(cached.version);
    expect(ranks(after)).toEqual([['alpha', 1], ['bravo', 2]]);
  });

  // ── AC5 ───────────────────────────────────────────────────────────────────
  it('AC5: with the cache empty or Redis down, the same standings come from Postgres', async () => {
    const p = await pool(2500);
    const a = await manager('alpha'); const b = await manager('bravo');
    await enter(p, a); await enter(p, b);
    await score(a, 7, 3000); await score(b, 7, 4000);
    const expected = [['bravo', 1], ['alpha', 2]];

    const empty = await board(a, p); // never rebuilt: cache miss
    expect(empty.source).toBe('postgres');
    expect(ranks(empty)).toEqual(expected);

    const dead = new Redis('redis://127.0.0.1:1', { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
    const noRedis = createLeaderboardService({ db: t.db, redis: dead, namespace: r.namespace });
    const viaFallback = (await noRedis.getBoard(a, p)) as LeaderboardView;
    expect(viaFallback.source).toBe('postgres');
    expect(ranks(viaFallback)).toEqual(expected);
    dead.disconnect();
  });

  // ── AC6 ───────────────────────────────────────────────────────────────────
  it('AC6: readers during rebuilds always see one whole board, never a mix', async () => {
    const p = await pool(2500);
    const users: string[] = [];
    for (let i = 0; i < 30; i++) {
      users.push(await manager(`mgr_${String(i).padStart(2, '0')}`));
      await enter(p, users[i]);
    }
    // State X: user i scores i*100. State Y: user i scores (30-i)*100 (order reversed).
    const setState = async (y: boolean) => {
      for (let i = 0; i < 30; i++) await score(users[i], 7, (y ? 30 - i : i) * 100);
    };
    await setState(false);
    await lb.rebuild(SEASON, T0);
    const boards = new Map<string, string>();
    const record = async () => {
      const b = await board(users[0], p, 30);
      const sig = JSON.stringify(b.rows.map((x) => [x.handle, x.rank, x.pointsX100]));
      const seen = boards.get(b.version);
      if (seen) expect(sig).toBe(seen); // same version ⇒ identical content
      else boards.set(b.version, sig);
      expect(b.rows).toHaveLength(30);
      expect(b.rows.every((x, i) => i === 0 || x.pointsX100 <= b.rows[i - 1].pointsX100)).toBe(true);
    };
    let stop = false;
    const readers = Promise.all(Array.from({ length: 4 }, async () => { while (!stop) await record(); }));
    for (let k = 0; k < 10; k++) {
      await setState(k % 2 === 0);
      await lb.rebuild(SEASON, new Date(T0.getTime() + k * 1000));
    }
    stop = true;
    await readers;
    expect(boards.size).toBe(2); // exactly the two real boards were ever observed
  });

  // ── AC7 ───────────────────────────────────────────────────────────────────
  it('AC7: reveal shows locked slots only; unlocked slots are HIDDEN with nothing else; outsiders are refused', async () => {
    const p = await pool(2500);
    const viewer = await manager('viewer'); const target = await manager('target'); const outsider = await manager('outsider');
    await enter(p, viewer);
    const targetEntry = await enter(p, target);
    const early = await createWindow(t, { week: 7, label: 'Sunday Early', scheduledEt: new Date('2026-10-25T17:00:00Z'), status: 'locked' });
    const snf = await createWindow(t, { week: 7, label: 'Sunday Night', scheduledEt: new Date('2026-10-26T00:20:00Z'), status: 'pending' });
    const s1 = await submitSeason(t, { userId: target, windowId: early, playerId: 'p-qb', slotKey: 'qb', week: 7 });
    await t.sql(`UPDATE season_submissions SET locked_at = $2 WHERE id = $1`, [s1, new Date('2026-10-25T17:00:00Z')]);
    await submitSeason(t, { userId: target, windowId: snf, playerId: 'p-secret', slotKey: 'rb1', week: 7 });
    await t.sql(
      `INSERT INTO season_submissions (user_id, week, season, slot_key, player_id, game_window_id, void_reason)
       VALUES ($1, 7, $2, 'k', 'p-kicker', $3, 'GAME_CANCELED')`, [target, SEASON, early]);

    const seen = await lb.getLineup(viewer, p, targetEntry, 7);
    const bySlot = Object.fromEntries(seen.map((s) => [s.slotKey, s]));
    expect(bySlot.qb).toMatchObject({ state: 'LOCKED', player: { playerId: 'p-qb' } });
    expect(bySlot.rb1).toEqual({ slotKey: 'rb1', state: 'HIDDEN' });
    expect(bySlot.wr1).toEqual({ slotKey: 'wr1', state: 'HIDDEN' }); // empty, but the week isn't over: indistinguishable
    expect(bySlot.k).toEqual({ slotKey: 'k', state: 'REOPENED' });
    expect(JSON.stringify(seen)).not.toContain('p-secret');

    const own = await lb.getLineup(target, p, targetEntry, 7);
    expect(own.find((s) => s.slotKey === 'rb1')).toMatchObject({ state: 'SUBMITTED', player: { playerId: 'p-secret' } });
    expect(own.find((s) => s.slotKey === 'wr1')).toEqual({ slotKey: 'wr1', state: 'EMPTY' });

    await expect(lb.getLineup(outsider, p, targetEntry, 7)).rejects.toBeInstanceOf(LeaderboardAccessError);
    const otherPool = await pool(10000);
    const elsewhere = await enter(otherPool, outsider);
    await expect(lb.getLineup(viewer, p, elsewhere, 7)).rejects.toBeInstanceOf(EntryNotFoundError);

    // Once every window has locked, an empty slot is no longer a secret.
    await t.sql(`UPDATE game_windows SET status = 'locked' WHERE id = $1`, [snf]);
    await t.sql(`UPDATE season_submissions SET locked_at = $1 WHERE player_id = 'p-secret'`, [new Date('2026-10-26T00:20:00Z')]);
    const later = Object.fromEntries((await lb.getLineup(viewer, p, targetEntry, 7)).map((s) => [s.slotKey, s]));
    expect(later.rb1).toMatchObject({ state: 'LOCKED', player: { playerId: 'p-secret' } });
    expect(later.wr1).toEqual({ slotKey: 'wr1', state: 'EMPTY' });
  });

  // ── AC8 ───────────────────────────────────────────────────────────────────
  it('AC8: no response contains an email, legal name or user ID', async () => {
    const p = await pool(2500);
    const a = await manager('alpha'); const b = await manager('bravo');
    const aEntry = await enter(p, a); await enter(p, b);
    await score(a, 7, 3000);
    const [u] = await t.sql<{ email: string; display_name: string }>(`SELECT email, display_name FROM users WHERE id = $1`, [b]);
    await t.sql(`UPDATE users SET display_name = 'Robert Realname' WHERE id = $1`, [b]);
    await lb.rebuild(SEASON, T0);
    const out = JSON.stringify([
      await lb.getBoard(a, p), await lb.getMe(a, p), await lb.getWeek(a, p, 7), await lb.getLineup(a, p, aEntry, 7),
    ]);
    for (const secret of [u.email, 'Robert Realname', a, b]) expect(out).not.toContain(secret);
  });

  // ── AC9 ───────────────────────────────────────────────────────────────────
  it('AC9: week_start snapshots commit inside the first lock; official snapshots inside the freeze', async () => {
    const p25 = await pool(2500); const p100 = await pool(10000);
    const a = await manager('alpha'); const b = await manager('bravo');
    await enter(p25, a); await enter(p25, b); await enter(p100, a);
    await score(a, 7, 9000); await score(b, 7, 9500);

    const clock = new TestClock(new Date('2026-10-29T00:15:00Z'));
    const tnf = await createWindow(t, { week: 8, label: 'Thursday Night', scheduledEt: clock.get(), msfGameIds: ['g8-1'] });
    await createWindow(t, { week: 8, label: 'Sunday Early', scheduledEt: new Date('2026-11-01T18:00:00Z'), msfGameIds: ['g8-2'] });
    const burn = createPostgresBurnStore(t.db, { afterLock: leaderboardHooks.afterLock });
    await evaluateAndFireLocks({ ...burn, getServerTime: clock.get, log: silentLog });

    const starts = await t.sql<{ pool_id: string; handle: string; rank: number }>(
      `SELECT pool_id::text AS pool_id, handle, rank FROM leaderboard_snapshots WHERE week = 8 AND kind = 'week_start' ORDER BY pool_id, rank`
    );
    expect(starts).toHaveLength(3); // every entry in every pool of the season
    expect(starts.filter((s) => s.pool_id === p25).map((s) => [s.handle, s.rank])).toEqual([['bravo', 1], ['alpha', 2]]);

    // A later lock in the same week writes nothing new.
    clock.set(new Date('2026-11-01T18:00:00Z'));
    await evaluateAndFireLocks({ ...burn, getServerTime: clock.get, log: silentLog });
    expect(await count(t, 'leaderboard_snapshots', `week = 8 AND kind = 'week_start'`)).toBe(3);

    // A failing snapshot never blocks a lock: the lock commits, the snapshot's writes roll back
    // alone, the error is reported, and the next lock that week writes the baseline.
    const w9 = await createWindow(t, { week: 9, label: 'Thursday Night', scheduledEt: new Date('2026-11-06T01:15:00Z') });
    const w9b = await createWindow(t, { week: 9, label: 'Sunday Early', scheduledEt: new Date('2026-11-08T18:00:00Z') });
    const hookErrors: unknown[] = [];
    const failing = createPostgresBurnStore(t.db, {
      afterLock: async (tx, ctx) => {
        await leaderboardHooks.afterLock(tx, ctx); // writes rows…
        throw new Error('snapshot failed'); // …then fails: those rows must not survive
      },
      onAfterLockError: (err) => hookErrors.push(err),
    });
    clock.set(new Date('2026-11-06T01:15:00Z'));
    expect(await evaluateAndFireLocks({ ...failing, getServerTime: clock.get, log: silentLog })).toHaveLength(1);
    const [st] = await t.sql<{ status: string }>(`SELECT status FROM game_windows WHERE id = $1`, [w9]);
    expect(st.status).toBe('locked');
    expect(hookErrors).toHaveLength(1);
    expect(await count(t, 'leaderboard_snapshots', `week = 9`)).toBe(0);
    clock.set(new Date('2026-11-08T18:00:00Z'));
    await evaluateAndFireLocks({ ...burn, getServerTime: clock.get, log: silentLog });
    expect(await count(t, 'leaderboard_snapshots', `week = 9 AND kind = 'week_start'`)).toBe(3);
    void w9b;

    // Official snapshot inside the scoring freeze; it records the handle shown at the time.
    await t.sql(
      `INSERT INTO nfl_games (msf_game_id, season, week, game_window_id, scheduled_start, played_status, schedule_status, is_final, final_observed_at, updated_at)
       VALUES ('g7-only', $1, 7, NULL, $2, 'COMPLETED', 'NORMAL', true, $3, $3)`,
      [SEASON, new Date('2026-10-25T17:00:00Z'), new Date('2026-10-27T03:40:00Z')]
    );
    const scoring = createScoringStore(t.db, { afterFreeze: leaderboardHooks.afterFreeze });
    expect(await scoring.freezeDueWeeks(SEASON, new Date('2026-10-29T03:40:00Z'))).toHaveLength(1);
    expect(await count(t, 'leaderboard_snapshots', `week = 7 AND kind = 'official'`)).toBe(3);
    await lb.setHandle(b, 'bravo_renamed', SEASON, new Date('2026-10-30T00:00:00Z'));
    const [off] = await t.sql<{ handle: string }>(`SELECT handle FROM leaderboard_snapshots WHERE week = 7 AND kind = 'official' AND user_id = $1`, [b]);
    expect(off.handle).toBe('bravo');
    void tnf;
  });

  // ── AC10 ──────────────────────────────────────────────────────────────────
  it('AC10: status is LIVE, then PROVISIONAL, then OFFICIAL', async () => {
    const p = await pool(2500);
    const a = await manager('alpha');
    await enter(p, a);
    const w = await createWindow(t, { week: 7, label: 'Sunday Early', scheduledEt: new Date('2026-10-25T17:00:00Z'), status: 'locked' });
    const late = await createWindow(t, { week: 7, label: 'Monday Night', scheduledEt: new Date('2026-10-27T00:15:00Z'), status: 'pending' });
    expect((await board(a, p)).status).toBe('LIVE');
    expect((await board(a, p)).movementLabel).toBe('Projected');
    await t.sql(`UPDATE game_windows SET status = 'final' WHERE id = ANY($1::uuid[])`, [[w, late]]);
    expect((await board(a, p)).status).toBe('PROVISIONAL');
    await t.sql(`INSERT INTO week_freezes (season, week, last_final_at, frozen_at, scores_frozen) VALUES ($1, 7, now(), now(), 0)`, [SEASON]);
    const off = await board(a, p);
    expect(off.status).toBe('OFFICIAL');
    expect(off.movementLabel).toBe('Final');
  });

  // ── AC11 ──────────────────────────────────────────────────────────────────
  it('AC11: entries at or after the Week 1 lock are rejected by the database', async () => {
    const p = await pool(2500);
    const early = await createUser(t); const late = await createUser(t);
    await enter(p, early, new Date(WEEK1_LOCK.getTime() - 1000));
    await expect(enter(p, late, WEEK1_LOCK)).rejects.toThrow(/ENTRY_CLOSED/);
    await expect(t.sql(`DELETE FROM contest_entries`)).rejects.toThrow(/APPEND_ONLY/);
  });

  // ── AC12 ──────────────────────────────────────────────────────────────────
  it('AC12: projected movement against the week-start baseline, with arrows', async () => {
    const p = await pool(2500);
    const a = await manager('alpha'); const b = await manager('bravo'); const c = await manager('charlie');
    await enter(p, a); await enter(p, b); await enter(p, c);
    await score(a, 7, 9000); await score(b, 7, 8000); await score(c, 7, 7000);
    await createWindow(t, { week: 8, label: 'Thursday Night', scheduledEt: new Date('2026-10-29T00:15:00Z'), status: 'locked' });
    await t.db.transaction((tx) => leaderboardHooks.afterLock(tx, { season: SEASON, week: 8, serverNow: new Date('2026-10-29T00:15:00Z') }));
    const late = await manager('late_joiner'); // no baseline
    await t.sql(`ALTER TABLE contest_entries DISABLE TRIGGER contest_entries_window`);
    await enter(p, late, new Date('2026-10-29T01:00:00Z'));
    await t.sql(`ALTER TABLE contest_entries ENABLE TRIGGER contest_entries_window`);

    // Week 8 so far: charlie surges past both, bravo passes alpha.
    await score(c, 8, 2500); await score(b, 8, 1200); await score(a, 8, 0);
    await lb.rebuild(SEASON, T0);
    const rows = Object.fromEntries((await board(a, p)).rows.map((x) => [x.handle, x]));
    expect(rows.charlie).toMatchObject({ rank: 1, baselineRank: 3, movement: 2, arrow: 'up' });
    expect(rows.bravo).toMatchObject({ rank: 2, baselineRank: 2, movement: 0, arrow: 'flat' });
    expect(rows.alpha).toMatchObject({ rank: 3, baselineRank: 1, movement: -2, arrow: 'down' });
    expect(rows.late_joiner).toMatchObject({ baselineRank: null, movement: null, arrow: null });

    const me = await lb.getMe(a, p);
    expect(me).toMatchObject({ rank: 3, movement: -2, arrow: 'down', movementLabel: 'Projected', behindAboveX100: 9200 - 9000 });
  });

  // ── AC13 ──────────────────────────────────────────────────────────────────
  it('AC13: two handle changes per season; released handles held 30 days; history is the only path', async () => {
    const u = await createUser(t);
    const other = await createUser(t);
    const d = (n: number) => new Date(Date.UTC(2026, 8, 1) + n * DAY);
    await lb.setHandle(u, 'first_name', SEASON, d(0)); // signup: not a change
    await lb.setHandle(u, 'second_name', SEASON, d(1)); // change 1
    await lb.setHandle(u, 'third_name', SEASON, d(2)); // change 2
    await expect(lb.setHandle(u, 'fourth_name', SEASON, d(3))).rejects.toMatchObject({ code: 'HANDLE_CHANGE_LIMIT' });
    await lb.setHandle(u, 'new_season', '2027-2028-regular', d(400)); // limit resets next season

    await expect(lb.setHandle(other, 'second_name', SEASON, d(20))).rejects.toMatchObject({ code: 'HANDLE_TAKEN' });
    await lb.setHandle(other, 'second_name', SEASON, d(32)); // released d(2), 30 days passed
    await expect(lb.setHandle(other, 'NEW_SEASON', SEASON, d(401))).rejects.toMatchObject({ code: 'HANDLE_TAKEN' }); // case-insensitive

    await expect(t.sql(`UPDATE users SET handle = 'sneaky' WHERE id = $1`, [u])).rejects.toThrow(/HANDLE_UNAUDITED/);
    await expect(t.sql(`DELETE FROM user_handle_history`)).rejects.toThrow(/APPEND_ONLY/);
    expect(() => require('../handles').validateHandle('ab')).toThrow(HandleError);
    expect(() => require('../handles').validateHandle('TheOfficialOne')).toThrow(HandleError);
  });

  // ── AC14 ──────────────────────────────────────────────────────────────────
  it('AC14: users without an entry in the pool are refused everywhere', async () => {
    const p = await pool(2500);
    const member = await manager('member'); const stranger = await manager('stranger');
    const entry = await enter(p, member);
    for (const call of [
      () => lb.getBoard(stranger, p), () => lb.getMe(stranger, p), () => lb.getWeek(stranger, p, 7), () => lb.getLineup(stranger, p, entry, 7),
    ]) await expect(call()).rejects.toBeInstanceOf(LeaderboardAccessError);
  });
});
