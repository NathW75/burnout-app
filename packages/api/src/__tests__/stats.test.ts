/**
 * Picker stats (PRD-007 §6.3.2, §8.7): parsing MSF game logs, season and
 * last-3 averages, the worker job's per-week cache, and the pool response.
 */
import { describeDbRedis, SEASON } from '@burnout/test-support';
import { createJobs, dueJobs, MsfHttpError, type MsfFetcher } from '../jobs';
import { aggregate, block, clearStatsMemo, parseGameLines, readStats, STATS_MEMO_MS, statsKey, weekLinesKey, type GameLine } from '../players/stats';
import { account, buildWeek, createWorld, type World } from './harness';

/** One MSF game-log entry with the real field names. */
function log(playerId: string, position: string, week: number, gameId: string, start: string, stats: Record<string, Record<string, number>>) {
  return { game: { id: Number(gameId), week, startTime: start, awayTeamAbbreviation: 'KC', homeTeamAbbreviation: 'DEN' }, player: { id: Number(playerId), position }, team: { abbreviation: 'DEN' }, stats };
}
const feed = (gamelogs: unknown[]) => ({ lastUpdatedOn: '2026-10-27T12:00:00Z', gamelogs });
const rb = (att: number, yds: number, tds = 0, tgt = 0, rec = 0, recYds = 0) => ({
  rushing: { rushAttempts: att, rushYards: yds, rushTD: tds },
  receiving: { targets: tgt, receptions: rec, recYards: recYds, recTD: 0 },
});

describe('schedule', () => {
  it('stats run at :05 and :35', () => {
    expect(dueJobs(new Date('2026-10-28T14:05:00Z'), { windowsActive: false })).toContain('stats');
    expect(dueJobs(new Date('2026-10-28T14:35:00Z'), { windowsActive: true })).toContain('stats');
    expect(dueJobs(new Date('2026-10-28T14:06:00Z'), { windowsActive: true })).not.toContain('stats');
  });
});

