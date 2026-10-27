/**
 * PRD-006 §14 AC7–AC12 and §11: three-gate lineups, lock races, validation,
 * roster re-resolve, the player pool, payments over HTTP, and the worker —
 * against real Postgres + Redis.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPostgresBurnStore, evaluateAndFireLocks } from '@burnout/burn-engine';
import { describeDbRedis, SEASON } from '@burnout/test-support';
import { createJobs, type MsfFetcher } from '../jobs';
import { lineupChecksum } from '../lineups/service';
import { reresolveSubmissions, syncPlayers } from '../players/roster';
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
    expect(codes(await review(a, { ...LINEUP, rb2: 'fbSF' }))).toEqual(['rb2:PLAYER_BURNED_OR_UNAVAILABLE']); // FB pending Q2
    expect(codes(await review(a, { ...LINEUP, te: null }))).toEqual(['te:SLOT_EMPTY']);
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
    await w.r.redis.del(`${w.r.namespace}own:${SEASON}:8`);
    await relogin(a);

    const pool = await a.client.get(`/v1/seasons/${SEASON}/weeks/8/pool`);
    expect(pool.status).toBe(200);
    const card = (id: string) => pool.body.players.find((p: { playerId: string }) => p.playerId === id);
    expect(card('rbDEN')).toMatchObject({ burnState: 'locked', opponent: 'KC', homeAway: 'home', windowOpen: false, weekOwnershipPct: 100 });
    expect(card('kDET')).toMatchObject({ burnState: 'burned' });
    expect(card('wrPHI')).toMatchObject({ burnState: 'available', weekOwnershipPct: 50, windowOpen: true });
    expect(card('rbCHI')).toMatchObject({ bye: true, opponent: null, scheduledEt: null });
    expect(card('fbSF')).toBeUndefined(); // FB not selectable yet (Q2)
    const keys = new Set(pool.body.players.flatMap((p: object) => Object.keys(p)));
    expect([...keys].filter((k) => /image|photo|headshot|url|src|avatar/i.test(String(k)))).toEqual([]);
    expect(JSON.stringify(pool.body)).not.toMatch(/https?:\/\//);
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
    expect(calls).toEqual([`players.json?season=${SEASON}`]);
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
});
