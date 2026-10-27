/**
 * PRD-006 §11.6: season schedule import, over real Postgres (shipped
 * migrations, including the window schedule guard) + Redis.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPostgresBurnStore, evaluateAndFireLocks } from '@burnout/burn-engine';
import { createScoringStore, parseGames } from '@burnout/scoring-engine';
import { describeDbRedis, SEASON } from '@burnout/test-support';
import { createJobs, dueJobs, MsfHttpError, type MsfFetcher } from '../jobs';
import { importSchedule, windowLabel } from '../schedule/import';
import { account, createWorld, type World } from './harness';

const silent = () => {};
type G = [id: string, week: number, start: string, away: string, home: string, status?: string];
const feed = (games: G[]) => ({
  lastUpdatedOn: '2026-10-28T10:00:00.000Z',
  games: games.map(([id, week, startTime, away, home, scheduleStatus = 'NORMAL']) => ({
    schedule: { id: Number(id), week, startTime, awayTeam: { abbreviation: away }, homeTeam: { abbreviation: home }, scheduleStatus, playedStatus: 'UNPLAYED', originalStartTime: null },
  })),
});
const games = (gs: G[]) => parseGames(feed(gs)).games;

// Week 8, 2026 (DST ends Sun Nov 1 at 2 AM: Sunday and Monday are EST).
const THU = '2026-10-30T00:15:00.000Z'; //   Thu 8:15 PM EDT
const SUN1 = '2026-11-01T18:00:00.000Z'; //  Sun 1:00 PM EST
const SUN405 = '2026-11-01T21:05:00.000Z';
const SUN425 = '2026-11-01T21:25:00.000Z';
const SNF = '2026-11-02T01:20:00.000Z'; //   Sun 8:20 PM EST
const MNF = '2026-11-03T01:15:00.000Z'; //   Mon 8:15 PM EST
const WEEK8: G[] = [
  ['900', 8, THU, 'NYG', 'WAS'],
  ['901', 8, SUN1, 'KC', 'DEN'],
  ['902', 8, SUN1, 'NYJ', 'NE'],
  ['903', 8, SUN405, 'SEA', 'ARI'],
  ['904', 8, SUN425, 'BUF', 'MIA'],
  ['905', 8, SNF, 'DAL', 'PHI'],
  ['906', 8, MNF, 'GB', 'CHI'],
];
const moved = (gs: G[], id: string, patch: Partial<{ week: number; start: string; status: string }>): G[] =>
  gs.map((g) => (g[0] === id ? [g[0], patch.week ?? g[1], patch.start ?? g[2], g[3], g[4], patch.status ?? g[5]] : g));

describeDbRedis('PRD-006 §11.6 schedule import (Postgres + Redis)', () => {
  let w: World;
  beforeEach(async () => {
    w = await createWorld(); // clock: Wed 2026-10-28 12:00Z, Week 8
  });
  afterEach(async () => {
    await w.close();
  });

  const windows = (week = 8) =>
    w.t.sql<{ id: string; label: string; scheduled_et: Date; status: string; ids: string[] }>(
      `SELECT id::text AS id, label, scheduled_et, status, msf_game_ids AS ids FROM game_windows WHERE season = $1 AND week = $2 ORDER BY scheduled_et`,
      [SEASON, week]
    );
  const windowOf = async (gameId: string) =>
    (await w.t.sql<{ id: string | null }>(`SELECT game_window_id::text AS id FROM nfl_games WHERE msf_game_id = $1`, [gameId]))[0]?.id ?? null;
  const player = (id: string, team: string, pos = 'WR') =>
    w.t.sql(`INSERT INTO nfl_players (msf_player_id, first_name, last_name, position, team, roster_status, injury_status, updated_at)
             VALUES ($1, 'Test', $1, $2, $3, 'ROSTER', 'Active', now())`, [id, pos, team]);
  const pick = async (userId: string, playerId: string, windowId: string, slot = 'wr1') =>
    (await w.t.sql<{ id: string }>(
      `INSERT INTO season_submissions (user_id, week, season, slot_key, player_id, game_window_id) VALUES ($1, 8, $2, $3, $4, $5) RETURNING id::text AS id`,
      [userId, SEASON, slot, playerId, windowId]
    ))[0].id;

  it('groups the real Week 7 feed by exact kickoff: 4:05 and 4:25 are separate windows; re-import is a no-op', async () => {
    const fx = JSON.parse(readFileSync(join(__dirname, '../../../scoring-engine/src/__tests__/fixtures/msf-2026-w7-games.json'), 'utf8'));
    const r = await importSchedule(w.ctx, SEASON, parseGames(fx).games);
    expect(r).toMatchObject({ gamesInFeed: 14, windowsCreated: 7, windowsUpdated: 0, windowsRemoved: 0, review: [] });
    const ws = await windows(7);
    expect(ws.map((x) => [x.label, x.ids.length])).toEqual([
      ['Thursday Night · 8:15 PM', 1],
      ['Sunday Morning · 9:30 AM', 1],
      ['Sunday Early · 1:00 PM', 7],
      ['Sunday Late · 4:05 PM', 1],
      ['Sunday Late · 4:25 PM', 2],
      ['Sunday Night · 8:20 PM', 1],
      ['Monday Night · 8:15 PM', 1],
    ]);
    // Every window locks at exactly its games' scheduled kickoff (hard constraint 4).
    for (const x of ws) {
      const starts = await w.t.sql<{ s: Date }>(`SELECT DISTINCT scheduled_start AS s FROM nfl_games WHERE game_window_id = $1`, [x.id]);
      expect(starts.map((s) => new Date(s.s).getTime())).toEqual([new Date(x.scheduled_et).getTime()]);
    }
    const [{ n, teams }] = await w.t.sql<{ n: number; teams: number }>(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE home_team IS NOT NULL AND away_team IS NOT NULL)::int AS teams FROM nfl_games WHERE season = $1 AND week = 7`, [SEASON]);
    expect([n, teams]).toEqual([14, 14]);

    expect(await importSchedule(w.ctx, SEASON, parseGames(fx).games)).toMatchObject({ windowsCreated: 0, windowsUpdated: 0, windowsRemoved: 0, gamesUnscheduled: 0 });

    // Backfill: past windows arrive pending and the ordinary lock job claims them.
    const locked = await evaluateAndFireLocks({ ...createPostgresBurnStore(w.t.db), getServerTime: w.clock.get, log: silent });
    expect(locked).toHaveLength(7);
  });

  it('labels use Eastern Time across the DST change', async () => {
    await importSchedule(w.ctx, SEASON, games(WEEK8));
    expect((await windows()).map((x) => x.label)).toEqual([
      'Thursday Night · 8:15 PM', 'Sunday Early · 1:00 PM', 'Sunday Late · 4:05 PM', 'Sunday Late · 4:25 PM',
      'Sunday Night · 8:20 PM', 'Monday Night · 8:15 PM',
    ]);
    expect(windowLabel(new Date('2026-12-26T18:00:00Z'))).toBe('Saturday Afternoon · 1:00 PM');
  });

  it('flex: a game moving to another kickoff takes its pick along (with a notice); the emptied window is removed', async () => {
    await importSchedule(w.ctx, SEASON, games(WEEK8));
    const a = await account(w);
    await player('pBUF', 'BUF');
    const late425 = await windowOf('904');
    const sub = await pick(a.userId, 'pBUF', late425!);

    const r = await importSchedule(w.ctx, SEASON, games(moved(WEEK8, '904', { start: SNF })));
    expect(r).toMatchObject({ windowsCreated: 0, windowsRemoved: 1, review: [] });
    expect(r.reresolve).toMatchObject({ repointed: 1, voided: 0 });
    const snf = await windowOf('904');
    expect(snf).toBe(await windowOf('905')); // joined the existing SNF window
    expect((await windows()).find((x) => x.id === snf)!.ids).toEqual(['904', '905']);
    expect((await windows()).some((x) => x.id === late425)).toBe(false); // the 4:25 window is gone
    const [s] = await w.t.sql<{ game_window_id: string; void_reason: string | null }>(`SELECT game_window_id::text, void_reason FROM season_submissions WHERE id = $1`, [sub]);
    expect(s).toEqual({ game_window_id: snf, void_reason: null });
    const [{ n }] = await w.t.sql<{ n: number }>(`SELECT count(*)::int AS n FROM notification_queue WHERE user_id = $1 AND kind = 'SUBMISSION_REPOINTED'`, [a.userId]);
    expect(n).toBe(1);
  });

  it('a kickoff moved to a new time gets its own window; the window it left keeps its own kickoff', async () => {
    await importSchedule(w.ctx, SEASON, games(WEEK8));
    const early = await windowOf('901');
    const before = (await windows()).find((x) => x.id === early)!;
    const r = await importSchedule(w.ctx, SEASON, games(moved(WEEK8, '902', { start: '2026-11-01T18:30:00.000Z' })));
    expect(r).toMatchObject({ windowsCreated: 1, windowsUpdated: 1 });
    const after = (await windows()).find((x) => x.id === early)!;
    expect(after.ids).toEqual(['901']);
    expect(new Date(after.scheduled_et).getTime()).toBe(new Date(before.scheduled_et).getTime());
    const fresh = (await windows()).find((x) => x.ids.includes('902'))!;
    expect([fresh.label, new Date(fresh.scheduled_et).toISOString()]).toEqual(['Sunday Early · 1:30 PM', '2026-11-01T18:30:00.000Z']);
  });

  it('a postponed game leaves its window: the pick is voided and the window, now holding only a voided pick, is postponed', async () => {
    await importSchedule(w.ctx, SEASON, games(WEEK8));
    const a = await account(w);
    await player('pBUF', 'BUF');
    const late425 = (await windowOf('904'))!;
    const sub = await pick(a.userId, 'pBUF', late425);

    const r = await importSchedule(w.ctx, SEASON, games(moved(WEEK8, '904', { status: 'POSTPONED' })));
    expect(r).toMatchObject({ gamesUnscheduled: 1, windowsRemoved: 0, windowsPostponed: 1, review: [] });
    expect(r.reresolve).toMatchObject({ voided: 1 });
    expect(await windowOf('904')).toBeNull();
    const [s] = await w.t.sql<{ void_reason: string }>(`SELECT void_reason FROM season_submissions WHERE id = $1`, [sub]);
    expect(s.void_reason).toBe('PLAYER_NO_GAME');
    const [win] = await w.t.sql<{ status: string; ids: string[] }>(`SELECT status, msf_game_ids AS ids FROM game_windows WHERE id = $1`, [late425]);
    expect(win).toEqual({ status: 'postponed', ids: [] }); // never locks
  });

  it('frozen windows never change: a locked window, or a pending one whose kickoff has arrived; feed changes go to review', async () => {
    await importSchedule(w.ctx, SEASON, games(WEEK8));
    const thu = (await windowOf('900'))!;
    const snf = (await windowOf('905'))!;
    await w.t.sql(`UPDATE game_windows SET status = 'locked' WHERE id = $1`, [thu]);
    await w.t.sql(`UPDATE game_windows SET status = 'locked' WHERE id = $1`, [snf]);
    const before = await windows();

    let gs = moved(WEEK8, '900', { start: SUN1 });
    gs = moved(gs, '905', { status: 'POSTPONED' });
    const r = await importSchedule(w.ctx, SEASON, games(gs));
    expect(await windows()).toEqual(before);
    expect(await windowOf('900')).toBe(thu);
    expect(await windowOf('905')).toBe(snf);
    expect(r.review.map((x) => [x.reason, x.msfGameId]).sort()).toEqual([['LOCKED_GAME_MOVED', '900'], ['LOCKED_GAME_OFF_SCHEDULE', '905']]);

    // Pending, but the kickoff has arrived (the lock job hasn't claimed it yet): also frozen.
    w.clock.set(new Date('2026-11-01T18:00:30Z'));
    const early = (await windowOf('901'))!;
    const r2 = await importSchedule(w.ctx, SEASON, games(moved(WEEK8, '901', { start: SUN405 })));
    expect(await windowOf('901')).toBe(early);
    expect((await windows()).find((x) => x.id === early)!.ids).toEqual(['901', '902']);
    expect(r2.review.some((x) => x.reason === 'LOCKED_GAME_MOVED' && x.msfGameId === '901')).toBe(true);
  });

  it("a game moved onto a locked window's kickoff never joins it: it stays in its own window and is reported", async () => {
    await importSchedule(w.ctx, SEASON, games(WEEK8));
    const thu = (await windowOf('900'))!;
    const early = (await windowOf('902'))!;
    await w.t.sql(`UPDATE game_windows SET status = 'locked' WHERE id = $1`, [thu]);
    const r = await importSchedule(w.ctx, SEASON, games(moved(WEEK8, '902', { start: THU })));
    expect(r).toMatchObject({ windowsCreated: 0, windowsUpdated: 0 });
    expect(r.review).toEqual([{ reason: 'LOCKED_GAME_MOVED', msfGameId: '902', detail: { feedKickoff: THU, feedWeek: 8 } }]);
    expect((await windows()).find((x) => x.id === thu)!.ids).toEqual(['900']);
    expect(await windowOf('902')).toBe(early);
    expect((await windows()).find((x) => x.id === early)!.ids).toEqual(['901', '902']);
  });

  it('a game missing from the feed stays where it is and is reported; a DELAYED game keeps its window', async () => {
    await importSchedule(w.ctx, SEASON, games(WEEK8));
    const mnf = await windowOf('906');
    const early = await windowOf('901');
    const r = await importSchedule(w.ctx, SEASON, games(moved(WEEK8.filter((g) => g[0] !== '906'), '901', { start: '2026-11-01T18:40:00.000Z', status: 'DELAYED' })));
    expect(r).toMatchObject({ windowsCreated: 0, windowsRemoved: 0 });
    expect(r.review).toEqual([{ reason: 'GAME_MISSING_FROM_FEED', msfGameId: '906', windowId: mnf }]);
    expect(await windowOf('906')).toBe(mnf);
    expect(await windowOf('901')).toBe(early);
  });

  it('a game whose window an admin canceled is placed again in the week it moved to, and scoring follows the live window', async () => {
    await importSchedule(w.ctx, SEASON, games(WEEK8));
    const old = (await windowOf('904'))!;
    await w.t.sql(`UPDATE game_windows SET status = 'canceled' WHERE id = $1`, [old]);
    const r = await importSchedule(w.ctx, SEASON, games(moved(WEEK8, '904', { week: 9, start: '2026-11-08T18:00:00.000Z' })));
    expect(r.review).toEqual([]);
    const fresh = (await windowOf('904'))!;
    expect(fresh).not.toBe(old);
    expect((await windows(9)).map((x) => [x.id, x.ids])).toEqual([[fresh, ['904']]]);

    const scoring = createScoringStore(w.t.db);
    await scoring.ingest({ season: SEASON, games: games([['904', 9, '2026-11-08T18:00:00.000Z', 'BUF', 'MIA']]), gamelogs: { lastUpdatedOn: new Date(), lines: [] }, serverNow: w.clock.get() });
    expect(await windowOf('904')).toBe(fresh);
  });

  it('the database fixes a window once it leaves pending (kickoff, week, games, deletion); status changes still work', async () => {
    await importSchedule(w.ctx, SEASON, games(WEEK8));
    const thu = (await windowOf('900'))!;
    await w.t.sql(`UPDATE game_windows SET msf_game_ids = '{900,999}' WHERE id = $1`, [thu]); // pending: allowed
    await w.t.sql(`UPDATE game_windows SET status = 'locked' WHERE id = $1`, [thu]);
    const fails = async (sql: string) => expect(w.t.sql(sql, [thu])).rejects.toThrow(/WINDOW_SCHEDULE_FIXED/);
    await fails(`UPDATE game_windows SET scheduled_et = scheduled_et + interval '1 hour' WHERE id = $1`);
    await fails(`UPDATE game_windows SET msf_game_ids = '{900}' WHERE id = $1`);
    await fails(`UPDATE game_windows SET week = 9 WHERE id = $1`);
    await fails(`DELETE FROM game_windows WHERE id = $1`);
    await w.t.sql(`UPDATE game_windows SET status = 'final', final_posted_at = now() WHERE id = $1`, [thu]);
    const [{ status }] = await w.t.sql<{ status: string }>(`SELECT status FROM game_windows WHERE id = $1`, [thu]);
    expect(status).toBe('final');
  });

  it('job: falls back to the weekly feeds without the season feed (403), skips weeks it lacks (404), and never acts on an empty feed', async () => {
    const calls: string[] = [];
    let empty = false;
    const msf: MsfFetcher = {
      async get(path) {
        calls.push(path);
        if (path === `${SEASON}/games.json`) throw new MsfHttpError(403, path);
        const m = path.match(/week\/(\d+)\/games\.json/);
        if (!m || Number(m[1]) !== 8 || empty) throw new MsfHttpError(404, path);
        return feed(WEEK8);
      },
    };
    const jobs = createJobs({ db: w.t.db, payments: w.payments, msf, season: SEASON, now: w.clock.get, log: silent, apiContext: w.ctx });
    expect(await jobs.run('schedule')).toMatchObject({ source: 'weekly', windowsCreated: 6, review: 0 });
    expect(calls).toHaveLength(19);
    empty = true;
    expect(await jobs.run('schedule')).toEqual({ source: 'weekly', skipped: 'EMPTY_FEED' });
    expect(await windows()).toHaveLength(6);

    // Other failures surface (logged by the runner), they don't fall back.
    const broken = createJobs({ db: w.t.db, payments: w.payments, season: SEASON, now: w.clock.get, log: silent, apiContext: w.ctx,
      msf: { async get(p) { throw new MsfHttpError(500, p); } } });
    expect(await broken.run('schedule')).toBeNull();
  });

  it('schedule runs hourly at :30', () => {
    expect(dueJobs(new Date('2026-10-28T14:30:00Z'), { windowsActive: false })).toContain('schedule');
    expect(dueJobs(new Date('2026-10-28T14:31:00Z'), { windowsActive: false })).not.toContain('schedule');
  });
});