describe('parsing and averages', () => {
  it('reads rush, receiving, passing and kicking lines; points come from the scoring rules; other positions are skipped', () => {
    const lines = parseGameLines(feed([
      log('10', 'RB', 7, '500', '2026-10-25T17:00:00Z', rb(20, 100, 1, 5, 4, 30)),
      log('11', 'QB', 7, '500', '2026-10-25T17:00:00Z', { passing: { passAttempts: 30, passCompletions: 20, passYards: 250, passTD: 2, passInt: 1 }, rushing: { rushAttempts: 3, rushYards: 12, rushTD: 0 } }),
      log('12', 'K', 7, '500', '2026-10-25T17:00:00Z', { fieldGoals: { fgMade: 2, fgAtt: 3, fgMade1_19: 0, fgMade20_29: 1, fgMade30_39: 0, fgMade40_49: 1, fgMade50Plus: 0 }, extraPointAttempts: { xpMade: 3, xpAtt: 3 } }),
      log('13', 'CB', 7, '500', '2026-10-25T17:00:00Z', { tackles: { tackleSolo: 5 } }),
    ]));
    expect(lines.map((l) => l.playerId)).toEqual(['10', '11', '12']);
    expect(lines[0]).toMatchObject({ week: 7, rush: { att: 20, yds: 100, tds: 1 }, rec: { tgt: 5, rec: 4, yds: 30, tds: 0 } });
    expect(lines[0].ptsX100).toBe(10 * 100 + 6 * 100 + 3 * 100 + 2 * 100); // 100 rush yds + TD + 30 rec yds + 4 × 0.5 PPR
    expect(lines[1].pass).toEqual({ att: 30, cmp: 20, yds: 250, tds: 2, int: 1 });
    expect(lines[2].k).toEqual({ fgm: 2, fga: 3, xpm: 3, xpa: 3 });
    expect(lines[2].ptsX100).toBe(300 + 400 + 300); // 20-29 + 40-49 + 3 XP (miss 0)
  });

  it('counts are totals and yards and points per game, with rates from totals; last 3 = the last three games played; zero denominators are null', () => {
    const g = (week: number, att: number, yds: number): GameLine => ({
      playerId: '10', gameId: `g${week}`, week, start: `2026-10-${String(week).padStart(2, '0')}T17:00:00Z`,
      rush: { att, yds, tds: 0 }, rec: { tgt: 0, rec: 0, yds: 0, tds: 0 }, pass: { att: 0, cmp: 0, yds: 0, tds: 0, int: 0 }, k: { fgm: 0, fga: 0, xpm: 0, xpa: 0 }, ptsX100: yds * 10,
    });
    const games = [g(1, 10, 40), g(2, 20, 100), g(4, 10, 30), g(5, 0, 0), g(6, 15, 75)];
    const out = aggregate(games, new Map(), new Map([['10', 'RB']]));
    expect(out['10'].season).toMatchObject({ gamesPlayed: 5, rush: { att: 55, yds: 49, ypc: 4.5 }, pts: 4.9, ptsTotal: 24.5 });
    expect(out['10'].season.rec).toEqual({ tgt: 0, rec: 0, yds: 0, ypr: null, tds: 0 });
    expect(out['10'].season.pass?.ypa).toBeNull();
    expect(out['10'].season.k).toBeNull();
    expect(out['10'].last3).toMatchObject({ gamesPlayed: 3, rush: { att: 25, yds: 35, ypc: 4.2 } }); // weeks 4, 5, 6
    expect(block([], false).gamesPlayed).toBe(0);
  });

  it('another MSF ID for the same person counts as him; one line per game', () => {
    const line = (playerId: string, gameId: string): GameLine => ({
      playerId, gameId, week: 1, start: '2026-09-10T17:00:00Z', rush: { att: 10, yds: 50, tds: 0 }, rec: { tgt: 0, rec: 0, yds: 0, tds: 0 },
      pass: { att: 0, cmp: 0, yds: 0, tds: 0, int: 0 }, k: { fgm: 0, fga: 0, xpm: 0, xpa: 0 }, ptsX100: 500,
    });
    // Game a lists him under both IDs; game b twice under the other one. Either way, one game each.
    const out = aggregate([line('10', 'a'), line('99', 'a'), line('99', 'b'), line('99', 'b')], new Map([['99', '10']]), new Map([['10', 'RB']]));
    expect(Object.keys(out)).toEqual(['10']);
    expect(out['10'].season.gamesPlayed).toBe(2);
    expect(out['10'].season.rush?.att).toBe(20); // 10 a game, two games
  });

  it('kickers get the kicking block only: kicks are totals, FG% from totals, points per game', () => {
    const k = (gameId: string, fgm: number, fga: number): GameLine => ({
      playerId: '12', gameId, week: 1, start: `2026-09-${gameId}T17:00:00Z`, rush: { att: 0, yds: 0, tds: 0 }, rec: { tgt: 0, rec: 0, yds: 0, tds: 0 },
      pass: { att: 0, cmp: 0, yds: 0, tds: 0, int: 0 }, k: { fgm, fga, xpm: 2, xpa: 2 }, ptsX100: fgm * 300 + 200,
    });
    const out = aggregate([k('10', 2, 3), k('17', 1, 1)], new Map(), new Map([['12', 'K']]));
    expect(out['12'].season).toMatchObject({ rush: null, rec: null, pass: null, k: { fgm: 3, fga: 4, fgPct: 75, xpm: 4, xpa: 4, pts: 6.5 } });
  });

  it('every count is a whole-number total over the period; only yards and points are per game (Nath, 2026-10-28)', () => {
    const g = (gameId: string, start: string, n: number): GameLine => ({
      playerId: '30', gameId, week: n, start,
      rush: { att: 3 * n, yds: 10 * n, tds: n }, rec: { tgt: 2 * n, rec: n, yds: 7 * n, tds: n },
      pass: { att: 5 * n, cmp: 3 * n, yds: 40 * n, tds: n, int: n }, k: { fgm: 0, fga: 0, xpm: 0, xpa: 0 }, ptsX100: 1000 * n,
    });
    // Two games: n = 1 and n = 2. Totals: n sums to 3. Per game: n averages to 1.5.
    const out = aggregate([g('a', '2026-10-01T17:00:00Z', 1), g('b', '2026-10-08T17:00:00Z', 2)], new Map(), new Map([['30', 'QB']]))['30'];
    expect(out.season).toEqual({
      gamesPlayed: 2, pts: 15, ptsTotal: 30,
      rush: { att: 9, yds: 15, ypc: 3.3, tds: 3 },
      rec: { tgt: 6, rec: 3, yds: 10.5, ypr: 7, tds: 3 },
      pass: { att: 15, cmp: 9, yds: 60, ypa: 8, tds: 3, int: 3 },
      k: null,
    });
    const kick = (gameId: string, fgm: number, fga: number, xpm: number, xpa: number): GameLine => ({
      playerId: '31', gameId, week: 1, start: `2026-10-0${gameId}T17:00:00Z`, rush: { att: 0, yds: 0, tds: 0 }, rec: { tgt: 0, rec: 0, yds: 0, tds: 0 },
      pass: { att: 0, cmp: 0, yds: 0, tds: 0, int: 0 }, k: { fgm, fga, xpm, xpa }, ptsX100: 500,
    });
    const k = aggregate([kick('1', 1, 2, 2, 3), kick('2', 2, 2, 1, 1), kick('3', 0, 1, 3, 3)], new Map(), new Map([['31', 'K']]))['31'];
    expect(k.last3.k).toEqual({ fgm: 3, fga: 5, fgPct: 60, xpm: 6, xpa: 7, pts: 5 });
  });

  it('a kicker with no field-goal tries has no FG% (null, shown as "—"), not 0%', () => {
    const k: GameLine = {
      playerId: '12', gameId: 'g', week: 1, start: '2026-09-10T17:00:00Z', rush: { att: 0, yds: 0, tds: 0 }, rec: { tgt: 0, rec: 0, yds: 0, tds: 0 },
      pass: { att: 0, cmp: 0, yds: 0, tds: 0, int: 0 }, k: { fgm: 0, fga: 0, xpm: 3, xpa: 3 }, ptsX100: 300,
    };
    expect(aggregate([k], new Map(), new Map([['12', 'K']]))['12'].season.k?.fgPct).toBeNull();
  });

  it('the API keeps a read blob for 60 seconds, then reads Redis again', async () => {
    clearStatsMemo();
    let value = JSON.stringify({ season: SEASON, asOf: 'x', weeks: [1], players: {} });
    let reads = 0;
    const redis = { get: async () => { reads += 1; return value; } } as unknown as Parameters<typeof readStats>[0];
    const first = await readStats(redis, 'memo:', SEASON, 1_000);
    value = JSON.stringify({ season: SEASON, asOf: 'y', weeks: [1, 2], players: {} });
    expect((await readStats(redis, 'memo:', SEASON, 1_000 + STATS_MEMO_MS - 1))?.asOf).toBe('x');
    expect(reads).toBe(1);
    expect(first?.asOf).toBe('x');
    expect((await readStats(redis, 'memo:', SEASON, 1_000 + STATS_MEMO_MS))?.asOf).toBe('y');
    expect(reads).toBe(2);
    clearStatsMemo();
  });
});

