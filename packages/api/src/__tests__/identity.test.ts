/**
 * PRD-006 §7.5 / PRD-001 §5.4: one person, one player, whatever IDs the MSF
 * feed sends. The case that prompted it (2026-10-28): Brandon Smith, WR PIT,
 * listed as 30297 and 112299 with the same birth date, so he could be burned
 * under one ID and played again under the other.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeDbRedis, SEASON } from '@burnout/test-support';
import { createJobs, type MsfFetcher } from '../jobs';
import { chooseCanonical, duplicateGroups, normalizeName, normalizeStatLines, resolveIdentities } from '../players/identity';
import type { ParsedPlayer } from '../players/msf-players';
import { parsePlayers } from '../players/msf-players';
import { syncPlayers } from '../players/roster';
import { account, buildWeek, createWorld, LINEUP, PLAYERS, stepUp, submitLineup, type World } from './harness';

const silent = () => {};
const pp = (o: Partial<ParsedPlayer> & { msfPlayerId: string }): ParsedPlayer => ({
  firstName: 'Brandon', lastName: 'Smith', position: 'WR', team: 'PIT', rosterStatus: 'ROSTER', injuryStatus: 'Active', birthDate: null, ...o,
});

// ── units ─────────────────────────────────────────────────────────────────────

describe('PRD-006 §7.5 matching (pure)', () => {
  it('names compare without case, accents, punctuation or suffixes', () => {
    expect(normalizeName('Brian', 'Thomas Jr.')).toBe(normalizeName('brian', 'Thomas'));
    expect(normalizeName('C.J.', 'Board')).toBe(normalizeName('CJ', 'Board'));
    expect(normalizeName('José', "D'Angelo III")).toBe(normalizeName('Jose', 'DAngelo'));
    expect(normalizeName('Brandon', 'Smith')).not.toBe(normalizeName('Brendan', 'Smith'));
  });

  it('the real case: same name and birth date are one person, whatever the jersey', () => {
    const feed = parsePlayers({
      players: [
        { player: { id: 30297, firstName: 'Brandon', lastName: 'Smith', primaryPosition: 'WR', jerseyNumber: 87, birthDate: '1998-12-10', currentTeam: { abbreviation: 'PIT' }, currentRosterStatus: 'ROSTER' } },
        { player: { id: 112299, firstName: 'Brandon', lastName: 'Smith', primaryPosition: 'WR', jerseyNumber: 77, birthDate: '1998-12-10', currentTeam: { abbreviation: 'PIT' }, currentRosterStatus: 'ROSTER' } },
        { player: { id: 47807, firstName: 'Brandon', lastName: 'Smith', primaryPosition: 'LB', birthDate: '1998-04-12', currentTeam: null } },
      ],
    });
    expect(feed.players.map((p) => p.birthDate)).toEqual(['1998-12-10', '1998-12-10']); // the LB isn't a fantasy position
    expect(duplicateGroups(feed.players)).toEqual([{ ids: ['30297', '112299'], review: false }]);
  });

  it('a stale free-agent copy of a rostered player is the same person', () => {
    expect(duplicateGroups([
      pp({ msfPlayerId: '208297', firstName: 'Jackson', lastName: 'Acker', position: 'TE', team: null, rosterStatus: 'UFA', birthDate: '2002-11-15' }),
      pp({ msfPlayerId: '208351', firstName: 'Jackson', lastName: 'Acker', position: 'TE', team: 'SEA', birthDate: '2002-11-15' }),
    ])).toEqual([{ ids: ['208297', '208351'], review: false }]);
  });

  it('different birth dates are never merged, even on the same team at the same position', () => {
    expect(duplicateGroups([pp({ msfPlayerId: '1', birthDate: '1998-12-10' }), pp({ msfPlayerId: '2', birthDate: '1999-01-01' })])).toEqual([]);
  });

  it('a missing birth date merges on name + team + position, for review; never across teams or positions', () => {
    expect(duplicateGroups([pp({ msfPlayerId: '1', birthDate: '1998-12-10' }), pp({ msfPlayerId: '2' })])).toEqual([{ ids: ['1', '2'], review: true }]);
    expect(duplicateGroups([pp({ msfPlayerId: '1' }), pp({ msfPlayerId: '2', team: 'CLE' })])).toEqual([]);
    expect(duplicateGroups([pp({ msfPlayerId: '1' }), pp({ msfPlayerId: '2', position: 'RB' })])).toEqual([]);
    expect(duplicateGroups([pp({ msfPlayerId: '1' }), pp({ msfPlayerId: '2', team: null })])).toEqual([]);
  });

  it('a record without a birth date never bridges two different birth dates', () => {
    const g = duplicateGroups([pp({ msfPlayerId: '1', birthDate: '1998-12-10' }), pp({ msfPlayerId: '2' }), pp({ msfPlayerId: '3', birthDate: '1999-01-01' })]);
    expect(g).toHaveLength(1);
    expect(g[0].ids).toHaveLength(2);
    expect(g[0].ids).toContain('2');
  });

  it('the kept ID: already kept > on a team > has stats > oldest', () => {
    const row = (id: string, o: Partial<{ canonicalId: string | null; team: string | null; statLines: number }> = {}) => ({ id, canonicalId: null, source: null, team: 'PIT', statLines: 0, ...o });
    expect(chooseCanonical([row('112299'), row('30297')])).toBe('30297'); // oldest
    expect(chooseCanonical([row('30297'), row('112299', { statLines: 3 })])).toBe('112299'); // has stats
    expect(chooseCanonical([row('30297', { team: null, statLines: 9 }), row('112299')])).toBe('112299'); // the pickable one
    expect(chooseCanonical([row('30297', { canonicalId: '112299' }), row('112299', { team: null })])).toBe('112299'); // sticky
  });

  it('stats under an alias are scored under the kept ID; the kept ID\'s own line wins a tie', () => {
    const lines = [
      { msfGameId: 'g1', playerId: '112299', week: 8, stats: 'alias' },
      { msfGameId: 'g2', playerId: '112299', week: 8, stats: 'alias-only' },
      { msfGameId: 'g1', playerId: '30297', week: 8, stats: 'kept' },
      { msfGameId: 'g1', playerId: 'other', week: 8, stats: 'other' },
    ];
    const out = normalizeStatLines(lines, new Map([['112299', '30297']]));
    expect(out).toHaveLength(3);
    expect(out.find((l) => l.msfGameId === 'g1' && l.playerId === '30297')!.stats).toBe('kept');
    expect(out.find((l) => l.msfGameId === 'g2')!).toMatchObject({ playerId: '30297', stats: 'alias-only' });
    // Whichever order the feed lists them in.
    const reversed = normalizeStatLines([...lines].reverse(), new Map([['112299', '30297']]));
    expect(reversed.find((l) => l.msfGameId === 'g1' && l.playerId === '30297')!.stats).toBe('kept');
  });
});

// ── database + HTTP ───────────────────────────────────────────────────────────

describeDbRedis('PRD-006 §7.5 one person, one player (Postgres + Redis)', () => {
  let w: World;
  beforeEach(async () => {
    w = await createWorld({ sessionIdleMs: 7 * 24 * 3600_000 });
    await buildWeek(w);
  });
  afterEach(async () => {
    await w.close();
  });

  // The harness world plus Brandon Smith twice, on KC (Thursday window, Week 8).
  const roster = (extra: ParsedPlayer[] = []): ParsedPlayer[] => [
    ...PLAYERS.map(([msfPlayerId, firstName, lastName, position, team]) => ({ msfPlayerId, firstName, lastName, position, team, rosterStatus: 'ROSTER', injuryStatus: 'Active' as const, birthDate: null })),
    pp({ msfPlayerId: '30297', team: 'KC', birthDate: '1998-12-10' }),
    pp({ msfPlayerId: '112299', team: 'KC', birthDate: '1998-12-10' }),
    ...extra,
  ];
  const sync = async (players = roster()) => {
    await syncPlayers(w.ctx, players, { complete: true });
    return resolveIdentities(w.ctx, players);
  };
  const ident = async (id: string) =>
    (await w.t.sql<{ canonical_id: string | null; identity_source: string | null; identity_review: boolean }>(`SELECT canonical_id, identity_source, identity_review FROM nfl_players WHERE msf_player_id = $1`, [id]))[0];
  const poolIds = async (client: { get: (u: string) => Promise<{ body: { players: Array<{ playerId: string; unavailableReason: string | null }> } }> }) =>
    (await client.get(`/v1/seasons/${SEASON}/weeks/8/pool`)).body.players;

  it('the duplicate becomes an alias of the older ID; the picker shows one card; an alias can\'t be submitted', async () => {
    await syncPlayers(w.ctx, roster(), { complete: true });
    const a = await account(w);
    expect((await poolIds(a.client)).filter((p) => ['30297', '112299'].includes(p.playerId))).toHaveLength(2); // the bug, before

    expect(await resolveIdentities(w.ctx, roster())).toMatchObject({ groups: 1, merged: 1, review: 0 });
    expect(await ident('112299')).toEqual({ canonical_id: '30297', identity_source: 'auto', identity_review: false });
    expect(await ident('30297')).toMatchObject({ canonical_id: null });
    expect((await poolIds(a.client)).filter((p) => ['30297', '112299'].includes(p.playerId)).map((p) => p.playerId)).toEqual(['30297']);

    const res = await a.client.post(`/v1/seasons/${SEASON}/weeks/8/lineup/review`, { slots: { ...LINEUP, wr1: '112299' } });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([expect.objectContaining({ slot: 'wr1', code: 'PLAYER_BURNED_OR_UNAVAILABLE' })]);
    expect((await a.client.post(`/v1/seasons/${SEASON}/weeks/8/lineup/review`, { slots: { ...LINEUP, wr1: '30297' } })).status).toBe(201);
    const [{ n }] = await w.t.sql<{ n: number }>(`SELECT count(*)::int AS n FROM security_audit_log WHERE event_type = 'PLAYER_MERGED' AND metadata->>'alias' = '112299'`);
    expect(n).toBe(1);
    // The birth date matched them, but it is never stored: no column for it, and not in the audit entry.
    const cols = await w.t.sql<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'nfl_players'`);
    expect(cols.map((c) => c.column_name).filter((c) => /birth|dob/i.test(c))).toEqual([]);
    const meta = await w.t.sql<{ m: string }>(`SELECT metadata::text AS m FROM security_audit_log WHERE event_type = 'PLAYER_MERGED'`);
    expect(meta.map((r) => r.m).join()).not.toContain('1998-12-10');
  });

  it('the database refuses a lineup row naming an alias, but leaves existing rows alone', async () => {
    await sync();
    const a = await account(w);
    const [{ id: win }] = await w.t.sql<{ id: string }>(`SELECT id::text AS id FROM game_windows WHERE label = 'tnf'`);
    await expect(
      w.t.sql(`INSERT INTO season_submissions (user_id, week, season, slot_key, player_id, game_window_id) VALUES ($1, 8, $2, 'wr1', '112299', $3)`, [a.userId, SEASON, win])
    ).rejects.toThrow(/PLAYER_ALIAS/);
    const [{ id: sub }] = await w.t.sql<{ id: string }>(
      `INSERT INTO season_submissions (user_id, week, season, slot_key, player_id, game_window_id) VALUES ($1, 8, $2, 'wr1', '30297', $3) RETURNING id::text AS id`,
      [a.userId, SEASON, win]
    );
    await expect(w.t.sql(`UPDATE season_submissions SET player_id = '112299' WHERE id = $1`, [sub])).rejects.toThrow(/PLAYER_ALIAS/);
    // No chains: an alias can't be pointed at, and a kept ID can't become an alias while others point at it.
    await expect(w.t.sql(`UPDATE nfl_players SET canonical_id = '112299' WHERE msf_player_id = 'wrKC'`)).rejects.toThrow(/PLAYER_IDENTITY/);
    await expect(w.t.sql(`UPDATE nfl_players SET canonical_id = 'wrKC' WHERE msf_player_id = '30297'`)).rejects.toThrow(/PLAYER_IDENTITY/);
  });

  it('burns follow the person: burned under the alias means burned, full stop', async () => {
    await syncPlayers(w.ctx, roster(), { complete: true });
    const a = await account(w);
    // Burned under 112299 before the merge (pool entry as the burn engine writes it).
    await w.t.sql(`INSERT INTO pool_entries (user_id, player_id, season, burned, burned_at) VALUES ($1, '112299', $2, true, now())`, [a.userId, SEASON]);
    expect((await poolIds(a.client)).find((p) => p.playerId === '30297')!.unavailableReason).toBeNull(); // the bug, before
    await resolveIdentities(w.ctx, roster());
    expect((await poolIds(a.client)).find((p) => p.playerId === '30297')!.unavailableReason).toBe('BURNED');
    const res = await a.client.post(`/v1/seasons/${SEASON}/weeks/8/lineup/review`, { slots: { ...LINEUP, wr1: '30297' } });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([expect.objectContaining({ slot: 'wr1', code: 'PLAYER_BURNED_OR_UNAVAILABLE' })]);
    // Another manager is unaffected.
    const b = await account(w);
    expect((await poolIds(b.client)).find((p) => p.playerId === '30297')!.unavailableReason).toBeNull();
  });

  it('open picks on the alias move to the kept ID; one already in the lineup twice is voided and the manager told', async () => {
    await syncPlayers(w.ctx, roster(), { complete: true });
    const both = await account(w); // the exploit: the same person at WR1 and FLEX
    expect((await submitLineup(w, both, { ...LINEUP, wr1: '112299', flex: '30297' })).status).toBe(200);
    const one = await account(w);
    expect((await submitLineup(w, one, { ...LINEUP, wr1: '112299' })).status).toBe(200);

    expect(await resolveIdentities(w.ctx, roster())).toMatchObject({ merged: 1, repointed: 1, voided: 1 });
    const slot = async (userId: string, s: string) =>
      (await w.t.sql<{ player_id: string; void_reason: string | null }>(`SELECT player_id, void_reason FROM season_submissions WHERE user_id = $1 AND slot_key = $2`, [userId, s]))[0];
    expect(await slot(both.userId, 'wr1')).toEqual({ player_id: '112299', void_reason: 'PLAYER_MERGED' });
    expect(await slot(both.userId, 'flex')).toEqual({ player_id: '30297', void_reason: null });
    expect(await slot(one.userId, 'wr1')).toEqual({ player_id: '30297', void_reason: null });
    const [note] = await w.t.sql<{ payload: { slot: string; reason: string; alsoIn: string } }>(`SELECT payload FROM notification_queue WHERE user_id = $1 AND kind = 'SUBMISSION_VOIDED'`, [both.userId]);
    expect(note.payload).toMatchObject({ slot: 'wr1', reason: 'PLAYER_MERGED', alsoIn: 'flex' });
    // The voided slot is open again in the API's lineup view.
    const view = (await both.client.get(`/v1/seasons/${SEASON}/weeks/8/lineup`)).body.slots.find((s: { slot: string }) => s.slot === 'wr1');
    expect(view).toMatchObject({ voidReason: 'PLAYER_MERGED' });
  });

  it('the kept ID never moves on its own; an admin decision is left alone by later syncs', async () => {
    await sync();
    // The alias later gets more stats than the kept ID: still kept as it was.
    await w.t.sql(`UPDATE nfl_players SET team = NULL WHERE msf_player_id = '30297'`);
    expect(await sync()).toMatchObject({ merged: 0 });
    expect(await ident('112299')).toMatchObject({ canonical_id: '30297' });

    const admin = await account(w, { admin: true });
    await stepUp(w, admin);
    const split = await admin.client.post('/v1/admin/players/112299/identity', { canonicalId: null, reason: 'Two different people per team roster' });
    expect(split.status).toBe(200);
    expect(await ident('112299')).toEqual({ canonical_id: null, identity_source: 'manual', identity_review: false });
    expect(await sync()).toMatchObject({ merged: 0 });
    expect(await ident('112299')).toMatchObject({ canonical_id: null });
  });

  it('admin: list merges and the review list; merge by hand; refuse chains and self; admin + step-up only', async () => {
    // A no-birth-date duplicate on the same team and position: merged for review.
    await sync(roster([pp({ msfPlayerId: 'kDET2', firstName: 'Kip', lastName: 'Det', position: 'K', team: 'DET' })]));
    expect(await ident('kDET2')).toEqual({ canonical_id: 'kDET', identity_source: 'auto', identity_review: true });

    const plain = await account(w);
    expect((await plain.client.get('/v1/admin/players/identities')).status).toBe(403);
    const admin = await account(w, { admin: true });
    expect((await admin.client.get('/v1/admin/players/identities')).body.error).toBe('STEP_UP_REQUIRED');
    await stepUp(w, admin);
    const list = await admin.client.get('/v1/admin/players/identities');
    expect(list.status).toBe(200);
    expect(list.body.needsReview).toBe(1);
    const smith = list.body.groups.find((g: { player: { id: string } }) => g.player.id === '30297');
    expect(smith.aliases).toEqual([expect.objectContaining({ id: '112299', source: 'auto', review: false })]);

    // Confirming the review: same answer, now manual.
    expect((await admin.client.post('/v1/admin/players/kDET2/identity', { canonicalId: 'kDET', reason: 'Checked: same kicker' })).status).toBe(200);
    expect(await ident('kDET2')).toEqual({ canonical_id: 'kDET', identity_source: 'manual', identity_review: false });
    expect((await admin.client.post('/v1/admin/players/wrKC/identity', { canonicalId: '112299', reason: 'nope' })).body.error).toBe('IDENTITY_CHAIN');
    expect((await admin.client.post('/v1/admin/players/wrKC/identity', { canonicalId: 'wrKC', reason: 'nope' })).body.error).toBe('IDENTITY_SELF');
    expect((await admin.client.post('/v1/admin/players/30297/identity', { canonicalId: null, reason: 'nope' })).body.error).toBe('IDENTITY_HAS_ALIASES');
    expect((await admin.client.post('/v1/admin/players/nobody/identity', { canonicalId: null, reason: 'nope' })).status).toBe(404);
    expect((await plain.client.post('/v1/admin/players/wrKC/identity', { canonicalId: null, reason: 'nope' })).status).toBe(403);
    const [{ n }] = await w.t.sql<{ n: number }>(`SELECT count(*)::int AS n FROM security_audit_log WHERE event_type = 'ADMIN_ACTION' AND metadata->>'playerId' = 'kDET2'`);
    expect(n).toBe(1);
  });

  it('the roster job applies identity; the scoring job scores an alias\'s stats under the kept ID', async () => {
    // Roster job end to end with the duplicate in the feed.
    const feed = {
      players: roster().map((p) => ({ player: { id: p.msfPlayerId, firstName: p.firstName, lastName: p.lastName, primaryPosition: p.position, currentTeam: p.team ? { abbreviation: p.team } : null, currentRosterStatus: 'ROSTER', birthDate: p.birthDate ?? undefined } })),
    };
    const fx = (name: string) => JSON.parse(readFileSync(join(__dirname, '../../../scoring-engine/src/__tests__/fixtures', name), 'utf8'));
    const games = fx('msf-2026-w7-games.json');
    const gamelogs = fx('msf-2026-w7-gamelogs.sample.json');
    const msf: MsfFetcher = { async get(path) { return path === 'players.json' ? feed : path.endsWith('games.json') ? games : gamelogs; } };
    const jobs = createJobs({ db: w.t.db, payments: w.payments, msf, season: SEASON, now: w.clock.get, log: silent, apiContext: w.ctx });
    expect(await jobs.run('roster')).toMatchObject({ identity: { merged: 1 } });

    // The feed posts the sampled player's stats under an ID that we hold as an alias.
    const statsId = String(gamelogs.gamelogs[0].player.id);
    await w.t.sql(`INSERT INTO nfl_players (msf_player_id, first_name, last_name, position, team, injury_status, updated_at) VALUES ('kept-1', 'Kept', 'Player', 'TE', 'KC', 'Active', now())`);
    await w.t.sql(`INSERT INTO nfl_players (msf_player_id, first_name, last_name, position, team, injury_status, updated_at, canonical_id) VALUES ($1, 'Kept', 'Player', 'TE', 'KC', 'Active', now(), 'kept-1')`, [statsId]);
    const [{ id: w7 }] = await w.t.sql<{ id: string }>(
      `INSERT INTO game_windows (week, season, label, scheduled_et, status, msf_game_ids) VALUES (7, $1, 'Sunday Late', '2026-10-25T20:05:00Z', 'locked', $2) RETURNING id::text AS id`,
      [SEASON, ['163650']]
    );
    const ids: string[] = games.games.map((g: { schedule: { id: number } }) => String(g.schedule.id));
    await w.t.sql(`INSERT INTO game_windows (week, season, label, scheduled_et, status, msf_game_ids) VALUES (7, $1, 'Rest', '2026-10-23T00:15:00Z', 'locked', $2)`, [SEASON, ids.filter((x) => x !== '163650')]);
    const a = await account(w);
    await w.t.sql(`INSERT INTO pool_entries (user_id, player_id, season) VALUES ($1, 'kept-1', $2)`, [a.userId, SEASON]);
    await w.t.sql(`INSERT INTO season_submissions (user_id, week, season, slot_key, player_id, game_window_id, locked_at) VALUES ($1, 7, $2, 'te', 'kept-1', $3, '2026-10-25T20:05:30Z')`, [a.userId, SEASON, w7]);
    w.clock.set(new Date('2026-10-28T12:00:00Z'));
    await jobs.run('scoring');

    const scores = await w.t.sql<{ player_id: string; points_x100: number }>(`SELECT player_id, points_x100 FROM player_game_scores WHERE msf_game_id = '163650'`);
    expect(scores.map((s) => s.player_id)).toEqual(['kept-1']); // never under the alias
    const [uws] = await w.t.sql<{ points_x100: number }>(`SELECT points_x100 FROM user_week_scores WHERE user_id = $1 AND week = 7`, [a.userId]);
    expect(uws.points_x100).toBe(scores[0].points_x100);
    const [burn] = await w.t.sql<{ player_id: string }>(`SELECT player_id FROM burn_records WHERE user_id = $1`, [a.userId]);
    expect(burn.player_id).toBe('kept-1');
  });
});
