/**
 * PRD-002 §11 acceptance criteria against real Postgres (shipped migrations)
 * and real MySportsFeeds 2026-27 Week 7 data.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  count,
  createTestDb,
  createUser,
  createWindow,
  describeDb,
  SEASON,
  submitWeekly,
  type TestDb,
} from '@burnout/test-support';
import { MSF_FINAL_STATUSES, parseGamelogs, parseGames, type GameStatus, type ParsedGamelogs } from '../msf';
import { createScoringStore, RulesVersionMismatchError } from '../store';
import { YAHOO_HALF_PPR_V1 } from '../rules';

const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));
const HOUR = 3600_000;

// Real player IDs from the Week 7 feed and their hand-computed Yahoo half-PPR scores.
const P = {
  smith: { id: '19276', x100: 2448 }, // QB NYJ, game 163648 (Sun Early)
  taylor: { id: '166711', x100: 2270 }, // TE NYJ, game 163648
  stroud: { id: '79740', x100: 1652 }, // QB HOU, game 163646 (Sun Early)
  beck: { id: '16099', x100: -10 }, // FB NYJ, game 163648
  butker: { id: '12796', x100: 500 }, // K KC, game 163653 (SNF)
  adkins: { id: '112073', x100: 0 }, // TE DEN, game 163650 (Sun Late 4:05)
};

function feeds(statusOverrides: Record<string, string> = {}) {
  const games: GameStatus[] = parseGames(fixture('msf-2026-w7-games.json')).games.map((g) =>
    statusOverrides[g.msfGameId]
      ? { ...g, playedStatus: statusOverrides[g.msfGameId], isFinal: MSF_FINAL_STATUSES.has(statusOverrides[g.msfGameId]) }
      : g
  );
  const gamelogs: ParsedGamelogs = parseGamelogs(fixture('msf-2026-w7-gamelogs.sample.json'));
  return { games, gamelogs };
}

/** Change one player's stats in a parsed feed (a stat correction from MSF). */
function withStats(g: ParsedGamelogs, playerId: string, change: Partial<ParsedGamelogs['lines'][number]['stats']>): ParsedGamelogs {
  return { ...g, lines: g.lines.map((l) => (l.playerId === playerId ? { ...l, stats: { ...l.stats, ...change } } : l)) };
}

async function week7(t: TestDb) {
  const w = async (label: string, iso: string, ids: string[], status = 'locked') =>
    createWindow(t, { week: 7, label, scheduledEt: new Date(iso), msfGameIds: ids, status });
  return {
    tnf: await w('Thursday Night', '2026-10-23T00:15:00Z', ['163641']),
    intl: await w('Sunday International', '2026-10-25T13:30:00Z', ['163642']),
    early: await w('Sunday Early', '2026-10-25T17:00:00Z', ['163643', '163644', '163645', '163646', '163647', '163648', '163649']),
    late405: await w('Sunday Late 4:05', '2026-10-25T20:05:00Z', ['163650']),
    late425: await w('Sunday Late 4:25', '2026-10-25T20:25:00Z', ['163651', '163652']),
    snf: await w('Sunday Night', '2026-10-26T00:20:00Z', ['163653']),
    mnf: await w('Monday Night', '2026-10-27T00:15:00Z', ['163654'], 'pending'),
  };
}

async function lockSlot(t: TestDb, o: { userId: string; windowId: string; playerId: string; slotKey: string; voided?: boolean }) {
  await t.sql(
    `INSERT INTO season_submissions (user_id, week, season, slot_key, player_id, game_window_id, locked_at, void_reason)
     VALUES ($1, 7, $2, $3, $4, $5, $6, $7)`,
    [o.userId, SEASON, o.slotKey, o.playerId, o.windowId, o.voided ? null : new Date('2026-10-25T17:00:00Z'), o.voided ? 'GAME_CANCELED' : null]
  );
}

async function weekScore(t: TestDb, userId: string) {
  const [r] = await t.sql<{ points_x100: number; slots_scored: number; status: string }>(
    `SELECT points_x100, slots_scored, status FROM user_week_scores WHERE user_id = $1 AND season = $2 AND week = 7`,
    [userId, SEASON]
  );
  return r;
}

