/**
 * PRD-006 §14 AC7–AC12 and §11: three-gate lineups, lock races, validation,
 * roster re-resolve, the player pool, payments over HTTP, and the worker —
 * against real Postgres + Redis.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPostgresBurnStore, evaluateAndFireLocks } from '@burnout/burn-engine';
import { describeDbRedis, SEASON } from '@burnout/test-support';
import { createJobs, MsfHttpError, msfFetcher, type MsfFetcher } from '../jobs';
import { lineupChecksum } from '../lineups/service';
import { reresolveSubmissions, syncInjuries, syncPlayers } from '../players/roster';
import { account, buildWeek, createWorld, LINEUP, PLAYERS, relogin, stepUp, submitLineup, WINDOWS, type Account, type World } from './harness';

const silent = () => {};

describeDbRedis('PRD-006 lineups, players, payments routes (HTTP, Postgres + Redis)', () => {
  let w: World;
  let win: Awaited<ReturnType<typeof buildWeek>>;
  beforeEach(async () => {
    w = await createWorld();
    win = await buildWeek(w);
  });
  afterEach(async () => {
    await w.close();
  });

  const rows = (userId: string) =>
    w.t.sql<{ slot_key: string; player_id: string; game_window_id: string; locked_at: Date | null; void_reason: string | null; receipt_id: string | null }>(
      `SELECT slot_key, player_id, game_window_id::text AS game_window_id, locked_at, void_reason, receipt_id::text AS receipt_id
         FROM season_submissions WHERE user_id = $1 ORDER BY slot_key`,
      [userId]
    );
  const fireLocks = (at: Date) => {
    w.clock.set(at);
    return evaluateAndFireLocks({ ...createPostgresBurnStore(w.t.db), getServerTime: w.clock.get, log: silent });
  };
  const review = (a: Account, slots: object) => a.client.post(`/v1/seasons/${SEASON}/weeks/8/lineup/review`, { slots });
  const codes = (res: { body: { errors?: Array<{ code: string; slot?: string }> } }) => (res.body.errors ?? []).map((e) => `${e.slot}:${e.code}`);

  // ── AC7 ───────────────────────────────────────────────────────────────────
  it('AC7: the three gates write nine submissions and a receipt with all three server timestamps and a verifiable checksum', async () => {
    const a = await account(w);
    const rev = await review(a, LINEUP);
    expect(rev.status).toBe(201);
    expect(rev.body.slots.find((s: { slot: string }) => s.slot === 'rb1')).toMatchObject({ playerId: 'rbDEN', name: 'Ray Dent', team: 'DEN', opponent: 'KC', locked: false });
    const id = rev.body.confirmationId;
    w.clock.advanceMs(4_000);
    const ack = await a.client.post(`/v1/lineup-confirmations/${id}/acknowledge`, { burnRules: true, permanent: true, noRefund: true });
    expect(ack.status).toBe(200);
    w.clock.advanceMs(3_000);
    const conf = await a.client.post(`/v1/lineup-confirmations/${id}/confirm`);
    expect(conf.status).toBe(200);

    const subs = await rows(a.userId);
    expect(subs).toHaveLength(9);
    expect(subs.find((s) => s.slot_key === 'rb1')).toMatchObject({ player_id: 'rbDEN', game_window_id: win.tnf, receipt_id: conf.body.receiptId });
    const [r] = await w.t.sql<{ gate1_at: Date; gate2_at: Date; gate3_at: Date; lineup_sha256: string; submission_id: string; ip_address: string; user_agent: string }>(
      `SELECT gate1_at, gate2_at, gate3_at, lineup_sha256, submission_id::text AS submission_id, ip_address, user_agent FROM submission_receipts WHERE id = $1`,
      [conf.body.receiptId]
    );
    expect(r.gate2_at.getTime() - r.gate1_at.getTime()).toBe(4_000);
    expect(r.gate3_at.getTime() - r.gate2_at.getTime()).toBe(3_000);
    expect(r.submission_id).toBe(id);
    expect(r.ip_address).toBe(a.client.ip);
    expect(r.user_agent).toBe('jest-client');
    expect(r.lineup_sha256).toBe(conf.body.sha256);
    expect(lineupChecksum({ userId: a.userId, season: SEASON, week: 8, gate3At: r.gate3_at, slots: conf.body.slots })).toBe(r.lineup_sha256);
    const [{ n }] = await w.t.sql<{ n: number }>(`SELECT count(*)::int AS n FROM notification_queue WHERE user_id = $1 AND kind = 'LINEUP_RECEIPT' AND payload->>'sha256' = $2`, [a.userId, r.lineup_sha256]);
    expect(n).toBe(1);
    expect((await a.client.get(`/v1/receipts/${conf.body.receiptId}`)).body.sha256).toBe(r.lineup_sha256);
    const [{ e }] = await w.t.sql<{ e: number }>(`SELECT count(*)::int AS e FROM pool_entries WHERE user_id = $1`, [a.userId]);
    expect(e).toBe(9);
  });

  it('AC7: gates run in order, once, before expiry, by their owner; receipts are append-only', async () => {
    const a = await account(w);
    const other = await account(w);
    const rev = await review(a, LINEUP);
    const id = rev.body.confirmationId;
    expect((await a.client.post(`/v1/lineup-confirmations/${id}/confirm`)).body.error).toBe('GATE_ORDER');
    expect((await a.client.post(`/v1/lineup-confirmations/${id}/acknowledge`, { burnRules: true, permanent: false, noRefund: true })).body.error).toBe('ACKNOWLEDGEMENT_REQUIRED');
    expect((await other.client.post(`/v1/lineup-confirmations/${id}/acknowledge`, { burnRules: true, permanent: true, noRefund: true })).status).toBe(404);
    await a.client.post(`/v1/lineup-confirmations/${id}/acknowledge`, { burnRules: true, permanent: true, noRefund: true });
    expect((await a.client.post(`/v1/lineup-confirmations/${id}/acknowledge`, { burnRules: true, permanent: true, noRefund: true })).body.error).toBe('GATE_ORDER');
    expect((await other.client.post(`/v1/lineup-confirmations/${id}/confirm`)).status).toBe(404);
    const ok = await a.client.post(`/v1/lineup-confirmations/${id}/confirm`);
    expect(ok.status).toBe(200);
    expect((await a.client.post(`/v1/lineup-confirmations/${id}/confirm`)).body.error).toBe('GATE_ORDER');
    expect((await other.client.get(`/v1/receipts/${ok.body.receiptId}`)).status).toBe(404);

    const late = await review(a, LINEUP);
    await a.client.post(`/v1/lineup-confirmations/${late.body.confirmationId}/acknowledge`, { burnRules: true, permanent: true, noRefund: true });
    w.clock.advanceMs(11 * 60_000);
    expect((await a.client.post(`/v1/lineup-confirmations/${late.body.confirmationId}/confirm`)).body.error).toBe('CONFIRMATION_EXPIRED');

    await expect(w.t.sql(`UPDATE submission_receipts SET lineup_sha256 = repeat('0', 64)`)).rejects.toThrow(/APPEND_ONLY/);
    await expect(w.t.sql(`DELETE FROM submission_receipts`)).rejects.toThrow(/APPEND_ONLY/);
    await expect(w.t.sql(`UPDATE lineup_confirmations SET status = 'reviewed'`)).rejects.toThrow(/CONFIRMATION_IMMUTABLE/);
  });

  // ── AC8 ───────────────────────────────────────────────────────────────────
  it('AC8: a confirm after scheduled_et is rejected even before the lock job runs', async () => {
    const a = await account(w);
    w.clock.set(new Date(WINDOWS.tnf.getTime() - 60_000));
    await relogin(a);
    const rev = await review(a, LINEUP);
    expect(rev.status).toBe(201);
    await a.client.post(`/v1/lineup-confirmations/${rev.body.confirmationId}/acknowledge`, { burnRules: true, permanent: true, noRefund: true });
    w.clock.set(new Date(WINDOWS.tnf.getTime() + 1_000)); // lock job has not fired
    const conf = await a.client.post(`/v1/lineup-confirmations/${rev.body.confirmationId}/confirm`);
    expect(conf.status).toBe(422);
    expect(codes(conf)).toEqual(expect.arrayContaining(['rb1:GAME_WINDOW_LOCKED', 'wr1:GAME_WINDOW_LOCKED']));
    expect(await rows(a.userId)).toHaveLength(0);
  });

  it('AC8: locked slots cannot change; a partial re-save keeps them; the database refuses an UPDATE of a locked row', async () => {
    const a = await account(w);
    const first = await submitLineup(w, a);
    expect(first.status).toBe(200);
    await fireLocks(new Date(WINDOWS.tnf.getTime() + 30_000));
    w.clock.advanceMs(60_000);
    await relogin(a);

    const change = await review(a, { ...LINEUP, rb1: 'rbSF' });
    expect(codes(change)).toEqual(['rb1:SLOT_LOCKED']);

    // Re-save with only the unlocked slots: locked rb1/wr1 carry over unchanged.
    const { rb1: _rb1, wr1: _wr1, ...unlocked } = LINEUP;
    const second = await submitLineup(w, a, { ...unlocked, wr2: 'wrBUF' });
    expect(second.status).toBe(200);
    expect(second.body.changedSlots).toEqual(['wr2']);
    const after = await rows(a.userId);
    expect(after.find((r) => r.slot_key === 'rb1')).toMatchObject({ player_id: 'rbDEN', receipt_id: first.body.receiptId });
    expect(after.find((r) => r.slot_key === 'wr2')).toMatchObject({ player_id: 'wrBUF', game_window_id: win.early, receipt_id: second.body.receiptId });
    expect(second.body.slots.find((s: { slot: string }) => s.slot === 'rb1')).toMatchObject({ playerId: 'rbDEN', locked: true });

    // A locked player can't be reused in another slot this week.
    expect(codes(await review(a, { ...unlocked, flex: 'wrKC' }))).toEqual(['flex:DUPLICATE_PLAYER']);

    await expect(w.t.sql(`UPDATE season_submissions SET player_id = 'rbSF' WHERE user_id = $1 AND slot_key = 'rb1'`, [a.userId])).rejects.toThrow(/SUBMISSION_LOCKED/);
    await expect(w.t.sql(`DELETE FROM season_submissions WHERE user_id = $1 AND slot_key = 'rb1'`, [a.userId])).rejects.toThrow(/SUBMISSION_LOCKED/);
  });

  it('AC8: once every window has locked, the week is closed to review', async () => {
    const a = await account(w);
    w.clock.set(new Date(WINDOWS.mnf.getTime() + 1));
    await relogin(a);
    expect((await review(a, LINEUP)).body.error).toBe('WEEK_CLOSED');
  });

  // ── AC9 ───────────────────────────────────────────────────────────────────
  it('AC9: burned, bye, wrong-position, duplicate, unselectable and empty slots are rejected with codes', async () => {
    const a = await account(w);
    await w.t.sql(`INSERT INTO pool_entries (user_id, player_id, season, burned, burned_at) VALUES ($1, 'kMIA', $2, true, now())`, [a.userId, SEASON]);
    expect(codes(await review(a, { ...LINEUP, k: 'kMIA' }))).toEqual(['k:PLAYER_BURNED_OR_UNAVAILABLE']);
    expect(codes(await review(a, { ...LINEUP, rb2: 'rbCHI' }))).toEqual(['rb2:PLAYER_ON_BYE']);
    expect(codes(await review(a, { ...LINEUP, qb: 'rbSF' }))).toEqual(['qb:POSITION_INELIGIBLE']);
    expect(codes(await review(a, { ...LINEUP, flex: 'wrKC' }))).toEqual(['flex:DUPLICATE_PLAYER']);
    expect((await review(a, { ...LINEUP, rb2: 'fbSF' })).status).toBe(201); // FB eligible at RB/FLEX
    expect((await review(a, { ...LINEUP, flex: 'fbSF' })).status).toBe(201);
    expect(codes(await review(a, { ...LINEUP, qb: 'fbSF' }))).toEqual(['qb:POSITION_INELIGIBLE']);
    await w.t.sql(`UPDATE nfl_players SET injury_status = 'Out' WHERE msf_player_id = 'rbSF'`);
    await w.t.sql(`UPDATE nfl_players SET injury_status = 'IR' WHERE msf_player_id = 'teGB'`);
    await w.t.sql(`UPDATE nfl_players SET injury_status = 'Doubtful' WHERE msf_player_id = 'wrBUF'`);
    expect(codes(await review(a, { ...LINEUP, rb2: 'rbSF' }))).toEqual(['rb2:PLAYER_INACTIVE']);
    expect(codes(await review(a, { ...LINEUP, te: 'teGB' }))).toEqual(['te:PLAYER_INACTIVE']);
    expect((await review(a, { ...LINEUP, wr3: 'wrBUF' })).status).toBe(201); // Doubtful is still selectable
    expect((await review(a, { ...LINEUP, te: null })).status).toBe(201); // empty is allowed (Nath, 2026-10-29): scores 0, burns nothing
    expect((await review(a, { ...LINEUP, extra: 'x' })).body.error).toBe('VALIDATION');
    expect((await a.client.post(`/v1/seasons/2025-2026-regular/weeks/8/lineup/review`, { slots: LINEUP })).body.error).toBe('SEASON_CLOSED');
  });

  // ── AC10 ──────────────────────────────────────────────────────────────────
  it('AC10: re-resolve re-points a traded player, voids a player with no game, and never touches locked rows', async () => {
    const a = await account(w);
    await submitLineup(w, a);
    await fireLocks(new Date(WINDOWS.tnf.getTime() + 30_000)); // rb1 (DEN) and wr1 (KC) locked

    const players = PLAYERS.map(([msfPlayerId, firstName, lastName, position, team]) => ({ msfPlayerId, firstName, lastName, position, team, rosterStatus: 'ROSTER', injuryStatus: 'Active' as const }));
    const moved = players.map((p) => {
      if (p.msfPlayerId === 'wrDAL') return { ...p, team: 'PHI' }; // traded: late → SNF
      if (p.msfPlayerId === 'teSF') return { ...p, team: null }; // released
      if (p.msfPlayerId === 'rbDEN') return { ...p, team: 'GB' }; // traded after his lock
      return p;
    });
    await syncPlayers(w.ctx, moved, { complete: true });
    const res = await reresolveSubmissions(w.ctx, SEASON, 8);
    expect(res).toMatchObject({ repointed: 1, voided: 1 });

    const after = await rows(a.userId);
    expect(after.find((r) => r.slot_key === 'wr2')).toMatchObject({ player_id: 'wrDAL', game_window_id: win.snf, void_reason: null });
    expect(after.find((r) => r.slot_key === 'te')).toMatchObject({ void_reason: 'PLAYER_NO_GAME', locked_at: null });
    expect(after.find((r) => r.slot_key === 'rb1')).toMatchObject({ game_window_id: win.tnf, void_reason: null });
    expect(after.find((r) => r.slot_key === 'rb1')!.locked_at).not.toBeNull();

    const events = await w.t.sql<{ event_type: string; slot_key: string }>(`SELECT event_type, slot_key FROM security_audit_log WHERE event_type LIKE 'SUBMISSION_%' ORDER BY event_type`);
    expect(events).toEqual([{ event_type: 'SUBMISSION_REPOINTED', slot_key: 'wr2' }, { event_type: 'SUBMISSION_VOIDED', slot_key: 'te' }]);
    const notes = await w.t.sql<{ kind: string }>(`SELECT kind FROM notification_queue WHERE kind LIKE 'SUBMISSION_%' ORDER BY kind`);
    expect(notes.map((n) => n.kind)).toEqual(['SUBMISSION_REPOINTED', 'SUBMISSION_VOIDED']);

    // The voided slot can be refilled through the gates; a second run changes nothing.
    w.clock.advanceMs(60_000);
    await relogin(a);
    const { rb1: _r, wr1: _w, ...rest } = LINEUP;
    expect((await submitLineup(w, a, { ...rest, te: 'teGB' })).status).toBe(200);
    expect((await reresolveSubmissions(w.ctx, SEASON, 8))).toMatchObject({ repointed: 0, voided: 0 });
  });

  it('AC10: a picked player who turns Out or IR before his lock has his slot voided and the user notified; locked picks stay', async () => {
    const a = await account(w);
    await submitLineup(w, a);
    await fireLocks(new Date(WINDOWS.tnf.getTime() + 30_000)); // rb1 rbDEN, wr1 wrKC locked
    await w.t.sql(`UPDATE nfl_players SET injury_status = 'Out' WHERE msf_player_id IN ('wrPHI', 'rbDEN')`);
    await w.t.sql(`UPDATE nfl_players SET injury_status = 'IR' WHERE msf_player_id = 'kDET'`);
    const res = await reresolveSubmissions(w.ctx, SEASON, 8);
    expect(res).toMatchObject({ voided: 2, inactive: 2, repointed: 0 });
    const after = await rows(a.userId);
    expect(after.find((r) => r.slot_key === 'wr3')).toMatchObject({ void_reason: 'PLAYER_INACTIVE', locked_at: null });
    expect(after.find((r) => r.slot_key === 'k')).toMatchObject({ void_reason: 'PLAYER_INACTIVE' });
    expect(after.find((r) => r.slot_key === 'rb1')).toMatchObject({ void_reason: null }); // locked: untouched
    const [{ n }] = await w.t.sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM notification_queue WHERE user_id = $1 AND kind = 'SUBMISSION_VOIDED' AND payload->>'reason' = 'PLAYER_INACTIVE'`, [a.userId]);
    expect(n).toBe(2);
    // Voided Out/IR players are never burned: their windows going Final burns nothing for them.
    const [{ b }] = await w.t.sql<{ b: number }>(`SELECT count(*)::int AS b FROM burn_records WHERE user_id = $1`, [a.userId]);
    expect(b).toBe(0);
  });

  it('injuries feed: listed players take its designation, recovered players go back to Active, and Out picks are voided', async () => {
    const a = await account(w);
    await submitLineup(w, a);
    await w.t.sql(`UPDATE nfl_players SET injury_status = 'Out' WHERE msf_player_id = 'rbSF'`); // was Out, now healed
    const injured = [
      { msfPlayerId: 'wrPHI', firstName: 'Wade', lastName: 'Phi', position: 'WR', team: 'PHI', rosterStatus: 'ROSTER', injuryStatus: 'Out' as const },
      { msfPlayerId: 'teSF', firstName: 'Ty', lastName: 'Sfo', position: 'TE', team: 'SF', rosterStatus: 'INJURY_LIST', injuryStatus: 'IR' as const },
      { msfPlayerId: 'kMIA', firstName: 'Kai', lastName: 'Mia', position: 'K', team: 'MIA', rosterStatus: 'ROSTER', injuryStatus: 'Questionable' as const },
    ];
    expect(await syncInjuries(w.ctx, injured)).toEqual({ updated: 3, cleared: 1, skipped: null });
    const status = await w.t.sql<{ msf_player_id: string; injury_status: string }>(
      `SELECT msf_player_id, injury_status FROM nfl_players WHERE msf_player_id IN ('rbSF', 'wrPHI', 'teSF', 'kMIA') ORDER BY msf_player_id`);
    expect(status.map((s) => [s.msf_player_id, s.injury_status])).toEqual([['kMIA', 'Questionable'], ['rbSF', 'Active'], ['teSF', 'IR'], ['wrPHI', 'Out']]);
    expect(await syncInjuries(w.ctx, [])).toEqual({ updated: 0, cleared: 0, skipped: 'EMPTY_FEED' }); // a blank feed changes nothing

    const msf: MsfFetcher = { async get() { return JSON.parse(readFileSync(join(__dirname, 'fixtures/msf-injuries.sample.json'), 'utf8')); } };
    const jobs = createJobs({ db: w.t.db, payments: w.payments, msf, season: SEASON, now: w.clock.get, log: silent, apiContext: w.ctx });
    // The real sample names none of our test players: everyone injured here recovers, so nothing new is voided.
    await reresolveSubmissions(w.ctx, SEASON, 8);
    const r = (await jobs.run('injuries')) as { cleared: number; reresolve: { voided: number } };
    expect(r.cleared).toBe(3);
    const after = await rows(a.userId);
    expect(after.filter((x) => x.void_reason === 'PLAYER_INACTIVE').map((x) => x.slot_key).sort()).toEqual(['te', 'wr3']); // voided by the earlier pass
  });

  it('AC10: with no schedule for the week, re-resolve does nothing rather than void everything', async () => {
    const a = await account(w);
    await submitLineup(w, a);
    await w.t.sql(`UPDATE nfl_games SET home_team = NULL, away_team = NULL`);
    expect(await reresolveSubmissions(w.ctx, SEASON, 8)).toMatchObject({ skipped: 'NO_SCHEDULE', voided: 0 });
  });

  // ── AC11 ──────────────────────────────────────────────────────────────────
  it('AC11: text-only player data; burn states and ownership in the pool', async () => {
    const cols = await w.t.sql<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'nfl_players'`);
    expect(cols.map((c) => c.column_name).filter((c) => /image|photo|headshot|url|src|avatar|picture|likeness/i.test(c))).toEqual([]);

    const a = await account(w);
    const b = await account(w);
    await submitLineup(w, a);
    await submitLineup(w, b, { ...LINEUP, wr3: 'wrBUF' });
    await fireLocks(new Date(WINDOWS.tnf.getTime() + 30_000));
    await w.t.sql(`UPDATE pool_entries SET burned = true, burned_at = now() WHERE user_id = $1 AND player_id = 'kDET'`, [a.userId]);
    await w.r.redis.del(`${w.r.namespace}own2:${SEASON}:8`);
    await relogin(a);

    const pool = await a.client.get(`/v1/seasons/${SEASON}/weeks/8/pool`);
    expect(pool.status).toBe(200);
    const card = (id: string) => pool.body.players.find((p: { playerId: string }) => p.playerId === id);
    expect(card('rbDEN')).toMatchObject({ burnState: 'locked', opponent: 'KC', homeAway: 'home', windowOpen: false, weekOwnershipPct: null }); // 2 managers: below the launch floor of 50
    expect(card('kDET')).toMatchObject({ burnState: 'burned' });
    expect(card('wrPHI')).toMatchObject({ burnState: 'available', weekOwnershipPct: null, seasonOwnershipPct: null, windowOpen: true });
    expect(card('rbCHI')).toMatchObject({ bye: true, opponent: null, scheduledEt: null, selectable: false, unavailableReason: 'BYE' });
    expect(card('fbSF')).toMatchObject({ position: 'FB', selectable: true, unavailableReason: null });
    expect(card('rbDEN')).toMatchObject({ selectable: false, unavailableReason: 'LOCKED' });
    expect(card('kDET')).toMatchObject({ selectable: false, unavailableReason: 'BURNED' });
    await w.t.sql(`UPDATE nfl_players SET injury_status = 'IR' WHERE msf_player_id = 'teGB'`);
    const after = await a.client.get(`/v1/seasons/${SEASON}/weeks/8/pool`);
    expect(after.body.players.find((p: { playerId: string }) => p.playerId === 'teGB')).toMatchObject({
      injuryStatus: 'IR', burnState: 'available', selectable: false, unavailableReason: 'INACTIVE', // greyed, not burned
    });
    const keys = new Set(pool.body.players.flatMap((p: object) => Object.keys(p)));
    expect([...keys].filter((k) => /image|photo|headshot|url|src|avatar/i.test(String(k)))).toEqual([]);
    expect(JSON.stringify(pool.body)).not.toMatch(/https?:\/\//);
  });


  // ── Empty slots are the manager's call (Nath, 2026-10-29) ──────────────────
  it('empty slots: confirm with K empty; it stays empty, scores nothing, and the receipt shows it', async () => {
    const a = await account(w);
    const res = await submitLineup(w, a, { ...LINEUP, k: null });
    expect(res.status).toBe(200);
    expect(res.body.slots.find((x: { slot: string }) => x.slot === 'k')).toMatchObject({ playerId: null, gameWindowId: null });
    const rows = await w.t.sql<{ slot_key: string }>(`SELECT slot_key FROM season_submissions WHERE user_id = $1 AND week = 8`, [a.userId]);
    expect(rows.map((r) => r.slot_key).sort()).toEqual(['flex', 'qb', 'rb1', 'rb2', 'te', 'wr1', 'wr2', 'wr3']);
    const lineup = await a.client.get(`/v1/seasons/${SEASON}/weeks/8/lineup`);
    expect(lineup.body.slots.find((x: { slot: string }) => x.slot === 'k').playerId).toBeNull();
  });

  it('empty slots: removing an open pick deletes it; a slot not sent keeps its pick; a locked pick can’t be removed', async () => {
    const a = await account(w);
    expect((await submitLineup(w, a)).status).toBe(200);
    // Not sending wr3 keeps Wade Phi; sending flex: null removes Webb Gnat.
    const { wr3: _keep, ...partial } = LINEUP;
    const rev = await review(a, { ...partial, flex: null });
    expect(rev.status).toBe(201);
    expect(rev.body.slots.find((x: { slot: string }) => x.slot === 'wr3').playerId).toBe('wrPHI');
    expect(rev.body.slots.find((x: { slot: string }) => x.slot === 'flex').playerId).toBeNull();
    const res = await submitLineup(w, a, { ...partial, flex: null });
    expect(res.status).toBe(200);
    expect(res.body.changedSlots).toEqual(['flex']);
    expect(await w.t.sql(`SELECT 1 FROM season_submissions WHERE user_id = $1 AND slot_key = 'flex'`, [a.userId])).toHaveLength(0);

    // After Thursday locks, rb1 (Ray Dent, TNF) is frozen: null for a locked slot leaves it as it is.
    await fireLocks(new Date(WINDOWS.tnf.getTime() + 30_000));
    await relogin(a);
    expect((await submitLineup(w, a, { ...partial, rb1: null, flex: null })).status).toBe(200);
    const [rb1] = await w.t.sql<{ player_id: string; locked: boolean }>(`SELECT player_id, locked_at IS NOT NULL AS locked FROM season_submissions WHERE user_id = $1 AND slot_key = 'rb1'`, [a.userId]);
    expect(rb1).toEqual({ player_id: 'rbDEN', locked: true });
  });

  it('empty slots: a lineup with nothing in it (and nothing to remove) is refused at review', async () => {
    const a = await account(w);
    const none = Object.fromEntries(Object.keys(LINEUP).map((k) => [k, null]));
    const res = await review(a, none);
    expect(res.status).toBe(422);
    expect(res.body.errors.map((e: { code: string }) => e.code)).toEqual(['LINEUP_EMPTY']);
    // Someone with open picks may clear them all (sitting the week out).
    expect((await submitLineup(w, a)).status).toBe(200);
    expect((await submitLineup(w, a, none)).status).toBe(200);
    expect(await w.t.sql(`SELECT 1 FROM season_submissions WHERE user_id = $1`, [a.userId])).toHaveLength(0);
  });

  it('empty slots: Nath’s late-season squeeze: only Monday night is left and that game’s kicker is burned; he plays what he can', async () => {
    const a = await account(w);
    // Kip Det (DET, Monday night) was burned earlier in the season.
    await w.t.sql(`INSERT INTO pool_entries (user_id, player_id, season, burned, burned_at) VALUES ($1, 'kDET', $2, true, now())`, [a.userId, SEASON]);
    // Everything up to Sunday night has locked.
    w.clock.set(new Date(WINDOWS.snf.getTime() + 60_000));
    await relogin(a);
    // K can't be filled (the only Monday kicker is burned)...
    expect(codes(await review(a, { qb: null, rb1: null, rb2: null, wr1: null, wr2: null, wr3: null, te: 'teGB', flex: null, k: 'kDET' }))).toEqual(['k:PLAYER_BURNED_OR_UNAVAILABLE']);
    // ...so he leaves it empty and still locks in his Monday tight end.
    const res = await submitLineup(w, a, { qb: null, rb1: null, rb2: null, wr1: null, wr2: null, wr3: null, te: 'teGB', flex: null, k: null });
    expect(res.status).toBe(200);
    expect(res.body.slots.filter((x: { playerId: string | null }) => x.playerId)).toEqual([expect.objectContaining({ slot: 'te', playerId: 'teGB' })]);
  });

  it('never too late: after Thursday locks, a brand-new manager can still confirm a full lineup from games that haven’t started', async () => {
    await fireLocks(new Date(WINDOWS.tnf.getTime() + 30_000)); // TNF (DEN at KC) is locked
    const late = await account(w);
    // A Thursday player can't be picked any more...
    const tnf = await late.client.post(`/v1/seasons/${SEASON}/weeks/8/lineup/review`, { slots: { ...LINEUP, rb1: 'rbMIA', rb2: 'rbSF', wr1: 'wrKC' } });
    expect(codes(tnf)).toContain('wr1:GAME_WINDOW_LOCKED');
    // ...but every slot can still be filled from Sunday and Monday games.
    const res = await submitLineup(w, late, { qb: 'qbBUF', rb1: 'rbMIA', rb2: 'rbSF', wr1: 'wrBUF', wr2: 'wrDAL', wr3: 'wrPHI', te: 'teSF', flex: 'wrNYG', k: 'kDET' });
    expect(res.status).toBe(200);
  });

  it('ownership counts LOCKED picks only (pre-lock anonymity, T&C §11.2) and stays hidden below the floor', async () => {
    const a = await account(w);
    const b = await account(w);
    const c = await account(w);
    await submitLineup(w, a); // qb, rb1 (rbDEN, Thursday), ... wr3 wrPHI (Sunday)
    await submitLineup(w, b, { ...LINEUP, wr3: 'wrBUF' });
    await submitLineup(w, c, { ...LINEUP, rb1: 'rbMIA', rb2: 'fbSF', wr3: 'wrBUF' });
    const pct = async (floor: number) => {
      w.ctx.config.ownershipMinLineups = floor;
      await w.r.redis.del(`${w.r.namespace}own2:${SEASON}:8`);
      const pool = await a.client.get(`/v1/seasons/${SEASON}/weeks/8/pool`);
      const card = (id: string) => pool.body.players.find((p: { playerId: string }) => p.playerId === id);
      return { rbDEN: card('rbDEN').weekOwnershipPct, wrPHI: card('wrPHI').weekOwnershipPct, wrBUF: card('wrBUF').weekOwnershipPct, rbMIA: card('rbMIA').weekOwnershipPct };
    };

    // Before any lock: every pick is open, so nothing counts, even though all three lineups are confirmed.
    expect(await pct(3)).toEqual({ rbDEN: 0, wrPHI: 0, wrBUF: 0, rbMIA: 0 });

    // Thursday locks: rbDEN (a and b, rb1) counts; Sunday picks (wrPHI, wrBUF) still don't.
    await fireLocks(new Date(WINDOWS.tnf.getTime() + 30_000));
    await relogin(a);
    const after = await pct(3);
    expect(after.rbDEN).toBe(66.7); // 2 of 3 managers
    expect(after).toMatchObject({ wrPHI: 0, wrBUF: 0 });

    // Below the floor (3 managers, floor 4): withheld entirely, so nothing can be inferred.
    expect(await pct(4)).toEqual({ rbDEN: null, wrPHI: null, wrBUF: null, rbMIA: null });
  });
  // ── Free play (decision 2026-10-27) ──────────────────────────────────────
  it('free play: anyone may submit until the paid-entry cutoff week; after that only entrants can', async () => {
    const free = await account(w);
    // No paid pools this season: free all season.
    expect((await free.client.get(`/v1/seasons/${SEASON}/weeks/8/lineup`)).body.eligibility).toEqual({ prizeEligible: false, freePlayThroughWeek: null });

    // A paid pool whose entry closes at the first Week 9 lock → free play runs through Week 8.
    const week9 = new Date('2026-11-06T01:15:00Z');
    await w.t.sql(`INSERT INTO game_windows (week, season, label, scheduled_et, status, msf_game_ids) VALUES (9, $1, 'tnf', $2, 'pending', '{g9}')`, [SEASON, week9]);
    const [{ id: pool }] = await w.t.sql<{ id: string }>(
      `INSERT INTO contest_pools (season, kind, buy_in_cents, name, entry_closes_at) VALUES ($1, 'season_open', 2500, '$25 Open', $2) RETURNING id::text AS id`,
      [SEASON, week9]
    );
    await w.payments.publishPool(pool, { capacity: 10, minEntries: 2 });
    expect((await free.client.get(`/v1/seasons/${SEASON}/weeks/8/lineup`)).body.eligibility).toEqual({ prizeEligible: false, freePlayThroughWeek: 8 });
    expect((await submitLineup(w, free)).status).toBe(200); // Week 8: still free
    const blocked = await free.client.post(`/v1/seasons/${SEASON}/weeks/9/lineup/review`, { slots: LINEUP });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('PAID_ENTRY_REQUIRED');

    // Paying in (an active entry) unblocks it.
    const payer = await account(w);
    await w.t.sql(`INSERT INTO contest_entries (pool_id, user_id, entered_at) VALUES ($1, $2, $3)`, [pool, payer.userId, w.clock.get()]);
    expect((await payer.client.get(`/v1/seasons/${SEASON}/weeks/8/lineup`)).body.eligibility).toEqual({ prizeEligible: true, freePlayThroughWeek: null });
    const allowed = await payer.client.post(`/v1/seasons/${SEASON}/weeks/9/lineup/review`, { slots: LINEUP });
    expect(allowed.body.error).not.toBe('PAID_ENTRY_REQUIRED'); // reaches lineup validation instead
  });

  it('free play: a confirmation reviewed before the cutoff is still checked at Gate 3', async () => {
    const free = await account(w);
    const rev = await free.client.post(`/v1/seasons/${SEASON}/weeks/8/lineup/review`, { slots: LINEUP });
    await free.client.post(`/v1/lineup-confirmations/${rev.body.confirmationId}/acknowledge`, { burnRules: true, permanent: true, noRefund: true });
    // Ops publishes a pool whose cutoff is this week while the user is mid-flow.
    const [{ id: pool }] = await w.t.sql<{ id: string }>(
      `INSERT INTO contest_pools (season, kind, buy_in_cents, name, entry_closes_at) VALUES ($1, 'season_open', 2500, '$25 Open', $2) RETURNING id::text AS id`,
      [SEASON, WINDOWS.tnf]
    );
    await w.payments.publishPool(pool, { capacity: 10, minEntries: 2 });
    expect((await free.client.post(`/v1/lineup-confirmations/${rev.body.confirmationId}/confirm`)).body.error).toBe('PAID_ENTRY_REQUIRED');
  });

  // ── AC12 ──────────────────────────────────────────────────────────────────
  it('AC12: entry over HTTP end to end: publish, verify, checkout, signed webhook, board, payouts scoped to the caller', async () => {
    const admin = await account(w, { totp: true, admin: true });
    await stepUp(w, admin);
    const [{ id: pool }] = await w.t.sql<{ id: string }>(
      `INSERT INTO contest_pools (season, kind, buy_in_cents, name, entry_closes_at) VALUES ($1, 'season_open', 2500, '$25 Open', '2026-11-30T00:00:00Z') RETURNING id::text AS id`,
      [SEASON]
    );
    expect((await admin.client.post(`/v1/admin/pools/${pool}/publish`, { capacity: 10, minEntries: 2 })).body.prizePoolCents).toBe(21250);

    const u = await account(w, { totp: true });
    await admin.client.post('/v1/admin/identity-verifications', { userId: u.userId, providerRef: 'm-1', providerPersonId: 'person-u', birthDate: '1990-05-01', region: 'GA' });
    expect((await u.client.get(`/v1/pools/${pool}/prizes`)).body).toMatchObject({ guaranteedPrizePoolCents: 21250, seatsLeft: 10 });
    await stepUp(w, u);
    const co = await u.client.post(`/v1/pools/${pool}/checkout`, { billingRegion: 'GA' }).set('cf-ipcountry', 'US').set('cf-region-code', 'GA');
    expect(co.status).toBe(201);

    const hook = w.fake.webhook({ type: 'payment_captured', intentId: co.body.intentId, paymentRef: 'pi_http', amountCents: 2500, occurredAt: w.clock.get() });
    const bad = await u.client.agent.post('/v1/webhooks/fake').set('content-type', 'application/json').set('x-fake-signature', '00'.repeat(32)).send(hook.body.toString());
    expect(bad.status).toBe(400);
    const good = await u.client.agent.post('/v1/webhooks/fake').set('content-type', 'application/json').set(hook.headers).send(hook.body.toString());
    expect(good.body).toEqual({ received: true, status: 'processed' });
    expect((await u.client.agent.post('/v1/webhooks/stripe').send('{}')).status).toBe(404); // not the configured processor

    expect((await u.client.get('/v1/pools')).body.pools).toEqual([expect.objectContaining({ id: pool, entered: true, guaranteedPrizePoolCents: 21250 })]);
    const board = await u.client.get(`/v1/pools/${pool}/board`);
    expect(board.status).toBe(200);
    expect(board.body.rows[0]).toMatchObject({ handle: u.handle, isMe: true });
    expect((await u.client.get(`/v1/pools/${pool}/board`).query({ ifVersion: board.body.version })).status).toBe(304);
    const outsider = await account(w);
    expect((await outsider.client.get(`/v1/pools/${pool}/board`)).body.error).toBe('NOT_AN_ENTRANT');

    expect((await u.client.get('/v1/me/payouts')).body).toEqual({ blockedBy: ['BANK_ACCOUNT', 'W9'], awards: [] });
    expect((await outsider.client.get(`/v1/me/payouts/${co.body.intentId}/instant-quote`)).status).toBe(409);
  });

  it('AC12: payout onboarding and instant payout go through the financial gate', async () => {
    const u = await account(w, { totp: true });
    w.clock.advanceMs(6 * 60_000);
    expect((await u.client.post('/v1/me/payout-account/link')).body.error).toBe('STEP_UP_REQUIRED');
    await stepUp(w, u);
    expect((await u.client.post('/v1/me/payout-account/link')).body.error).toBe('IDENTITY_UNVERIFIED');
    expect((await u.client.post('/v1/me/payouts/00000000-0000-0000-0000-000000000001/instant', { confirmedFeeCents: 1 })).body.error).toBe('PAYOUT_NOT_PENDING');
  });

  // ── §11 worker ────────────────────────────────────────────────────────────
  it('§11: worker jobs lock due windows, sync the roster and re-resolve, and skip a job another worker holds', async () => {
    const a = await account(w);
    await submitLineup(w, a);
    const feed = {
      lastUpdatedOn: '2026-10-28T08:00:00Z',
      players: PLAYERS.map(([id, firstName, lastName, pos, team]) => ({
        player: { id, firstName, lastName, primaryPosition: pos, currentTeam: team ? { abbreviation: id === 'wrDAL' ? 'PHI' : team } : null, currentRosterStatus: 'ROSTER', officialImageSrc: 'https://x/y.png' },
      })),
    };
    const calls: string[] = [];
    const msf: MsfFetcher = { async get(path) { calls.push(path); return feed; } };
    const jobs = createJobs({ db: w.t.db, payments: w.payments, msf, season: SEASON, now: w.clock.get, log: silent, apiContext: w.ctx });

    expect(await jobs.run('roster')).toMatchObject({ week: 8, reresolve: { repointed: 1 } });
    expect(calls).toEqual(['players.json']);
    expect((await rows(a.userId)).find((r) => r.slot_key === 'wr2')!.game_window_id).toBe(win.snf);

    w.clock.set(new Date(WINDOWS.tnf.getTime() + 20_000));
    expect(await jobs.run('locks')).toEqual({ windowsLocked: 1 });
    expect((await rows(a.userId)).filter((r) => r.locked_at !== null).map((r) => r.slot_key).sort()).toEqual(['rb1', 'wr1']);
    expect(await jobs.run('payments')).toEqual({ poolsClosed: 0 });

    // Another worker holding the job's advisory lock: this run is skipped.
    const held = w.t.db.transaction(async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('burnout:job:locks'))`);
      expect(await jobs.run('locks')).toBeNull();
    });
    await held;
  });

  it('§11: when the players feed is not in the subscription (403), roster sync falls back to seasonal player stats', async () => {
    const stats = {
      // rbCHI has no stats yet (bye week): absent from this feed, but still rostered.
      playerStatsTotals: PLAYERS.filter(([id]) => id !== 'rbCHI').map(([id, firstName, lastName, pos, team]) => ({ player: { id, firstName, lastName, primaryPosition: pos }, team: team ? { abbreviation: team } : null })),
    };
    const calls: string[] = [];
    const msf: MsfFetcher = {
      async get(path) {
        calls.push(path.split('?')[0]);
        if (path.startsWith('players.json')) throw new MsfHttpError(403, path);
        return stats;
      },
    };
    const jobs = createJobs({ db: w.t.db, payments: w.payments, msf, season: SEASON, now: w.clock.get, log: silent, apiContext: w.ctx });
    expect(await jobs.run('roster')).toMatchObject({ source: 'player_stats_totals', unrostered: 0 });
    expect(calls).toEqual(['players.json', `${SEASON}/player_stats_totals.json`]);
    // The stats feed only lists players with stats, so it must never unroster anyone missing from it.
    const [{ team }] = await w.t.sql<{ team: string | null }>(`SELECT team FROM nfl_players WHERE msf_player_id = 'rbCHI'`);
    expect(team).toBe('CHI');
  });

  it('§11: the scoring job ingests MSF data, burns windows whose games are all Final, and freezes due weeks', async () => {
    const fx = (name: string) => JSON.parse(readFileSync(join(__dirname, '../../../scoring-engine/src/__tests__/fixtures', name), 'utf8'));
    const games = fx('msf-2026-w7-games.json');
    const gamelogs = fx('msf-2026-w7-gamelogs.sample.json');
    const ids: string[] = games.games.map((g: { schedule: { id: number } }) => String(g.schedule.id));
    // The sampled player's game (163650, Final) in its own window; the rest, including the unplayed
    // DAL @ PHI (163654), in another locked window that must NOT burn.
    const [{ id: w7 }] = await w.t.sql<{ id: string }>(
      `INSERT INTO game_windows (week, season, label, scheduled_et, status, msf_game_ids) VALUES (7, $1, 'Sunday Late', '2026-10-25T20:05:00Z', 'locked', $2) RETURNING id::text AS id`,
      [SEASON, ['163650']]
    );
    const [{ id: rest }] = await w.t.sql<{ id: string }>(
      `INSERT INTO game_windows (week, season, label, scheduled_et, status, msf_game_ids) VALUES (7, $1, 'Everything else', '2026-10-23T00:15:00Z', 'locked', $2) RETURNING id::text AS id`,
      [SEASON, ids.filter((id) => id !== '163650')]
    );
    const a = await account(w);
    const playerId = String(gamelogs.gamelogs[0].player.id);
    await w.t.sql(`INSERT INTO pool_entries (user_id, player_id, season) VALUES ($1, $2, $3)`, [a.userId, playerId, SEASON]);
    await w.t.sql(
      `INSERT INTO season_submissions (user_id, week, season, slot_key, player_id, game_window_id, locked_at) VALUES ($1, 7, $2, 'te', $3, $4, '2026-10-23T00:15:30Z')`,
      [a.userId, SEASON, playerId, w7]
    );
    const msf: MsfFetcher = { async get(path) { return path.endsWith('games.json') ? games : gamelogs; } };
    const jobs = createJobs({ db: w.t.db, payments: w.payments, msf, season: SEASON, now: w.clock.get, log: silent, apiContext: w.ctx });
    w.clock.set(new Date('2026-10-28T12:00:00Z'));

    const out = (await jobs.run('scoring')) as { weeks: Array<{ week: number; burns: number }>; weeksFrozen: number[] };
    expect(out.weeks).toEqual([{ week: 7, burns: 1, windowsFinal: 1 }]);
    const [{ status: restStatus }] = await w.t.sql<{ status: string }>(`SELECT status FROM game_windows WHERE id = $1`, [rest]);
    expect(restStatus).toBe('locked'); // one game unplayed: no burn, window stays locked
    const [burn] = await w.t.sql<{ player_id: string }>(`SELECT player_id FROM burn_records WHERE user_id = $1`, [a.userId]);
    expect(burn.player_id).toBe(playerId);
    const [{ teams }] = await w.t.sql<{ teams: number }>(`SELECT count(*)::int AS teams FROM nfl_games WHERE home_team IS NOT NULL AND away_team IS NOT NULL AND week = 7`);
    expect(teams).toBe(ids.length); // PRD-002 ingest now stores teams (§7.2)
    const [{ n }] = await w.t.sql<{ n: number }>(`SELECT count(*)::int AS n FROM user_week_scores WHERE user_id = $1 AND week = 7`, [a.userId]);
    expect(n).toBe(1);
  });

  it('§11: an empty or cut-off MSF response (seen live 2026-10-29) is retried once, then skips only that week; the job keeps going', async () => {
    const fx = (name: string) => readFileSync(join(__dirname, '../../../scoring-engine/src/__tests__/fixtures', name), 'utf8');
    const gamesText = fx('msf-2026-w7-games.json');
    const gamelogsText = fx('msf-2026-w7-gamelogs.sample.json');
    const gamelogs = JSON.parse(gamelogsText);
    const [{ id: w7 }] = await w.t.sql<{ id: string }>(
      `INSERT INTO game_windows (week, season, label, scheduled_et, status, msf_game_ids) VALUES (7, $1, 'Sunday Late', '2026-10-25T20:05:00Z', 'locked', $2) RETURNING id::text AS id`,
      [SEASON, ['163650']]
    );
    await w.t.sql(`INSERT INTO game_windows (week, season, label, scheduled_et, status, msf_game_ids) VALUES (8, $1, 'Thursday Night', '2026-10-30T00:15:00Z', 'locked', '{}')`, [SEASON]);
    const a = await account(w);
    const playerId = String(gamelogs.gamelogs[0].player.id);
    await w.t.sql(`INSERT INTO pool_entries (user_id, player_id, season) VALUES ($1, $2, $3)`, [a.userId, playerId, SEASON]);
    await w.t.sql(
      `INSERT INTO season_submissions (user_id, week, season, slot_key, player_id, game_window_id, locked_at) VALUES ($1, 7, $2, 'te', $3, $4, '2026-10-23T00:15:30Z')`,
      [a.userId, SEASON, playerId, w7]
    );
    // The real fetcher, over a fake network: week 8 always answers 200 with an empty body; week 7's
    // first games read is cut off mid-JSON, then served whole.
    const calls: string[] = [];
    let w7Cut = 1;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      if (String(url).includes('/week/8/')) return new Response('', { status: 200 });
      if (String(url).includes('/week/7/games.json')) return new Response(w7Cut-- > 0 ? gamesText.slice(0, 200) : gamesText, { status: 200 });
      return new Response(gamelogsText, { status: 200 });
    }) as typeof fetch;
    try {
      const logged: Array<[string, string, Record<string, unknown> | undefined]> = [];
      const log = (level: string, msg: string, extra?: Record<string, unknown>) => { logged.push([level, msg, extra]); };
      const jobs = createJobs({ db: w.t.db, payments: w.payments, msf: msfFetcher('https://msf.test/v2.1/pull/nfl', 'secret-key'), season: SEASON, now: w.clock.get, log: log as never, apiContext: w.ctx, msfRetryDelayMs: 0 });
      w.clock.set(new Date('2026-10-30T12:00:00Z'));
      const out = (await jobs.run('scoring')) as { weeks: unknown[] };
      expect(out.weeks).toEqual([{ week: 8, failed: 'MSF bad response' }, { week: 7, burns: 1, windowsFinal: 1 }]);
      expect(calls.filter((c) => c.includes('/week/8/games.json'))).toHaveLength(2); // one retry, then skipped
      expect(calls.filter((c) => c.includes('/week/7/games.json'))).toHaveLength(2); // cut off once, served on retry
      const err = logged.find(([lvl, , x]) => lvl === 'error' && x?.week === 8);
      expect(err?.[2]).toMatchObject({ status: 0, error: expect.stringContaining('empty response') });
      expect(JSON.stringify(logged)).not.toContain('secret-key');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('§11: a refused feed for one week never holds up another week, and a refusal gets one retry', async () => {
    const fx = (name: string) => JSON.parse(readFileSync(join(__dirname, '../../../scoring-engine/src/__tests__/fixtures', name), 'utf8'));
    const games = fx('msf-2026-w7-games.json');
    const gamelogs = fx('msf-2026-w7-gamelogs.sample.json');
    const [{ id: w7 }] = await w.t.sql<{ id: string }>(
      `INSERT INTO game_windows (week, season, label, scheduled_et, status, msf_game_ids) VALUES (7, $1, 'Sunday Late', '2026-10-25T20:05:00Z', 'locked', $2) RETURNING id::text AS id`,
      [SEASON, ['163650']]
    );
    // A newer week whose feed MSF keeps refusing: it's tried first and must not block week 7.
    await w.t.sql(
      `INSERT INTO game_windows (week, season, label, scheduled_et, status, msf_game_ids) VALUES (8, $1, 'Thursday Night', '2026-10-30T00:15:00Z', 'locked', '{}')`,
      [SEASON]
    );
    const a = await account(w);
    const playerId = String(gamelogs.gamelogs[0].player.id);
    await w.t.sql(`INSERT INTO pool_entries (user_id, player_id, season) VALUES ($1, $2, $3)`, [a.userId, playerId, SEASON]);
    await w.t.sql(
      `INSERT INTO season_submissions (user_id, week, season, slot_key, player_id, game_window_id, locked_at) VALUES ($1, 7, $2, 'te', $3, $4, '2026-10-23T00:15:30Z')`,
      [a.userId, SEASON, playerId, w7]
    );
    const calls: string[] = [];
    let w7Refusals = 1; // week 7's first read is refused once (throttling), then served
    const msf: MsfFetcher = {
      async get(path) {
        calls.push(path);
        if (path.includes('/week/8/')) throw new MsfHttpError(403, path);
        if (path.includes('/week/7/games.json') && w7Refusals-- > 0) throw new MsfHttpError(403, path);
        return path.endsWith('games.json') ? games : gamelogs;
      },
    };
    const logged: Array<[string, string, Record<string, unknown> | undefined]> = [];
    const log = (level: string, msg: string, extra?: Record<string, unknown>) => { logged.push([level, msg, extra]); };
    const jobs = createJobs({ db: w.t.db, payments: w.payments, msf, season: SEASON, now: w.clock.get, log: log as never, apiContext: w.ctx, msfRetryDelayMs: 0 });
    w.clock.set(new Date('2026-10-30T12:00:00Z'));

    const out = (await jobs.run('scoring')) as { weeks: unknown[] };
    expect(out.weeks).toEqual([{ week: 8, failed: 'MSF HTTP 403' }, { week: 7, burns: 1, windowsFinal: 1 }]);
    expect(calls.filter((c) => c.includes('/week/8/games.json'))).toHaveLength(2); // one retry, then skipped
    expect(calls.filter((c) => c.includes('/week/7/games.json'))).toHaveLength(2); // refused once, served on retry
    expect(calls.some((c) => c.includes('/week/8/player_gamelogs'))).toBe(false);
    expect(logged.some(([lvl, , x]) => lvl === 'error' && x?.week === 8 && x?.status === 403)).toBe(true);
    const [{ n }] = await w.t.sql<{ n: number }>(`SELECT count(*)::int AS n FROM burn_records WHERE user_id = $1`, [a.userId]);
    expect(n).toBe(1);
  });

  it('§11: a feed error MSF won\'t fix by retrying (404) is not retried and still skips only that week', async () => {
    await w.t.sql(
      `INSERT INTO game_windows (week, season, label, scheduled_et, status, msf_game_ids) VALUES (8, $1, 'Thursday Night', '2026-10-30T00:15:00Z', 'locked', '{}')`,
      [SEASON]
    );
    const calls: string[] = [];
    const msf: MsfFetcher = { async get(path) { calls.push(path); throw new MsfHttpError(404, path); } };
    const jobs = createJobs({ db: w.t.db, payments: w.payments, msf, season: SEASON, now: w.clock.get, log: silent, apiContext: w.ctx, msfRetryDelayMs: 0 });
    w.clock.set(new Date('2026-10-30T12:00:00Z'));
    const out = (await jobs.run('scoring')) as { weeks: unknown[] };
    expect(out.weeks).toEqual([{ week: 8, failed: 'MSF HTTP 404' }]);
    expect(calls).toHaveLength(1);
  });
});