describeDbRedis('stats job and the pool (Postgres + Redis)', () => {
  let w: World;
  beforeEach(async () => {
    w = await createWorld();
    await buildWeek(w);
    clearStatsMemo();
    // Weeks 5–7 already played (week 8 is still to come at T0).
    for (const week of [5, 6, 7]) {
      const [win] = await w.t.sql<{ id: string }>(
        `INSERT INTO game_windows (week, season, label, scheduled_et, status, msf_game_ids) VALUES ($1, $2, 'early', $3, 'final', $4) RETURNING id::text AS id`,
        [week, SEASON, new Date(Date.UTC(2026, 9, 4 + (week - 5) * 7, 17)), [`h${week}`]]
      );
      await w.t.sql(
        `INSERT INTO nfl_games (msf_game_id, season, week, game_window_id, scheduled_start, home_team, away_team, played_status, schedule_status, is_final, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'DEN', 'KC', 'COMPLETED', 'NORMAL', true, now())`,
        [`h${week}`, SEASON, week, win.id, new Date(Date.UTC(2026, 9, 4 + (week - 5) * 7, 17))]
      );
    }
  });
  afterEach(async () => {
    await w.close();
  });

  /** A fake MSF: Ray Dent (rbDEN) rushes in weeks 5–7; week 6 can be made to refuse. */
  const fakeMsf = (opts: { refuse?: number[] } = {}) => {
    const calls: string[] = [];
    const msf: MsfFetcher = {
      async get(path) {
        calls.push(path);
        const week = Number(/week\/(\d+)\//.exec(path)?.[1]);
        if (opts.refuse?.includes(week)) throw new MsfHttpError(403, path);
        const yds = week * 10;
        return feed([
          { game: { id: `h${week}`, week, startTime: new Date(Date.UTC(2026, 9, 4 + (week - 5) * 7, 17)).toISOString() }, player: { id: 'rbDEN', position: 'RB' }, stats: rb(10, yds, week === 7 ? 1 : 0) },
          { game: { id: `h${week}`, week, startTime: new Date(Date.UTC(2026, 9, 4 + (week - 5) * 7, 17)).toISOString() }, player: { id: 'kDET', position: 'K' }, stats: { fieldGoals: { fgMade: 1, fgAtt: 2, fgMade20_29: 1 }, extraPointAttempts: { xpMade: 2, xpAtt: 2 } } },
        ]);
      },
    };
    return { msf, calls };
  };
  const jobsWith = (msf: MsfFetcher) => createJobs({ db: w.t.db, payments: w.payments, msf, season: SEASON, now: w.clock.get, log: () => {}, apiContext: w.ctx, msfRetryDelayMs: 0 });

  it('the job fetches every played week, caches frozen weeks, and the pool carries season and last-3 stats per player', async () => {
    const a = await account(w);
    let pool = await a.client.get(`/v1/seasons/${SEASON}/weeks/8/pool`);
    expect(pool.body.players.find((p: { playerId: string }) => p.playerId === 'rbDEN').stats).toBeNull(); // none yet: the pool still works

    await w.t.sql(`INSERT INTO week_freezes (season, week, last_final_at, frozen_at, scores_frozen) VALUES ($1, 5, now(), now(), 0)`, [SEASON]);
    const m = fakeMsf();
    expect(await jobsWith(m.msf).run('stats')).toMatchObject({ weeks: 3, fetched: [5, 6, 7], cached: [], failed: [], players: 2 });
    clearStatsMemo();
    pool = await a.client.get(`/v1/seasons/${SEASON}/weeks/8/pool`);
    const den = pool.body.players.find((p: { playerId: string }) => p.playerId === 'rbDEN').stats;
    expect(den.season).toMatchObject({ gamesPlayed: 3, rush: { att: 30, yds: 60, ypc: 6, tds: 1 }, rec: { tgt: 0, ypr: null }, pass: { ypa: null }, k: null });
    expect(den.season.ptsTotal).toBe(5 + 6 + 7 + 6);
    expect(den.last3.gamesPlayed).toBe(3);
    const k = pool.body.players.find((p: { playerId: string }) => p.playerId === 'kDET').stats;
    expect(k.season).toMatchObject({ rush: null, rec: null, pass: null, k: { fgm: 3, fga: 6, fgPct: 50, xpm: 6, xpa: 6, pts: 5 } });
    expect(pool.body.players.find((p: { playerId: string }) => p.playerId === 'qbKC').stats).toBeNull(); // no games logged

    // Next run: the frozen week comes from the cache; open weeks are refetched.
    const again = fakeMsf();
    expect(await jobsWith(again.msf).run('stats')).toMatchObject({ fetched: [6, 7], cached: [5] });
    expect(again.calls.some((c) => c.includes('/week/5/'))).toBe(false);
  });

  it('a refused week keeps its last copy; with no copy it is skipped, and the other weeks still count', async () => {
    expect(await jobsWith(fakeMsf({ refuse: [6] }).msf).run('stats')).toMatchObject({ fetched: [5, 7], failed: [6] });
    let blob = JSON.parse((await w.r.redis.get(statsKey(w.ctx.ns, SEASON)))!);
    expect(blob.players.rbDEN.season.gamesPlayed).toBe(2);
    expect(await jobsWith(fakeMsf().msf).run('stats')).toMatchObject({ fetched: [5, 6, 7], failed: [] });
    expect(await jobsWith(fakeMsf({ refuse: [6] }).msf).run('stats')).toMatchObject({ failed: [6] });
    blob = JSON.parse((await w.r.redis.get(statsKey(w.ctx.ns, SEASON)))!);
    expect(blob.players.rbDEN.season.gamesPlayed).toBe(3); // week 6 from its last copy
    expect(await w.r.redis.ttl(weekLinesKey(w.ctx.ns, SEASON, 7))).toBeGreaterThan(0);
  });
});
