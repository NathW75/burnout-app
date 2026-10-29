/**
 * Invite-only sign-up (PRD-006 §6.10, decided 2026-10-28): per-person,
 * single-use codes, optional email lock, admin create/list/revoke.
 */
import { describeDbRedis } from '@burnout/test-support';
import { newInviteCode, normalizeInviteCode } from '../auth/invites';
import { account, Client, createWorld, PASSWORD, stepUp, tokenFromLink, type Account, type World } from './harness';

describeDbRedis('PRD-006 §6.10 invite-only sign-up (HTTP, Postgres + Redis)', () => {
  let w: World;
  let admin: Account;
  beforeEach(async () => {
    w = await createWorld({ signupInviteOnly: true });
    // The first admin predates the gate.
    w.ctx.config.signupInviteOnly = false;
    admin = await account(w, { handle: 'boss', admin: true });
    w.ctx.config.signupInviteOnly = true;
    await stepUp(w, admin);
  });
  afterEach(async () => {
    await w.close();
  });

  const invite = async (b: object = {}) => {
    const res = await admin.client.post('/v1/admin/invites', b);
    expect(res.status).toBe(201);
    return res.body as { id: string; code: string; link: string; email: string | null; expiresAt: string | null };
  };
  const signup = (email: string, handle: string, inviteCode?: string) =>
    new Client(w).post('/v1/auth/signup', { email, password: PASSWORD, handle, ...(inviteCode !== undefined ? { inviteCode } : {}) });
  const userCount = async () => (await w.t.sql<{ n: number }>(`SELECT count(*)::int AS n FROM users`))[0].n;

  it('the form learns it needs a code; no code, junk or an unknown code is refused and creates nothing', async () => {
    expect((await new Client(w).get('/v1/auth/signup-config')).body).toEqual({ inviteOnly: true });
    const before = await userCount();
    for (const code of [undefined, '', 'nope', 'AAAAA-AAAAA']) {
      const res = await signup('new@example.com', 'newbie', code);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVITE_INVALID');
    }
    expect(await userCount()).toBe(before);
    expect(w.mailer.last('verify_email', 'new@example.com')).toBeUndefined();
  });

  it('a valid code signs you up, sends the verification email, and is spent: it never works twice', async () => {
    const inv = await invite({ note: 'my brother' });
    expect(inv.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(inv.link).toBe(`https://burnoutfantasy.com/signup?invite=${inv.code}`);
    expect(new Date(inv.expiresAt!).getTime() - w.clock.get().getTime()).toBe(14 * 86_400_000); // default 14 days

    expect((await signup('bro@example.com', 'bro', ` ${inv.code.toLowerCase().replace('-', ' ')} `)).status).toBe(202);
    expect(w.mailer.last('verify_email', 'bro@example.com')).toBeDefined();
    expect((await signup('other@example.com', 'other', inv.code)).body.error).toBe('INVITE_INVALID');

    const list = (await admin.client.get('/v1/admin/invites')).body;
    expect(list.inviteOnly).toBe(true);
    expect(list.invites[0]).toMatchObject({ id: inv.id, status: 'used', usedBy: 'bro', note: 'my brother' });
    expect(JSON.stringify(list)).not.toContain(inv.code); // codes are shown once, at creation
    const [{ code_hash }] = await w.t.sql<{ code_hash: string }>(`SELECT code_hash FROM invite_codes WHERE id = $1`, [inv.id]);
    expect(code_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a code tied to an email works only for that address (any case)', async () => {
    const inv = await invite({ email: 'Cousin@Example.com' });
    expect(inv.email).toBe('cousin@example.com');
    expect((await signup('someone@example.com', 'someone', inv.code)).body.error).toBe('INVITE_INVALID');
    expect((await signup('COUSIN@example.com', 'cousin', inv.code)).status).toBe(202);
  });

  it('expired and revoked codes are refused; revoking a used code is a 404', async () => {
    const short = await invite({ expiresInDays: 1 });
    w.clock.advanceMs(86_400_000 + 1000);
    expect((await signup('late@example.com', 'late', short.code)).body.error).toBe('INVITE_INVALID');

    await stepUp(w, admin);
    const r = await invite({});
    expect((await admin.client.post(`/v1/admin/invites/${r.id}/revoke`)).body).toEqual({ revoked: true });
    expect((await signup('rev@example.com', 'revd', r.code)).body.error).toBe('INVITE_INVALID');

    const u = await invite({});
    expect((await signup('used@example.com', 'used1', u.code)).status).toBe(202);
    expect((await admin.client.post(`/v1/admin/invites/${u.id}/revoke`)).status).toBe(404);
    const statuses = (await admin.client.get('/v1/admin/invites')).body.invites.map((i: { status: string }) => i.status).sort();
    expect(statuses).toEqual(['expired', 'revoked', 'used']);
  });

  it('an email that already has an account gets the usual "you already have one" email and the code is not spent', async () => {
    const inv = await invite();
    expect((await signup(admin.email, 'boss2', inv.code)).status).toBe(202);
    expect(w.mailer.last('account_exists', admin.email)).toBeDefined();
    expect((await admin.client.get('/v1/admin/invites')).body.invites[0].status).toBe('active');
  });

  it('two sign-ups racing for one code: exactly one account', async () => {
    const inv = await invite();
    const before = await userCount();
    const results = await Promise.all([signup('r1@example.com', 'racer1', inv.code), signup('r2@example.com', 'racer2', inv.code)]);
    expect(results.map((r) => r.status).sort()).toEqual([202, 400]);
    expect(await userCount()).toBe(before + 1);
  });

  it('only an admin with a fresh code can make, list or revoke invites; it is audited', async () => {
    w.ctx.config.signupInviteOnly = false;
    const pat = await account(w, { handle: 'pat' });
    w.ctx.config.signupInviteOnly = true;
    expect((await pat.client.post('/v1/admin/invites', {})).status).toBe(403);
    expect((await pat.client.get('/v1/admin/invites')).status).toBe(403);
    w.clock.advanceMs(10 * 60_000); // step-up expires
    expect((await admin.client.post('/v1/admin/invites', {})).body.error).toBe('STEP_UP_REQUIRED');
    await stepUp(w, admin);
    expect((await admin.client.post('/v1/admin/invites', { expiresInDays: 365 })).status).toBe(400);
    expect((await admin.client.post('/v1/admin/invites', { email: 'not-an-email' })).status).toBe(400);
    await invite({ email: 'x@example.com' });
    const [{ n }] = await w.t.sql<{ n: number }>(`SELECT count(*)::int AS n FROM security_audit_log WHERE event_type = 'ADMIN_ACTION' AND metadata->>'action' = 'INVITE_CREATED'`);
    expect(n).toBe(1);
  });

  it('send: emails the code and its sign-up link to their address, once; the emailed code signs them up', async () => {
    const res = await admin.client.post('/v1/admin/invites', { email: 'Sam@Example.com', note: 'Sam', send: true });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: 'sam@example.com', emailed: true });
    const mails = w.mailer.sent.filter((m) => m.template === 'invite');
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: 'sam@example.com', data: { code: res.body.code, link: res.body.link } });
    expect(mails[0].data.expires).toMatch(/ ET$/);
    // The email carries a working code: it signs Sam up.
    expect((await signup('sam@example.com', 'sam_tester', mails[0].data.code)).status).toBe(202);
    expect(await userCount()).toBe(2);
    const [{ n }] = await w.t.sql<{ n: number }>(`SELECT count(*)::int AS n FROM security_audit_log WHERE metadata->>'action' = 'INVITE_EMAILED'`);
    expect(n).toBe(1);
  });

  it('send needs an email; without send nothing is emailed; a failed send keeps the invite so the admin can pass it on', async () => {
    const noEmail = await admin.client.post('/v1/admin/invites', { send: true });
    expect(noEmail.status).toBe(400);
    expect(noEmail.body.error).toBe('VALIDATION');
    const quiet = await invite({ email: 'quiet@example.com' });
    expect(quiet).not.toHaveProperty('emailed');
    expect(w.mailer.sent.filter((m) => m.template === 'invite')).toHaveLength(0);

    w.mailer.failSend = new Error('SendGrid send failed: 503');
    const res = await admin.client.post('/v1/admin/invites', { email: 'pat@example.com', send: true });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ emailed: false, email: 'pat@example.com' });
    expect(res.body.code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    w.mailer.failSend = null;
    expect((await signup('pat@example.com', 'pat_tester', res.body.code)).status).toBe(202); // still usable
    const [{ n }] = await w.t.sql<{ n: number }>(`SELECT count(*)::int AS n FROM security_audit_log WHERE metadata->>'action' = 'INVITE_EMAIL_FAILED'`);
    expect(n).toBe(1);
  });

  it('the invite email says nothing financial (staging and testing, Nath 2026-10-28)', async () => {
    await admin.client.post('/v1/admin/invites', { email: 'lee@example.com', send: true });
    const m = w.mailer.sent.find((x) => x.template === 'invite')!;
    const { renderForTest } = await import('../mailer');
    expect(renderForTest(m)).not.toMatch(/\b(prizes?|refunds?|payments?|paid|money|cash|payouts?|winnings|entry fees?|free play)\b|\$\s?\d/i);
    expect(renderForTest(m)).toContain(m.data.link);
  });

  it('with the gate off, sign-up ignores codes entirely', async () => {
    w.ctx.config.signupInviteOnly = false;
    expect((await new Client(w).get('/v1/auth/signup-config')).body).toEqual({ inviteOnly: false });
    expect((await signup('open@example.com', 'opener')).status).toBe(202);
    const v = await new Client(w).post('/v1/auth/verify-email', { token: tokenFromLink(w.mailer.last('verify_email', 'open@example.com')!.data.link) });
    expect(v.status).toBe(200);
  });

  it('codes: 10 unambiguous characters, forgiving to type', () => {
    const seen = new Set(Array.from({ length: 200 }, newInviteCode));
    expect(seen.size).toBe(200);
    for (const c of seen) expect(c).not.toMatch(/[ILOU]/);
    expect(normalizeInviteCode('7kx2m-qw9td')).toBe('7KX2MQW9TD');
    expect(normalizeInviteCode('O1LI 0')).toBe('01110');
  });
});
