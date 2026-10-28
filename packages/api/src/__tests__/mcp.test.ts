/**
 * PRD-011 Phase 1a, part 1: the AI connector with personal tokens, against the
 * real app, Postgres and Redis. Acceptance criteria §11.
 */
import request from 'supertest';
import { describeDbRedis, SEASON } from '@burnout/test-support';
import { MAX_ACTIVE_PERSONAL } from '../mcp/credentials';
import { FIELD_FLOOR, readOnly } from '../mcp/tools';
import { account, buildWeek, Client, createWorld, LINEUP, ORIGIN, PASSWORD, stepUp, submitLineup, WINDOWS, type Account, type World } from './harness';

const MODERN = '2026-07-28';
const LEGACY = '2025-11-25';
const META = {
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
};
const TOOLS = ['get_my_pool', 'get_burn_history', 'get_pool_standings', 'get_field_burn_rates'];

/** The body of a JSON or single-event SSE response. */
function rpc(res: request.Response): { result?: Record<string, any>; error?: { code: number; message: string; data?: unknown } } {
  const text = res.text.startsWith('event:') ? /^data: (.*)$/m.exec(res.text)![1] : res.text;
  return JSON.parse(text);
}

describeDbRedis('PRD-011 AI connector, personal tokens (HTTP, Postgres + Redis)', () => {
  let w: World;
  let win: Awaited<ReturnType<typeof buildWeek>>;
  beforeEach(async () => {
    w = await createWorld();
    win = await buildWeek(w);
  });
  afterEach(async () => {
    await w.close();
  });

  const makeToken = async (a: Account, label = 'Claude Code') => {
    await stepUp(w, a);
    const res = await a.client.post('/v1/me/mcp/tokens', { label });
    expect(res.status).toBe(201);
    return res.body as { token: string; credential: { id: string } };
  };
  const post = (token: string | null, body: object, headers: Record<string, string> = {}) => {
    const r = request(w.app).post('/mcp').set('Accept', 'application/json, text/event-stream').set('Content-Type', 'application/json');
    if (token) r.set('Authorization', `Bearer ${token}`);
    return r.set(headers).send(body);
  };
  /** 2026-07-28: the per-request envelope and the mirrored headers. */
  const modern = (token: string, method: string, params: Record<string, unknown> = {}, extra: Record<string, string> = {}) =>
    post(token, { jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: META } }, {
      'MCP-Protocol-Version': MODERN, 'Mcp-Method': method, ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}), ...extra,
    });
  const call = async (token: string, name: string, args: object = {}) => {
    const res = await modern(token, 'tools/call', { name, arguments: args });
    expect(res.status).toBe(200);
    return rpc(res).result!;
  };
  /** Synthetic managers with a locked pick and a recorded burn of one player (week 8, Thursday window). */
  const fieldBurns = async (n: number, playerId: string, opts: { week?: number; windowId?: string } = {}) => {
    const week = opts.week ?? 8;
    for (let i = 0; i < n; i++) {
      const tag = `${playerId}_${week}_${i}_${Math.random().toString(36).slice(2, 7)}`;
      const [u] = await w.t.sql<{ id: string }>(
        `INSERT INTO users (email, password_hash, display_name, handle, email_verified_at, updated_at) VALUES ($1, 'x', $2, $3, now(), now()) RETURNING id::text AS id`,
        [`${tag.toLowerCase()}@example.com`, `Real Name ${i}`, `m${tag}`.slice(0, 20)]
      );
      await burn(u.id, playerId, week, opts.windowId ?? win.tnf, 'rb1');
    }
  };
  const burn = async (userId: string, playerId: string, week: number, windowId: string, slot: string) => {
    // A burn needs the window locked and Final (the database enforces the two-part criterion).
    await w.t.sql(`UPDATE game_windows SET status = 'final' WHERE id = $1 AND status <> 'final'`, [windowId]);
    let [sub] = await w.t.sql<{ id: string }>(`SELECT id::text AS id FROM season_submissions WHERE user_id = $1 AND week = $2 AND slot_key = $3`, [userId, week, slot]);
    if (!sub) {
      [sub] = await w.t.sql<{ id: string }>(
        `INSERT INTO season_submissions (user_id, week, season, slot_key, player_id, game_window_id, submitted_at, locked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id::text AS id`,
        [userId, week, SEASON, slot, playerId, windowId, WINDOWS.tnf]
      );
    } else {
      await w.t.sql(`UPDATE season_submissions SET locked_at = $2 WHERE id = $1`, [sub.id, WINDOWS.tnf]);
    }
    await w.t.sql(
      `INSERT INTO pool_entries (user_id, player_id, season, burned, burned_at) VALUES ($1, $2, $3, true, $4)
       ON CONFLICT (user_id, player_id, season) DO UPDATE SET burned = true, burned_at = EXCLUDED.burned_at`,
      [userId, playerId, SEASON, WINDOWS.tnf]
    );
    await w.t.sql(
      `INSERT INTO burn_records (user_id, player_id, season, week, game_window_id, submission_id, locked_at, burned_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, playerId, SEASON, week, windowId, sub.id, WINDOWS.tnf, new Date(WINDOWS.tnf.getTime() + 4 * 3600_000)]
    );
  };

  it('tokens: a fresh code to create; shown once and stored hashed; at most five; list and revoke; audited', async () => {
    const amy = await account(w, { handle: 'amy' });
    expect((await amy.client.post('/v1/me/mcp/tokens', {})).body.error).toBe('STEP_UP_REQUIRED');
    const t = await makeToken(amy);
    expect(t.token).toMatch(/^bl_mcp_[0-9a-f]{64}$/);
    const [row] = await w.t.sql<{ token_hash: string; expires_at: Date }>(`SELECT token_hash, expires_at FROM mcp_credentials WHERE id = $1`, [t.credential.id]);
    expect(row.token_hash).not.toContain(t.token.slice(7));
    expect(row.expires_at.getTime() - w.clock.get().getTime()).toBe(90 * 86_400_000);

    const list = await amy.client.get('/v1/me/mcp');
    expect(list.body).toMatchObject({ maxTokens: MAX_ACTIVE_PERSONAL, tokens: [{ id: t.credential.id, label: 'Claude Code', lastUsedAt: null }] });
    expect(JSON.stringify(list.body)).not.toContain(t.token);

    for (let i = 1; i < MAX_ACTIVE_PERSONAL; i++) await amy.client.post('/v1/me/mcp/tokens', { label: `t${i}` });
    const sixth = await amy.client.post('/v1/me/mcp/tokens', {});
    expect(sixth.status).toBe(409);
    expect(sixth.body.error).toBe('MCP_TOKEN_LIMIT');

    const bob = await account(w, { handle: 'bob' });
    expect((await bob.client.delete(`/v1/me/mcp/tokens/${t.credential.id}`)).status).toBe(404); // not his
    expect((await amy.client.delete(`/v1/me/mcp/tokens/${t.credential.id}`)).body).toEqual({ revoked: true });
    expect((await amy.client.get('/v1/me/mcp')).body.tokens).toHaveLength(MAX_ACTIVE_PERSONAL - 1);
    const events = await w.t.sql<{ event_type: string }>(`SELECT event_type FROM security_audit_log WHERE event_type LIKE 'MCP_%' ORDER BY performed_at, event_type`);
    expect(events.filter((e) => e.event_type === 'MCP_TOKEN_CREATED')).toHaveLength(MAX_ACTIVE_PERSONAL);
    expect(events.filter((e) => e.event_type === 'MCP_TOKEN_REVOKED')).toHaveLength(1);
  });

  it('both protocol versions, statelessly: a 2025-11-25 initialize and a 2026-07-28 server/discover; tools in a fixed order, read-only, with schemas', async () => {
    const amy = await account(w, { handle: 'amy' });
    const { token } = await makeToken(amy);

    const init = await post(token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: 'old', version: '1' } } });
    expect(init.status).toBe(200);
    expect(init.headers['mcp-session-id']).toBeUndefined(); // no sessions
    expect(rpc(init).result).toMatchObject({ protocolVersion: LEGACY, serverInfo: { name: 'burnout-league' }, capabilities: { tools: {} } });
    const legacyList = await post(token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { 'MCP-Protocol-Version': LEGACY });
    expect(rpc(legacyList).result!.tools.map((t: { name: string }) => t.name)).toEqual(TOOLS);
    const legacyCall = await post(token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_burn_history', arguments: {} } }, { 'MCP-Protocol-Version': LEGACY });
    expect(rpc(legacyCall).result!.structuredContent).toMatchObject({ burns: [], summary: { total_burns: 0 } });

    const disc = await modern(token, 'server/discover');
    expect(disc.status).toBe(200);
    expect(rpc(disc).result).toMatchObject({ resultType: 'complete', supportedVersions: [MODERN], capabilities: { tools: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'burnout-league' } } });
    const list = rpc(await modern(token, 'tools/list')).result!;
    expect(list).toMatchObject({ resultType: 'complete', cacheScope: 'private' });
    expect(list.tools.map((t: { name: string }) => t.name)).toEqual(TOOLS);
    for (const t of list.tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect(t.inputSchema.type).toBe('object');
      expect(t.outputSchema.type).toBe('object');
    }
    const res = await call(token, 'get_burn_history');
    expect(res).toMatchObject({ resultType: 'complete', structuredContent: { season: SEASON, burns: [] } });
    expect(res.content[0]).toMatchObject({ type: 'text' });
    expect(res.content[0].text).toContain('0 burns');
  });

  it('headers must match the body (HeaderMismatch -32020); GET is 405; a foreign Origin is 403', async () => {
    const amy = await account(w);
    const { token } = await makeToken(amy);
    const mismatch = await modern(token, 'tools/call', { name: 'get_burn_history', arguments: {} }, { 'Mcp-Name': 'get_my_pool' });
    expect(mismatch.status).toBe(400);
    expect(rpc(mismatch).error!.code).toBe(-32020);
    const wrongMethod = await modern(token, 'tools/list', {}, { 'Mcp-Method': 'server/discover' });
    expect(rpc(wrongMethod).error!.code).toBe(-32020);
    expect((await request(w.app).get('/mcp').set('Authorization', `Bearer ${token}`)).status).toBe(405);
    expect((await modern(token, 'tools/list', {}, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await modern(token, 'tools/list', {}, { Origin: ORIGIN })).status).toBe(200);
  });

  it('credential boundaries: no token, a session cookie or a session token on /mcp is 401 with WWW-Authenticate; a connector token never works on /v1 and cannot make tokens', async () => {
    const amy = await account(w);
    const { token } = await makeToken(amy);
    const none = await post(null, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(none.status).toBe(401);
    expect(none.headers['www-authenticate']).toMatch(/^Bearer /);
    // The signed-in browser's cookie is ignored on /mcp.
    const cookie = await amy.client.agent.post('/mcp').set('Accept', 'application/json, text/event-stream').send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(cookie.status).toBe(401);
    // A mobile session token is not a connector token.
    const mobile = new Client(w, 'mobile');
    await mobile.post('/v1/auth/login', { email: amy.email, password: PASSWORD, client: 'mobile' }).then((r) => { mobile.token = r.body.token; });
    expect(mobile.token).toBeTruthy();
    expect((await post(mobile.token, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).status).toBe(401);
    // The connector token is nothing on /v1.
    expect((await request(w.app).get('/v1/me').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    expect((await request(w.app).post('/v1/me/mcp/tokens').set('Authorization', `Bearer ${token}`).send({})).status).toBe(401);
  });

  it('expired, revoked, and "signed out everywhere" or a password change: the token stops working', async () => {
    const amy = await account(w);
    const a = await makeToken(amy, 'one');
    const b = await makeToken(amy, 'two');
    expect((await modern(a.token, 'tools/list')).status).toBe(200);
    await amy.client.delete(`/v1/me/mcp/tokens/${a.credential.id}`);
    expect((await modern(a.token, 'tools/list')).status).toBe(401);

    // A password change keeps this browser signed in, but every connector token goes.
    expect((await amy.client.post('/v1/auth/password/change', { currentPassword: PASSWORD, newPassword: 'another long password here' })).status).toBe(200);
    expect((await modern(b.token, 'tools/list')).status).toBe(401);

    const c = await makeToken(amy, 'three');
    expect((await amy.client.post('/v1/auth/logout-all')).status).toBe(200);
    expect((await modern(c.token, 'tools/list')).status).toBe(401);

    const bob = await account(w);
    const d = await makeToken(bob);
    w.clock.advanceMs(90 * 86_400_000 + 1000);
    const expired = await modern(d.token, 'tools/list');
    expect(expired.status).toBe(401);
    expect(expired.headers['www-authenticate']).toMatch(/invalid_token/);
  });

  it('last_used_at is written at most every 5 minutes', async () => {
    const amy = await account(w);
    const { token, credential } = await makeToken(amy);
    const used = async () => (await w.t.sql<{ last_used_at: Date | null }>(`SELECT last_used_at FROM mcp_credentials WHERE id = $1`, [credential.id]))[0].last_used_at;
    await modern(token, 'tools/list');
    const first = await used();
    expect(first).toEqual(w.clock.get());
    w.clock.advanceMs(60_000);
    await modern(token, 'tools/list');
    expect(await used()).toEqual(first);
    w.clock.advanceMs(5 * 60_000);
    await modern(token, 'tools/list');
    expect(await used()).toEqual(w.clock.get());
  });

  it('get_my_pool: available, unavailable (Out, no game, game started), locked, burned; my own lineup including unlocked picks', async () => {
    const amy = await account(w, { handle: 'amy' });
    expect((await submitLineup(w, amy, LINEUP)).status).toBe(200);
    await w.t.sql(`UPDATE nfl_players SET injury_status = 'Out' WHERE msf_player_id = 'teGB'`);
    await burn(amy.userId, 'rbDEN', 8, win.tnf, 'rb1'); // burned Thursday
    await w.t.sql(`UPDATE season_submissions SET locked_at = $2 WHERE user_id = $1 AND slot_key = 'wr1'`, [amy.userId, WINDOWS.tnf]); // wrKC locked, not Final
    w.clock.set(new Date(WINDOWS.tnf.getTime() + 60_000)); // Thursday's game has started
    const { token } = await makeToken(amy);
    const r = (await call(token, 'get_my_pool', { limit: 300 })).structuredContent;
    const ids = (k: string) => r.players[k].map((p: { player_id: string }) => p.player_id).sort();
    expect(ids('burned')).toEqual(['rbDEN']);
    expect(r.players.burned[0]).toMatchObject({ name: 'Ray Dent', position: 'RB', team: 'DEN', burned_week: 8 });
    expect(ids('locked_pending_final')).toEqual(['wrKC']);
    const why = Object.fromEntries(r.players.unavailable.map((p: { player_id: string; reason: string }) => [p.player_id, p.reason]));
    expect(why).toMatchObject({ teGB: 'INACTIVE', rbCHI: 'NO_GAME_THIS_WEEK', qbKC: 'GAME_STARTED' });
    expect(ids('available')).toContain('qbBUF');
    expect(r.summary).toMatchObject({ total_burned: 1, total_locked_pending_final: 1 });
    expect(r.my_lineup_this_week.slots.find((s: { slot: string }) => s.slot === 'qb')).toMatchObject({ player_id: 'qbBUF', locked: false, window: 'early' });
    expect(r.my_lineup_this_week.slots.find((s: { slot: string }) => s.slot === 'wr1')).toMatchObject({ player_id: 'wrKC', locked: true });

    const rbs = (await call(token, 'get_my_pool', { position: 'RB', state: 'available' })).structuredContent;
    expect(Object.keys(rbs.players)).toEqual(['available']);
    expect(rbs.players.available.every((p: { position: string }) => p.position === 'RB')).toBe(true);
    // As of week 7, the week-8 burn hadn't happened.
    expect((await call(token, 'get_my_pool', { week: 7, state: 'burned' })).structuredContent.players.burned).toEqual([]);
  });

  it('get_burn_history: each burn with slot and times; the field start rate only at 50+ managers that week', async () => {
    const amy = await account(w, { handle: 'amy' });
    await submitLineup(w, amy, LINEUP);
    await burn(amy.userId, 'rbDEN', 8, win.tnf, 'rb1');
    const { token } = await makeToken(amy);
    let r = (await call(token, 'get_burn_history')).structuredContent;
    expect(r.burns).toHaveLength(1);
    expect(r.burns[0]).toMatchObject({ player_id: 'rbDEN', name: 'Ray Dent', slot: 'rb1', week: 8, field_start_rate_at_lock: null, field_below_minimum: true, regret_index: null });
    expect(r.burns[0].locked_at).toBe(WINDOWS.tnf.toISOString());
    expect(r.summary).toMatchObject({ total_burns: 1 });

    await fieldBurns(FIELD_FLOOR - 1, 'rbDEN'); // 49 + amy = 50 managers locked that week, all started Ray Dent
    r = (await call(token, 'get_burn_history')).structuredContent;
    expect(r.burns[0]).toMatchObject({ field_start_rate_at_lock: 100, field_below_minimum: false });
    expect((await call(token, 'get_burn_history', { position: 'QB' })).structuredContent.burns).toEqual([]);
  });

  it('get_field_burn_rates: nothing below 50 managers (season or week slice); whole percentages, mine flagged, field size rounded down', async () => {
    const amy = await account(w, { handle: 'amy' });
    const { token } = await makeToken(amy);
    await fieldBurns(30, 'rbDEN');
    let r = (await call(token, 'get_field_burn_rates')).structuredContent;
    expect(r).toEqual({ season: SEASON, scope: 'season', pool_id: null, week: 8, field_below_minimum: true, minimum_field: FIELD_FLOOR });

    await fieldBurns(23, 'wrKC'); // 53 managers in week 8
    r = (await call(token, 'get_field_burn_rates')).structuredContent;
    expect(r).toMatchObject({ field_below_minimum: false, field_size: 50, week: 8 });
    const den = r.players.find((p: { player_id: string }) => p.player_id === 'rbDEN');
    expect(den).toEqual({ player_id: 'rbDEN', name: 'Ray Dent', team: 'DEN', position: 'RB', cumulative_burn_rate: 57, week_burn_rate: 57, i_have_burned: false, i_have_available: true });
    expect(r.players[0].player_id).toBe('rbDEN'); // most burned first
    expect(r.positional_summary.RB).toMatchObject({ avg_burn_rate: 57, most_burned: { player_id: 'rbDEN' } });
    expect((await call(token, 'get_field_burn_rates', { position: 'WR' })).structuredContent.players.map((p: { player_id: string }) => p.player_id)).toEqual(['wrKC']);
    expect((await call(token, 'get_field_burn_rates', { top_n: 1 })).structuredContent.players).toHaveLength(1);
    // Week 7 had no managers: that slice is under the floor even though the season isn't.
    expect((await call(token, 'get_field_burn_rates', { week: 7 })).structuredContent.field_below_minimum).toBe(true);
    // A pool needs a pool you entered.
    const pool = await call(token, 'get_field_burn_rates', { scope: 'pool', pool_id: '00000000-0000-4000-8000-000000000000' });
    expect(pool.isError).toBe(true);
    expect(pool.content[0].text).toContain('haven’t entered');
  });

  it('the floor is exactly 50, applies to the week slice on its own, and unlocked picks never count toward it', async () => {
    const amy = await account(w, { handle: 'amy' });
    const { token } = await makeToken(amy);
    // 49 managers locked and burned in week 8, plus 10 more who only have unlocked picks: still under the floor.
    await fieldBurns(FIELD_FLOOR - 1, 'rbDEN');
    for (let i = 0; i < 10; i++) {
      const [u] = await w.t.sql<{ id: string }>(
        `INSERT INTO users (email, password_hash, display_name, handle, email_verified_at, updated_at) VALUES ($1, 'x', 'x', $2, now(), now()) RETURNING id::text AS id`,
        [`unlocked${i}@example.com`, `unlocked${i}`]
      );
      await w.t.sql(
        `INSERT INTO season_submissions (user_id, week, season, slot_key, player_id, game_window_id, submitted_at) VALUES ($1, 8, $2, 'qb', 'qbBUF', $3, $4)`,
        [u.id, SEASON, win.early, w.clock.get()]
      );
    }
    expect((await call(token, 'get_field_burn_rates')).structuredContent.field_below_minimum).toBe(true);
    await fieldBurns(1, 'rbDEN'); // the 50th
    expect((await call(token, 'get_field_burn_rates')).structuredContent).toMatchObject({ field_below_minimum: false, field_size: 50 });

    // Week 9 has just 3 managers: through week 9 the season field is 53, but the week-9 slice is under the floor.
    const [w9] = await w.t.sql<{ id: string }>(
      `INSERT INTO game_windows (week, season, label, scheduled_et, status, msf_game_ids) VALUES (9, $1, 'w9', $2, 'pending', $3) RETURNING id::text AS id`,
      [SEASON, new Date(WINDOWS.tnf.getTime() + 7 * 86_400_000), ['g-w9']]
    );
    await fieldBurns(3, 'wrKC', { week: 9, windowId: w9.id });
    expect((await call(token, 'get_field_burn_rates', { week: 9 })).structuredContent.field_below_minimum).toBe(true);
    expect((await call(token, 'get_field_burn_rates', { week: 8 })).structuredContent.field_below_minimum).toBe(false);
  });

  it('get_pool_standings: free play with the season field (handles only); a pool you did not enter is an error', async () => {
    const amy = await account(w, { handle: 'amy' });
    const bob = await account(w, { handle: 'bob' });
    await submitLineup(w, amy, LINEUP);
    await submitLineup(w, bob, { ...LINEUP, qb: 'qbKC' });
    await w.t.sql(`UPDATE users SET display_name = 'Amelia Secretname'`);
    const { token } = await makeToken(amy);
    const r = (await call(token, 'get_pool_standings')).structuredContent;
    expect(r).toMatchObject({ free_play: true, pools: [] });
    expect(r.season_field.top.map((x: { handle: string }) => x.handle).sort()).toEqual(['amy', 'bob']);
    expect(r.season_field.top.find((x: { handle: string }) => x.handle === 'amy').is_me).toBe(true);
    const err = await call(token, 'get_pool_standings', { pool_id: '00000000-0000-4000-8000-000000000000' });
    expect(err.isError).toBe(true);
  });

  it('no output carries an email, a real name, an image or another manager’s unlocked pick', async () => {
    const amy = await account(w, { handle: 'amy' });
    const bob = await account(w, { handle: 'bob' });
    await submitLineup(w, amy, LINEUP);
    await submitLineup(w, bob, { ...LINEUP, qb: 'qbKC', k: 'kMIA' }); // bob's picks are unlocked
    await burn(amy.userId, 'rbDEN', 8, win.tnf, 'rb1');
    await fieldBurns(FIELD_FLOOR, 'wrDAL');
    await w.t.sql(`UPDATE users SET display_name = 'Secret Realname'`);
    const { token } = await makeToken(amy);
    for (const name of TOOLS) {
      const res = await call(token, name, {});
      const text = JSON.stringify(res);
      expect(text).not.toMatch(/@example\.com|Secret Realname|Real Name|https?:\/\/|\.png|\.jpg|headshot/i);
      // Bob's unlocked kicker is in nobody else's lineup: only Amy's own pool (where he's simply available) may name him.
      if (name !== 'get_my_pool') expect(text).not.toContain('kMIA');
      else expect(res.structuredContent.my_lineup_this_week.slots.find((x: { slot: string }) => x.slot === 'k').player_id).toBe('kDET');
    }
  });

  it('a handler cannot write: the transaction is READ ONLY', async () => {
    await expect(readOnly(w.ctx, (ro) => ro.db.query(`UPDATE users SET handle = handle`))).rejects.toThrow(/read-only transaction/);
    await expect(readOnly(w.ctx, (ro) => ro.db.query(`INSERT INTO feedback (user_id, screen, body) VALUES (gen_random_uuid(), 'x', 'y')`))).rejects.toThrow(/read-only transaction/);
    expect(await readOnly(w.ctx, async (ro) => (await ro.db.query<{ one: number }>(`SELECT 1 AS one`))[0].one)).toBe(1);
  });

  it('rate limits: per credential per tool (429 with Retry-After) and per user across tokens; other methods are not counted', async () => {
    const amy = await account(w);
    const a = await makeToken(amy, 'a');
    for (let i = 0; i < 30; i++) expect((await modern(a.token, 'tools/call', { name: 'get_pool_standings', arguments: {} })).status).toBe(200);
    const over = await modern(a.token, 'tools/call', { name: 'get_pool_standings', arguments: {} });
    expect(over.status).toBe(429);
    expect(over.headers['retry-after']).toBe('60');
    expect(rpc(over).error).toMatchObject({ data: { retryAfterSeconds: 60 } });
    expect((await modern(a.token, 'tools/call', { name: 'get_burn_history', arguments: {} })).status).toBe(200); // another tool's budget
    expect((await modern(a.token, 'tools/list')).status).toBe(200);

    // 120 a minute per user, whatever the token: 30 + 1 (refused, not counted) + 1 used so far.
    const b = await makeToken(amy, 'b');
    const c = await makeToken(amy, 'c');
    let ok = 0;
    for (const t of [b.token, c.token]) for (let i = 0; i < 60; i++) if ((await modern(t, 'tools/call', { name: 'get_my_pool', arguments: { limit: 1 } })).status === 200) ok++;
    expect(ok).toBe(120 - 31);
  });
});
