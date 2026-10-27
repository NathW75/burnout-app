/**
 * PRD-006 §14 AC1–AC6, AC13–AC16: accounts, sessions, second factors,
 * step-up, CSRF, admin, audit and secrets — over HTTP against real
 * Postgres + Redis.
 */
import { totp } from '../auth/totp';
import { sha256Hex } from '../auth/crypto';
import { describeDbRedis, SEASON } from '@burnout/test-support';
import { account, Client, createWorld, login, nextCode, ORIGIN, PASSWORD, stepUp, tokenFromLink, type World } from './harness';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describeDbRedis('PRD-006 auth (HTTP, Postgres + Redis)', () => {
  let w: World;
  beforeEach(async () => {
    w = await createWorld();
  });
  afterEach(async () => {
    await w.close();
  });

  const audits = async (event: string, userId?: string) =>
    (await w.t.sql<{ n: number }>(`SELECT count(*)::int AS n FROM security_audit_log WHERE event_type = $1 AND ($2::uuid IS NULL OR user_id = $2::uuid)`, [event, userId ?? null]))[0].n;

  // ── AC1 ───────────────────────────────────────────────────────────────────
  it('AC1: signup answers 202 either way, hashes with bcrypt, enforces password length and handle uniqueness', async () => {
    const c = new Client(w);
    const first = await c.post('/v1/auth/signup', { email: 'Nath@Example.com', password: PASSWORD, handle: 'nath_w' });
    expect(first.status).toBe(202);
    const [u] = await w.t.sql<{ email: string; password_hash: string; handle: string }>(`SELECT email, password_hash, handle FROM users`);
    expect(u.email).toBe('nath@example.com');
    expect(u.password_hash).toMatch(/^\$2[aby]\$04\$/); // bcrypt (cost 4 in tests, 12 in production)
    expect(u.password_hash).not.toContain(PASSWORD);
    expect(u.handle).toBe('nath_w');
    expect(w.mailer.last('verify_email', 'nath@example.com')).toBeDefined();

    const dup = await c.post('/v1/auth/signup', { email: 'nath@example.com', password: 'another long password', handle: 'other_handle' });
    expect(dup.status).toBe(first.status);
    expect(dup.body).toEqual(first.body); // no enumeration
    expect(w.mailer.last('account_exists', 'nath@example.com')).toBeDefined();
    expect(await w.t.sql(`SELECT 1 FROM users`)).toHaveLength(1);

    expect((await c.post('/v1/auth/signup', { email: 'short@example.com', password: 'tooshort', handle: 'shorty' })).body.error).toBe('WEAK_PASSWORD');
    expect((await c.post('/v1/auth/signup', { email: 'x@example.com', password: PASSWORD, handle: 'NATH_W' })).status).toBe(409);
    expect((await c.post('/v1/auth/signup', { email: 'y@example.com', password: PASSWORD, handle: 'burnout_admin' })).body.error).toBe('HANDLE_RESERVED_WORD');
    expect((await c.post('/v1/auth/signup', { email: 'not-an-email', password: PASSWORD, handle: 'zed' })).body.error).toBe('VALIDATION');
  });

  it('AC1: email verification links work once and expire', async () => {
    const c = new Client(w);
    await c.post('/v1/auth/signup', { email: 'v@example.com', password: PASSWORD, handle: 'verifier' });
    const token = tokenFromLink(w.mailer.last('verify_email')!.data.link);
    expect((await c.post('/v1/auth/verify-email', { token })).status).toBe(200);
    expect((await c.post('/v1/auth/verify-email', { token })).body.error).toBe('TOKEN_INVALID');
    await c.post('/v1/auth/signup', { email: 'v2@example.com', password: PASSWORD, handle: 'verifier2' });
    const late = tokenFromLink(w.mailer.last('verify_email', 'v2@example.com')!.data.link);
    w.clock.advanceMs(49 * HOUR);
    expect((await c.post('/v1/auth/verify-email', { token: late })).body.error).toBe('TOKEN_INVALID');
    const [row] = await w.t.sql<{ token_hash: string }>(`SELECT token_hash FROM auth_tokens LIMIT 1`);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/); // only the hash is stored
  });

  // ── AC2 ───────────────────────────────────────────────────────────────────
  it('AC2: wrong password and unknown email look the same; the 6th failure for an email is rate-limited', async () => {
    const a = await account(w, { handle: 'limited' });
    const c = new Client(w);
    const wrong = await login(c, a.email, 'wrong password!!');
    const unknown = await login(c, 'nobody@example.com', 'wrong password!!');
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect(wrong.body).toEqual(unknown.body);
    for (let i = 0; i < 4; i++) await login(new Client(w), a.email, 'wrong password!!'); // different IPs
    const blocked = await login(new Client(w), a.email, PASSWORD); // right password, still blocked
    expect(blocked.status).toBe(429);
    expect(await audits('LOGIN_FAILED', a.userId)).toBe(5);
  });

  it('AC2: one IP is limited to 20 failures across emails', async () => {
    const c = new Client(w);
    for (let i = 0; i < 20; i++) expect((await login(c, `u${i}@example.com`, 'wrong password!!')).status).toBe(401);
    expect((await login(c, 'u99@example.com', 'wrong password!!')).status).toBe(429);
  });

  // ── AC3 ───────────────────────────────────────────────────────────────────
  it('AC3: logout invalidates the session on the next request, even with the Redis cache warm', async () => {
    const a = await account(w);
    expect((await a.client.get('/v1/me')).status).toBe(200);
    expect(await w.r.redis.keys(`${w.r.namespace}sess:*`)).toHaveLength(1); // cached
    expect((await a.client.post('/v1/auth/logout')).status).toBe(200);
    expect((await a.client.get('/v1/me')).status).toBe(401);
    expect(await audits('LOGOUT', a.userId)).toBe(1);
  });

  it('AC3: logout-all, password change and password reset revoke the right sessions', async () => {
    const a = await account(w, { kind: 'mobile' });
    const second = new Client(w, 'mobile');
    await login(second, a.email);
    const third = new Client(w, 'web');
    await login(third, a.email);
    for (const c of [a.client, second, third]) expect((await c.get('/v1/me')).status).toBe(200);

    // Password change: every other session dies, this one lives.
    const ch = await a.client.post('/v1/auth/password/change', { currentPassword: PASSWORD, newPassword: 'a brand new long password' });
    expect(ch.status).toBe(200);
    expect((await a.client.get('/v1/me')).status).toBe(200);
    expect((await second.get('/v1/me')).status).toBe(401);
    expect((await third.get('/v1/me')).status).toBe(401);
    expect((await login(new Client(w), a.email, PASSWORD)).status).toBe(401);

    // Logout-all.
    const again = new Client(w, 'mobile');
    await login(again, a.email, 'a brand new long password');
    await a.client.post('/v1/auth/logout-all');
    expect((await a.client.get('/v1/me')).status).toBe(401);
    expect((await again.get('/v1/me')).status).toBe(401);

    // Reset: request is silent for unknown emails; the link revokes everything.
    const c = new Client(w, 'mobile');
    await login(c, a.email, 'a brand new long password');
    expect((await c.post('/v1/auth/password/reset-request', { email: 'nobody@example.com' })).status).toBe(202);
    expect(w.mailer.last('password_reset', 'nobody@example.com')).toBeUndefined();
    await c.post('/v1/auth/password/reset-request', { email: a.email });
    const token = tokenFromLink(w.mailer.last('password_reset', a.email)!.data.link);
    expect((await c.post('/v1/auth/password/reset', { token, newPassword: 'third password, quite long' })).status).toBe(200);
    expect((await c.get('/v1/me')).status).toBe(401);
    expect((await c.post('/v1/auth/password/reset', { token, newPassword: 'fourth password, quite long' })).body.error).toBe('TOKEN_INVALID');
    expect((await login(new Client(w), a.email, 'third password, quite long')).status).toBe(200);
  });

  it('AC3: 24 h idle and 30-day hard expiry; listing and deleting sessions', async () => {
    const a = await account(w);
    w.clock.advanceMs(23 * HOUR);
    expect((await a.client.get('/v1/me')).status).toBe(200); // touches last_seen_at
    w.clock.advanceMs(23 * HOUR);
    expect((await a.client.get('/v1/me')).status).toBe(200);
    w.clock.advanceMs(24 * HOUR + MIN);
    expect((await a.client.get('/v1/me')).status).toBe(401); // idle

    // Active every 20 h (never idle) until just short of 30 days, then just past it.
    const b = await account(w);
    const born = w.clock.get().getTime();
    while (w.clock.get().getTime() + 20 * HOUR < born + 30 * DAY) {
      w.clock.advanceMs(20 * HOUR);
      expect((await b.client.get('/v1/me')).status).toBe(200);
    }
    w.clock.set(new Date(born + 30 * DAY + MIN)); // < 24 h since last request: only the hard limit applies
    expect((await b.client.get('/v1/me')).status).toBe(401);

    const c = await account(w);
    const other = new Client(w);
    await login(other, c.email);
    const list = await c.client.get('/v1/me/sessions');
    expect(list.body.sessions).toHaveLength(2);
    const target = list.body.sessions.find((s: { current: boolean }) => !s.current);
    expect((await c.client.del(`/v1/me/sessions/${target.id}`)).status).toBe(200);
    expect((await other.get('/v1/me')).status).toBe(401);
    expect((await other.del(`/v1/me/sessions/${list.body.sessions[0].id}`)).status).toBe(401);
  });

  // ── AC4 ───────────────────────────────────────────────────────────────────
  it('AC4: TOTP enrolment needs the password, returns 10 backup codes, then sign-in needs the second factor', async () => {
    const a = await account(w, { handle: 'twofa' });
    expect((await a.client.post('/v1/auth/mfa/totp/setup', { password: 'wrong password!!' })).status).toBe(401);
    const setup = await a.client.post('/v1/auth/mfa/totp/setup', { password: PASSWORD });
    expect(setup.body.otpauthUrl).toContain(`secret=${setup.body.secret}`);
    expect((await a.client.post('/v1/auth/mfa/totp/confirm', { code: '000000' })).status).toBe(401);
    const conf = await a.client.post('/v1/auth/mfa/totp/confirm', { code: totp(setup.body.secret, w.clock.get()) });
    expect(conf.body.backupCodes).toHaveLength(10);
    expect(new Set(conf.body.backupCodes).size).toBe(10);

    const [f] = await w.t.sql<{ secret_ciphertext: string }>(`SELECT secret_ciphertext FROM auth_factors WHERE confirmed_at IS NOT NULL`);
    expect(f.secret_ciphertext).not.toContain(setup.body.secret); // encrypted at rest
    const [codes] = await w.t.sql<{ hashes: string }>(`SELECT string_agg(code_hash, ',') AS hashes FROM backup_codes`);
    for (const code of conf.body.backupCodes) expect(codes.hashes).not.toContain(code);

    const c = new Client(w, 'mobile');
    const res = await login(c, a.email);
    expect(res.body.mfaRequired).toBe(true);
    expect((await c.get('/v1/me')).status).toBe(401); // pending session can't do anything else
    const code = nextCode(w, { ...a, totpSecret: setup.body.secret });
    expect((await c.post('/v1/auth/login/mfa', { code })).status).toBe(200);
    expect((await c.get('/v1/me')).body).toMatchObject({ mfaEnrolled: true, email: a.email });
    // The same code can't be used again (replay), not even for step-up.
    expect((await c.post('/v1/auth/step-up', { code })).status).toBe(401);
    expect(await audits('TOTP_ENROLLED', a.userId)).toBe(1);
  });

  it('AC4: five wrong codes revoke a pending session; backup codes work once', async () => {
    const a = await account(w, { totp: true });
    const c = new Client(w, 'mobile');
    await login(c, a.email);
    for (let i = 0; i < 5; i++) expect((await c.post('/v1/auth/login/mfa', { code: '000000' })).status).toBe(401);
    expect((await c.post('/v1/auth/login/mfa', { code: nextCode(w, a) })).status).toBe(401); // session is gone

    const d = new Client(w, 'mobile');
    await login(d, a.email);
    const backup = a.backupCodes![0];
    expect((await d.post('/v1/auth/login/mfa', { code: backup.toLowerCase().replace('-', ' ') })).status).toBe(200);
    const e = new Client(w, 'mobile');
    await login(e, a.email);
    expect((await e.post('/v1/auth/login/mfa', { code: backup })).status).toBe(401);
    expect(await audits('BACKUP_CODE_USED', a.userId)).toBe(1);
  });

  it('AC4: replacing a factor or regenerating backup codes needs step-up', async () => {
    const a = await account(w, { totp: true });
    w.clock.advanceMs(6 * MIN); // the MFA-at-enrolment step-up has lapsed
    expect((await a.client.post('/v1/auth/mfa/totp/setup', { password: PASSWORD })).body.error).toBe('STEP_UP_REQUIRED');
    expect((await a.client.post('/v1/auth/mfa/backup-codes/regenerate')).body.error).toBe('STEP_UP_REQUIRED');
    await stepUp(w, a);
    const regen = await a.client.post('/v1/auth/mfa/backup-codes/regenerate');
    expect(regen.body.backupCodes).toHaveLength(10);
    const c = new Client(w, 'mobile');
    await login(c, a.email);
    expect((await c.post('/v1/auth/login/mfa', { code: a.backupCodes![1] })).status).toBe(401); // old codes revoked
  });

  // ── AC5 ───────────────────────────────────────────────────────────────────
  it('AC5: financial routes need a verified email, then an enrolled factor, then a fresh step-up', async () => {
    const pool = (await w.t.sql<{ id: string }>(
      `INSERT INTO contest_pools (season, kind, buy_in_cents, name, entry_closes_at) VALUES ($1, 'season_open', 2500, '$25', '2026-11-30T00:00:00Z') RETURNING id::text AS id`,
      [SEASON]
    ))[0].id;
    const route = `/v1/pools/${pool}/checkout`;
    const req = { billingRegion: 'GA' };

    const unverified = await account(w, { verify: false });
    expect((await unverified.client.post(route, req)).body.error).toBe('EMAIL_UNVERIFIED');

    const noFactor = await account(w);
    expect((await noFactor.client.post(route, req)).body.error).toBe('MFA_ENROLLMENT_REQUIRED');
    expect((await noFactor.client.post('/v1/auth/step-up', { code: '123456' })).body.error).toBe('MFA_ENROLLMENT_REQUIRED');

    const full = await account(w, { totp: true });
    w.clock.advanceMs(6 * MIN);
    expect((await full.client.post(route, req)).body.error).toBe('STEP_UP_REQUIRED');
    await stepUp(w, full);
    const gated = await full.client.post(route, req);
    expect(gated.status).not.toBe(403); // passed the API gates; PRD-004 decides the rest
    expect(gated.body.error).toBe('ENTRY_CLOSED'); // draft pool
    expect((await full.client.post('/v1/auth/mfa/backup-codes/regenerate')).status).toBe(200); // API-only step-up route
    w.clock.advanceMs(5 * MIN + 1000);
    expect((await full.client.post(route, req)).body.error).toBe('STEP_UP_REQUIRED'); // lapsed
    expect((await full.client.post('/v1/auth/mfa/backup-codes/regenerate')).body.error).toBe('STEP_UP_REQUIRED');
    expect((await full.client.get('/v1/me')).body.stepUpUntil).toBeNull();
    expect(await audits('STEP_UP', full.userId)).toBe(1);
  });

  it('AC5: step-up codes are rate-limited', async () => {
    const a = await account(w, { totp: true });
    for (let i = 0; i < 5; i++) expect((await a.client.post('/v1/auth/step-up', { code: '000000' })).status).toBe(401);
    expect((await a.client.post('/v1/auth/step-up', { code: nextCode(w, a) })).status).toBe(429);
    expect(await audits('STEP_UP_FAILED', a.userId)).toBe(5);
  });

  // ── AC6 ───────────────────────────────────────────────────────────────────
  it('AC6: cookie state changes need the CSRF header and an allowed Origin; bearer requests are exempt', async () => {
    const a = await account(w);
    const withoutHeader = await a.client.agent.post('/v1/auth/logout-all').set('X-Forwarded-For', a.client.ip);
    expect(withoutHeader.status).toBe(403);
    expect(withoutHeader.body.error).toBe('CSRF');
    const evil = await a.client.agent.post('/v1/auth/logout-all').set('X-Forwarded-For', a.client.ip).set('X-Burnout-CSRF', '1').set('Origin', 'https://evil.example');
    expect(evil.body.error).toBe('CSRF');
    expect((await a.client.get('/v1/me')).status).toBe(200); // nothing was revoked
    const good = await a.client.agent.post('/v1/auth/logout').set('X-Forwarded-For', a.client.ip).set('X-Burnout-CSRF', '1').set('Origin', ORIGIN);
    expect(good.status).toBe(200);

    const m = await account(w, { kind: 'mobile' });
    const bearer = await m.client.agent.post('/v1/auth/logout').set('Authorization', `Bearer ${m.client.token}`).set('X-Forwarded-For', m.client.ip);
    expect(bearer.status).toBe(200);
  });

  it('AC6: the web session cookie is httpOnly and SameSite=Lax; the token is never in a web response body', async () => {
    const c = new Client(w);
    await c.post('/v1/auth/signup', { email: 'cookie@example.com', password: PASSWORD, handle: 'cookie_monster' });
    const res = await c.post('/v1/auth/login', { email: 'cookie@example.com', password: PASSWORD, client: 'web' });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/bl_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(res.body).toEqual({ mfaRequired: false });
  });

  // ── AC13 ──────────────────────────────────────────────────────────────────
  it('AC13: admin routes need the admin role and step-up', async () => {
    const user = await account(w, { totp: true });
    expect((await user.client.get('/v1/admin/integrity')).body.error).toBe('FORBIDDEN');
    const admin = await account(w, { totp: true, admin: true });
    // A role change takes effect for the next request (cache invalidated by re-login in the harness).
    w.clock.advanceMs(6 * MIN);
    expect((await admin.client.get('/v1/admin/integrity')).body.error).toBe('STEP_UP_REQUIRED');
    await stepUp(w, admin);
    expect((await admin.client.get('/v1/admin/integrity')).body).toEqual({ ok: true, failures: [] });

    // Suspension: the user's sessions die at once.
    const victim = await account(w);
    expect((await admin.client.post(`/v1/admin/users/${victim.userId}/suspend`, { reason: 'collusion review' })).status).toBe(200);
    expect((await victim.client.get('/v1/me')).status).toBe(401);
    expect((await login(new Client(w), victim.email)).status).toBe(401);
  });

  // ── AC14 ──────────────────────────────────────────────────────────────────
  it('AC14: auth events are audited and the audit log is append-only', async () => {
    const a = await account(w, { totp: true });
    await login(new Client(w), a.email, 'nope nope nope nope');
    await stepUp(w, a);
    expect(await audits('LOGIN', a.userId)).toBe(1);
    expect(await audits('LOGIN_FAILED', a.userId)).toBe(1);
    expect(await audits('TOTP_ENROLLED', a.userId)).toBe(1);
    expect(await audits('STEP_UP', a.userId)).toBe(1);
    expect(await audits('EMAIL_VERIFIED', a.userId)).toBe(1);
    await expect(w.t.sql(`UPDATE security_audit_log SET event_type = 'X'`)).rejects.toThrow(/APPEND_ONLY/);
    await expect(w.t.sql(`DELETE FROM security_audit_log`)).rejects.toThrow(/APPEND_ONLY/);
  });

  // ── AC15 ──────────────────────────────────────────────────────────────────
  it('AC15: no password hash, factor secret or session token appears in responses or logs', async () => {
    const a = await account(w, { totp: true, kind: 'mobile' });
    const me = await a.client.get('/v1/me');
    expect(Object.keys(me.body).sort()).toEqual(['email', 'emailVerified', 'handle', 'id', 'mfaEnrolled', 'role', 'stepUpUntil']);
    const sessions = await a.client.get('/v1/me/sessions');
    const [{ password_hash }] = await w.t.sql<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [a.userId]);
    const blob = JSON.stringify([me.body, sessions.body, w.logs]);
    expect(blob).not.toContain(password_hash);
    expect(blob).not.toContain(a.totpSecret!);
    expect(blob).not.toContain(a.client.token!);
    expect(blob).not.toContain(sha256Hex(a.client.token!));
    expect(blob).not.toContain(PASSWORD);
    const [{ n }] = await w.t.sql<{ n: number }>(`SELECT count(*)::int AS n FROM sessions WHERE token_hash = $1`, [sha256Hex(a.client.token!)]);
    expect(n).toBe(1); // only the hash is stored
  });

  // ── AC16 ──────────────────────────────────────────────────────────────────
  it('AC16: checkout geolocation comes from the edge headers; missing or non-US is blocked', async () => {
    const admin = await account(w, { totp: true, admin: true });
    await stepUp(w, admin);
    const [{ id: pool }] = await w.t.sql<{ id: string }>(
      `INSERT INTO contest_pools (season, kind, buy_in_cents, name, entry_closes_at) VALUES ($1, 'season_open', 2500, '$25 Open', '2026-11-30T00:00:00Z') RETURNING id::text AS id`,
      [SEASON]
    );
    expect((await admin.client.post(`/v1/admin/pools/${pool}/publish`, { capacity: 10, minEntries: 2 })).status).toBe(200);
    const u = await account(w, { totp: true });
    expect((await admin.client.post('/v1/admin/identity-verifications', { userId: u.userId, providerRef: 'manual-1', providerPersonId: 'person-1', birthDate: '1990-01-01', region: 'GA' })).status).toBe(201);
    await stepUp(w, u);
    const route = `/v1/pools/${pool}/checkout`;
    expect((await u.client.post(route, { billingRegion: 'GA' })).body.error).toBe('JURISDICTION_BLOCKED');
    expect((await u.client.post(route, { billingRegion: 'GA' }).set('cf-ipcountry', 'CA').set('cf-region-code', 'ON')).body.error).toBe('JURISDICTION_BLOCKED');
    const ok = await u.client.post(route, { billingRegion: 'GA' }).set('cf-ipcountry', 'US').set('cf-region-code', 'GA');
    expect(ok.status).toBe(201);
    expect(ok.body.checkoutUrl).toMatch(/^https:\/\/checkout\.fake\.test\//);
    expect((await u.client.post(route, { billingRegion: 'GA', successUrl: 'https://evil.example/x' }).set('cf-ipcountry', 'US').set('cf-region-code', 'GA')).body.error).toBe('VALIDATION');
  });
});