async function playerScore(t: TestDb, playerId: string) {
  const [r] = await t.sql<{ points_x100: number; status: string }>(
    `SELECT points_x100, status FROM player_game_scores WHERE player_id = $1 AND season = $2`,
    [playerId, SEASON]
  );
  return r;
}

const ALL_FINAL_EXCEPT_MNF = {}; // fixture as delivered: 13 COMPLETED, MNF UNPLAYED
const MNF_FINAL = { '163654': 'COMPLETED' };

describeDb('PRD-002 §11 acceptance (Postgres, real Week 7 data)', () => {
  let t: TestDb;
  let store: ReturnType<typeof createScoringStore>;
  beforeEach(async () => {
    t = await createTestDb();
    store = createScoringStore(t.db);
  });
  afterEach(async () => {
    await t.close();
  });

  // ── AC1 ───────────────────────────────────────────────────────────────────
  it('AC1: stored scores equal the hand-computed Yahoo half-PPR values', async () => {
    await week7(t);
    const [res] = await store.ingest({ season: SEASON, ...feeds(), serverNow: new Date('2026-10-26T18:00:00Z') });
    expect(res).toMatchObject({ week: 7, linesInserted: 10, unmappedGames: [] });
    for (const p of Object.values(P)) expect((await playerScore(t, p.id)).points_x100).toBe(p.x100);
    expect(await count(t, 'player_game_scores', `rules_version = 'yahoo-half-ppr-v1'`)).toBe(10);
  });

  // ── AC2 ───────────────────────────────────────────────────────────────────
  it('AC2: a week score is the exact integer sum of its slot scores', async () => {
    const W = await week7(t);
    const u = await createUser(t);
    await lockSlot(t, { userId: u, windowId: W.early, playerId: P.smith.id, slotKey: 'qb' });
    await lockSlot(t, { userId: u, windowId: W.early, playerId: P.taylor.id, slotKey: 'te' });
    await lockSlot(t, { userId: u, windowId: W.early, playerId: P.beck.id, slotKey: 'rb1' });
    await lockSlot(t, { userId: u, windowId: W.snf, playerId: P.butker.id, slotKey: 'k' });
    await store.ingest({ season: SEASON, ...feeds(), serverNow: new Date('2026-10-26T18:00:00Z') });
    expect(await weekScore(t, u)).toMatchObject({ points_x100: 2448 + 2270 - 10 + 500, slots_scored: 4 });
  });

  // ── AC3 ───────────────────────────────────────────────────────────────────
  it('AC3: only locked season-long slots score; empty, voided and weekly-contest picks add nothing', async () => {
    const W = await week7(t);
    const a = await createUser(t, 'a');
    const weeklyOnly = await createUser(t, 'weekly');
    await lockSlot(t, { userId: a, windowId: W.early, playerId: P.smith.id, slotKey: 'qb' });
    await lockSlot(t, { userId: a, windowId: W.early, playerId: P.stroud.id, slotKey: 'flex', voided: true });
    await submitWeekly(t, { userId: a, windowId: W.early, playerId: P.taylor.id, week: 7 });
    await submitWeekly(t, { userId: weeklyOnly, windowId: W.early, playerId: P.smith.id, week: 7 });
    await store.ingest({ season: SEASON, ...feeds(), serverNow: new Date('2026-10-26T18:00:00Z') });

    expect(await weekScore(t, a)).toMatchObject({ points_x100: P.smith.x100, slots_scored: 1 });
    expect(await weekScore(t, weeklyOnly)).toBeUndefined();
  });

  it('AC3: a player locked in one window scores nothing from a game in another window', async () => {
    const W = await week7(t);
    const u = await createUser(t);
    // Smith played in Sunday Early; this submission points at SNF, so it must score 0.
    await lockSlot(t, { userId: u, windowId: W.snf, playerId: P.smith.id, slotKey: 'qb' });
    await store.ingest({ season: SEASON, ...feeds(), serverNow: new Date('2026-10-26T18:00:00Z') });
    expect(await weekScore(t, u)).toMatchObject({ points_x100: 0, slots_scored: 1 });
  });

  // ── AC4 ───────────────────────────────────────────────────────────────────
  it('AC4: provisional while live; each player goes final when his own game is Final', async () => {
    const W = await week7(t);
    const u = await createUser(t);
    await lockSlot(t, { userId: u, windowId: W.early, playerId: P.smith.id, slotKey: 'qb' });
    await lockSlot(t, { userId: u, windowId: W.early, playerId: P.stroud.id, slotKey: 'flex' });

    // NYJ game over, HOU game still live, both in the same window.
    await store.ingest({ season: SEASON, ...feeds({ '163646': 'LIVE' }), serverNow: new Date('2026-10-25T20:10:00Z') });
    expect((await playerScore(t, P.smith.id)).status).toBe('final');
    expect((await playerScore(t, P.stroud.id)).status).toBe('provisional');
    expect((await weekScore(t, u)).status).toBe('provisional');

    const [res] = await store.ingest({ season: SEASON, ...feeds(), serverNow: new Date('2026-10-25T21:30:00Z') });
    expect(res.scoresFinalized).toBe(2); // both fixture players in the HOU game: Stroud and Stover
    expect((await playerScore(t, P.stroud.id)).status).toBe('final');
    expect((await weekScore(t, u)).status).toBe('final');
    expect(await count(t, 'score_corrections')).toBe(0); // provisional→final is not a correction
  });

  it('AC4: live stat changes update provisional scores without being treated as corrections', async () => {
    const W = await week7(t);
    const u = await createUser(t);
    await lockSlot(t, { userId: u, windowId: W.early, playerId: P.smith.id, slotKey: 'qb' });
    const live = feeds({ '163648': 'LIVE' });
    await store.ingest({ season: SEASON, games: live.games, gamelogs: withStats(live.gamelogs, P.smith.id, { passYds: 150, passTd: 1 }), serverNow: new Date('2026-10-25T18:30:00Z') });
    expect(await weekScore(t, u)).toMatchObject({ points_x100: 150 * 4 + 400 + 200 - 100, status: 'provisional' });
    await store.ingest({ season: SEASON, ...live, serverNow: new Date('2026-10-25T19:30:00Z') });
    expect((await weekScore(t, u)).points_x100).toBe(P.smith.x100);
    expect(await count(t, 'score_corrections')).toBe(0);
  });

  // ── AC5 ───────────────────────────────────────────────────────────────────
  it('AC5: a correction before freeze updates score, audit, week total and notifies (in-app + email, never push)', async () => {
    const W = await week7(t);
    const u = await createUser(t);
    const bystander = await createUser(t, 'bystander');
    await lockSlot(t, { userId: u, windowId: W.early, playerId: P.smith.id, slotKey: 'qb' });
    await lockSlot(t, { userId: bystander, windowId: W.early, playerId: P.stroud.id, slotKey: 'qb' });
    await store.ingest({ season: SEASON, ...feeds(), serverNow: new Date('2026-10-26T18:00:00Z') });

    // MSF corrects Smith: 287 → 297 passing yards (+0.40).
    const f = feeds();
    const [res] = await store.ingest({ season: SEASON, games: f.games, gamelogs: withStats(f.gamelogs, P.smith.id, { passYds: 297 }), serverNow: new Date('2026-10-27T15:00:00Z') });
    expect(res).toMatchObject({ correctionsApplied: 1, correctionNoticesQueued: 1 });
    expect(await playerScore(t, P.smith.id)).toMatchObject({ points_x100: 2488, status: 'final' });
    expect((await weekScore(t, u)).points_x100).toBe(2488);

    const [c] = await t.sql<{ points_before_x100: number; points_after_x100: number; applied: boolean; reason: string }>(`SELECT * FROM score_corrections`);
    expect(c).toMatchObject({ points_before_x100: 2448, points_after_x100: 2488, applied: true, reason: 'STAT_CORRECTION' });

    const notes = await t.sql<{ user_id: string; payload: { weekBeforeX100: number; weekAfterX100: number; channels: string[]; changes: unknown[] } }>(
      `SELECT user_id, payload FROM notification_queue WHERE kind = 'SCORE_CORRECTION'`
    );
    expect(notes).toHaveLength(1);
    expect(notes[0].user_id).toBe(u);
    expect(notes[0].payload).toMatchObject({ weekBeforeX100: 2448, weekAfterX100: 2488, channels: ['in_app', 'recap_email'] });
    expect(notes[0].payload.channels).not.toContain('push');
  });

  // ── AC6 + AC7 ─────────────────────────────────────────────────────────────
  it('AC7: no freeze while any game is not Final; freezes exactly 48h after the last Final', async () => {
    const W = await week7(t);
    const u = await createUser(t);
    await lockSlot(t, { userId: u, windowId: W.early, playerId: P.smith.id, slotKey: 'qb' });
    await store.ingest({ season: SEASON, ...feeds(ALL_FINAL_EXCEPT_MNF), serverNow: new Date('2026-10-26T18:00:00Z') });
    expect(await store.freezeDueWeeks(SEASON, new Date('2026-11-05T00:00:00Z'))).toEqual([]); // MNF unplayed

    const mnfFinalSeen = new Date('2026-10-27T03:40:00Z');
    await store.ingest({ season: SEASON, ...feeds(MNF_FINAL), serverNow: mnfFinalSeen });
    expect(await store.freezeDueWeeks(SEASON, new Date(mnfFinalSeen.getTime() + 48 * HOUR - 1000))).toEqual([]);
    const frozen = await store.freezeDueWeeks(SEASON, new Date(mnfFinalSeen.getTime() + 48 * HOUR));
    expect(frozen).toEqual([{ week: 7, scoresFrozen: 10, lastFinalAt: mnfFinalSeen }]);
    expect((await weekScore(t, u)).status).toBe('frozen');
    expect(await store.freezeDueWeeks(SEASON, new Date(mnfFinalSeen.getTime() + 100 * HOUR))).toEqual([]); // once
  });

  it('AC7: a canceled window does not block the freeze', async () => {
    const W = await week7(t);
    await t.sql(`UPDATE game_windows SET status = 'canceled' WHERE id = $1`, [W.mnf]);
    const seen = new Date('2026-10-26T18:00:00Z');
    await store.ingest({ season: SEASON, ...feeds(), serverNow: seen });
    expect(await store.freezeDueWeeks(SEASON, new Date(seen.getTime() + 48 * HOUR))).toHaveLength(1);
  });

  it('AC6: a correction after freeze changes nothing and is recorded once as AFTER_FREEZE', async () => {
    const W = await week7(t);
    const u = await createUser(t);
    await lockSlot(t, { userId: u, windowId: W.early, playerId: P.smith.id, slotKey: 'qb' });
    const seen = new Date('2026-10-27T03:40:00Z');
    await store.ingest({ season: SEASON, ...feeds(MNF_FINAL), serverNow: seen });
    await store.freezeDueWeeks(SEASON, new Date(seen.getTime() + 48 * HOUR));

    const f = feeds(MNF_FINAL);
    const late = { season: SEASON, games: f.games, gamelogs: withStats(f.gamelogs, P.smith.id, { passYds: 297 }), serverNow: new Date(seen.getTime() + 60 * HOUR) };
    const [res] = await store.ingest(late);
    expect(res).toMatchObject({ frozen: true, correctionsApplied: 0, correctionsIgnored: 1, correctionNoticesQueued: 0 });
    expect(await playerScore(t, P.smith.id)).toMatchObject({ points_x100: 2448, status: 'frozen' });
    expect((await weekScore(t, u)).points_x100).toBe(2448);

    await store.ingest({ ...late, serverNow: new Date(seen.getTime() + 61 * HOUR) });
    const rows = await t.sql<{ applied: boolean; reason: string }>(`SELECT applied, reason FROM score_corrections`);
    expect(rows).toEqual([{ applied: false, reason: 'AFTER_FREEZE' }]);
    expect(await count(t, 'notification_queue', `kind = 'SCORE_CORRECTION'`)).toBe(0);
  });

  it('a correction racing the freeze is either fully applied or fully ignored, never half', async () => {
    const W = await week7(t);
    const u = await createUser(t);
    await lockSlot(t, { userId: u, windowId: W.early, playerId: P.smith.id, slotKey: 'qb' });
    const seen = new Date('2026-10-27T03:40:00Z');
    await store.ingest({ season: SEASON, ...feeds(MNF_FINAL), serverNow: seen });
    const due = new Date(seen.getTime() + 48 * HOUR);
    const f = feeds(MNF_FINAL);
    await Promise.all([
      store.freezeDueWeeks(SEASON, due),
      store.ingest({ season: SEASON, games: f.games, gamelogs: withStats(f.gamelogs, P.smith.id, { passYds: 297 }), serverNow: due }),
    ]);
    const score = await playerScore(t, P.smith.id);
    const [c] = await t.sql<{ applied: boolean }>(`SELECT applied FROM score_corrections`);
    expect(score.status).toBe('frozen');
    if (c.applied) expect(score.points_x100).toBe(2488);
    else expect(score.points_x100).toBe(2448);
    expect((await weekScore(t, u)).points_x100).toBe(score.points_x100);
    expect((await store.verifyFrozenWeek(SEASON, 7)).mismatches).toEqual([]);
  });

  // ── AC8 ───────────────────────────────────────────────────────────────────
  it('AC8: frozen scores and the corrections audit cannot be changed at the database', async () => {
    await week7(t);
    const seen = new Date('2026-10-27T03:40:00Z');
    await store.ingest({ season: SEASON, ...feeds(MNF_FINAL), serverNow: seen });
    const f = feeds(MNF_FINAL);
    await store.ingest({ season: SEASON, games: f.games, gamelogs: withStats(f.gamelogs, P.smith.id, { passYds: 297 }), serverNow: new Date(seen.getTime() + HOUR) });
    await store.freezeDueWeeks(SEASON, new Date(seen.getTime() + 48 * HOUR));

    await expect(t.sql(`UPDATE player_game_scores SET points_x100 = 9999 WHERE player_id = $1`, [P.smith.id])).rejects.toThrow(/SCORE_FROZEN/);
    await expect(t.sql(`UPDATE player_game_stats SET pass_yds = 999 WHERE player_id = $1`, [P.smith.id])).rejects.toThrow(/SCORE_FROZEN/);
    await expect(t.sql(`DELETE FROM player_game_scores`)).rejects.toThrow(/APPEND_ONLY/);
    await expect(t.sql(`UPDATE score_corrections SET applied = false`)).rejects.toThrow(/APPEND_ONLY/);
    await expect(t.sql(`DELETE FROM score_corrections`)).rejects.toThrow(/APPEND_ONLY/);
    await expect(t.sql(`TRUNCATE score_corrections`)).rejects.toThrow(/APPEND_ONLY/);
    await expect(t.sql(`DELETE FROM week_freezes`)).rejects.toThrow(/APPEND_ONLY/);
  });

  // ── AC9 ───────────────────────────────────────────────────────────────────
  it('AC9: re-ingesting an unchanged feed writes nothing', async () => {
    const W = await week7(t);
    const u = await createUser(t);
    await lockSlot(t, { userId: u, windowId: W.early, playerId: P.smith.id, slotKey: 'qb' });
    await store.ingest({ season: SEASON, ...feeds(), serverNow: new Date('2026-10-26T18:00:00Z') });
    const snapshot = async () =>
      JSON.stringify(
        await Promise.all(
          ['nfl_games', 'season_rules', 'player_game_stats', 'player_game_scores', 'score_corrections', 'user_week_scores', 'notification_queue'].map((tbl) =>
            t.sql(`SELECT * FROM ${tbl} ORDER BY 1, 2`)
          )
        )
      );
    const before = await snapshot();
    const [res] = await store.ingest({ season: SEASON, ...feeds(), serverNow: new Date('2026-10-26T19:00:00Z') });
    expect(res).toMatchObject({ gamesChanged: 0, linesInserted: 0, linesUpdated: 0, scoresFinalized: 0, userWeekScoresChanged: 0 });
    expect(await snapshot()).toBe(before);
  });

  it('AC9: the integrity check recomputes frozen scores and flags any that disagree with their stat line', async () => {
    await week7(t);
    const seen = new Date('2026-10-27T03:40:00Z');
    await store.ingest({ season: SEASON, ...feeds(MNF_FINAL), serverNow: seen });
    // Simulate a bad write to a final (not yet frozen) score.
    await t.sql(`UPDATE player_game_scores SET points_x100 = points_x100 + 2 WHERE player_id = $1`, [P.taylor.id]);
    await store.freezeDueWeeks(SEASON, new Date(seen.getTime() + 48 * HOUR));
    const check = await store.verifyFrozenWeek(SEASON, 7);
    expect(check.checked).toBe(10);
    expect(check.mismatches).toEqual([{ scoreId: expect.any(String), stored: 2272, recomputed: 2270 }]);
  });

  // ── AC10 ──────────────────────────────────────────────────────────────────
  it('AC10: equal totals share a rank; different totals never do', async () => {
    const W = await week7(t);
    const x = await createUser(t, 'x');
    const y = await createUser(t, 'y');
    const z = await createUser(t, 'z');
    await lockSlot(t, { userId: x, windowId: W.early, playerId: P.smith.id, slotKey: 'qb' });
    await lockSlot(t, { userId: y, windowId: W.early, playerId: P.smith.id, slotKey: 'qb' });
    await lockSlot(t, { userId: z, windowId: W.early, playerId: P.smith.id, slotKey: 'qb' });
    await lockSlot(t, { userId: z, windowId: W.early, playerId: P.beck.id, slotKey: 'rb1' }); // -0.10
    await store.ingest({ season: SEASON, ...feeds(), serverNow: new Date('2026-10-26T18:00:00Z') });
    const ranks = await t.sql<{ user_id: string; points_x100: string; rnk: string }>(
      `SELECT user_id, points_x100, RANK() OVER (ORDER BY points_x100 DESC) AS rnk FROM user_season_totals WHERE season = $1`,
      [SEASON]
    );
    const r = new Map(ranks.map((row) => [row.user_id, Number(row.rnk)]));
    expect([r.get(x), r.get(y), r.get(z)]).toEqual([1, 1, 3]);
  });

  // ── AC11 ──────────────────────────────────────────────────────────────────
  it('AC11: once a season is scored, a different ruleset is refused by the engine and the database', async () => {
    await week7(t);
    await store.ingest({ season: SEASON, ...feeds(), serverNow: new Date('2026-10-26T18:00:00Z') });
    const fullPpr = { version: 'full-ppr-v1', centipointsPer: { ...YAHOO_HALF_PPR_V1.centipointsPer, receptions: 100 } };
    await expect(store.ingest({ season: SEASON, ...feeds(), serverNow: new Date('2026-10-26T19:00:00Z'), rules: fullPpr })).rejects.toBeInstanceOf(RulesVersionMismatchError);
    await expect(t.sql(`UPDATE player_game_scores SET rules_version = 'full-ppr-v1'`)).rejects.toThrow(/RULES_VERSION/);
    await expect(t.sql(`UPDATE season_rules SET rules_version = 'full-ppr-v1'`)).rejects.toThrow(/RULES_VERSION/);
  });

  // ── Operational ───────────────────────────────────────────────────────────
  it('reports games with no mapped game window and skips their stat lines', async () => {
    await createWindow(t, { week: 7, label: 'Sunday Early', scheduledEt: new Date('2026-10-25T17:00:00Z'), msfGameIds: ['163648'], status: 'locked' });
    const [res] = await store.ingest({ season: SEASON, ...feeds(), serverNow: new Date('2026-10-26T18:00:00Z') });
    expect(res.linesInserted).toBe(3); // Smith, Taylor, Beck (game 163648)
    expect(res.unmappedGames).toEqual(['163643', '163646', '163647', '163650', '163653']);
  });
});
