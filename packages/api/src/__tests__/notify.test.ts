/**
 * PRD-008 Phase 1: the email sender against Postgres, with the real lock and
 * burn engines writing the notices.
 */
import { createPostgresBurnStore, evaluateAndCommitBurns, evaluateAndFireLocks } from '@burnout/burn-engine';
import { describeDbRedis, SEASON } from '@burnout/test-support';
import { MailSendError } from '../mailer';
import { DEFAULT_NOTIFY_CONFIG, runNotify, skipReason, type NotifyConfig } from '../notify/dispatcher';
import { renderEmail } from '../notify/templates';
import { unsubscribeToken, verifyUnsubscribeToken } from '../notify/unsubscribe';
import { account, buildWeek, Client, createWorld, LINEUP, submitLineup, WINDOWS, type Account, type World } from './harness';

const silent = () => {};
const CFG: NotifyConfig = { ...DEFAULT_NOTIFY_CONFIG, apiBaseUrl: 'https://api.example.test' };

describeDbRedis('PRD-008 email notifications (Postgres + Redis)', () => {
  let w: World;
  let win: Awaited<ReturnType<typeof buildWeek>>;
  beforeEach(async () => {
    w = await createWorld({ sessionIdleMs: 7 * 24 * 3600_000 });
    win = await buildWeek(w);
  });
  afterEach(async () => {
    await w.close();
  });

  const burnDeps = () => ({ ...createPostgresBurnStore(w.t.db), getServerTime: w.clock.get, log: silent });
  const lockThursday = async () => {
    w.clock.set(new Date(WINDOWS.tnf.getTime() + 30_000));
    await evaluateAndFireLocks(burnDeps());
  };
  const confirmed = async (a: Account) => expect((await submitLineup(w, a, LINEUP)).status).toBe(200);
  const later = (ms: number) => w.clock.set(new Date(w.clock.get().getTime() + ms));
  const run = (cfg: NotifyConfig = CFG) => runNotify(w.ctx, cfg);
  const rows = (userId: string) =>
    w.t.sql<{ kind: string; dispatch_result: string | null; dispatched_at: Date | null; dispatch_attempts: number; dispatch_next_at: Date | null }>(
      `SELECT kind, dispatch_result, dispatched_at, dispatch_attempts, dispatch_next_at FROM notification_queue WHERE user_id = $1 ORDER BY created_at`,
      [userId]
    );
  /** The engines stamp notices with the database clock; these tests move the app clock, so line them up. */
  const stamp = (kind: string, at: Date) => w.t.sql(`UPDATE notification_queue SET created_at = $2 WHERE kind = $1`, [kind, at]);
  const results = async (userId: string) => Object.fromEntries((await w.t.sql<{ kind: string; dispatch_result: string | null }>(
    `SELECT kind, dispatch_result FROM notification_queue WHERE user_id = $1`, [userId])).map((r) => [r.kind, r.dispatch_result]));
  const note = (userId: string, kind: string, payload: object, createdAt: Date) =>
    w.t.sql(`INSERT INTO notification_queue (user_id, kind, payload, created_at) VALUES ($1, $2, $3, $4)`, [userId, kind, payload, createdAt]);

  it('lock + receipt for one user: one email, the lock first; nothing before the window; marked sent', async () => {
    const amy = await account(w, { handle: 'amy' });
    w.clock.set(new Date(WINDOWS.tnf.getTime() - 60_000)); // confirm a minute before Thursday's lock
    await confirmed(amy);
    await lockThursday();
    await stamp('LINEUP_RECEIPT', new Date(WINDOWS.tnf.getTime() - 60_000));
    await stamp('LOCK', w.clock.get());

    expect((await run()).sent).toBe(0); // receipt is 90 s old, lock 0 s: inside the window
    expect(w.mailer.notices).toHaveLength(0);

    later(2 * 60_000);
    const r = await run();
    expect(r).toMatchObject({ users: 1, sent: 1, noticesSent: 2, failed: 0 });
    expect(w.mailer.notices).toHaveLength(1);
    const m = w.mailer.notices[0];
    expect(m.to).toBe(amy.email);
    expect(m.subject).toBe('Locked: tnf · 2 players (+1 more)');
    expect(m.text).toContain('RB1: Ray Dent (RB, DEN)');
    expect(m.text).toContain('WR1: Wes Kay (WR, KC)');
    expect(m.text).toMatch(/Locked Thu, Oct 29, 8:15 PM ET/);
    expect(m.text).toContain('See this week: https://burnoutfantasy.com/');
    expect(m.text).toContain('WEEK 8 LINEUP CONFIRMED');
    expect(m.text.indexOf('TNF LOCKED')).toBeLessThan(m.text.indexOf('WEEK 8 LINEUP CONFIRMED'));
    expect(m.unsubscribeUrl).toMatch(/^https:\/\/api\.example\.test\/v1\/notifications\/unsubscribe\?token=/);
    expect(m.text).toContain('https://burnoutfantasy.com/unsubscribe?token=');
    expect(m.html).toContain('tnf locked');
    expect(m.html).not.toMatch(/<img|<script/i);
    expect(m.noticeIds).toHaveLength(2);

    const rs = await rows(amy.userId);
    expect(rs.map((x) => x.dispatch_result)).toEqual(['sent', 'sent']);
    expect(rs.every((x) => x.dispatched_at)).toBe(true);
    expect((await run()).sent).toBe(0); // never twice
  });

  it('a voided pick skips the wait and links to the builder; nothing about other managers appears', async () => {
    const amy = await account(w, { handle: 'amy' });
    const bob = await account(w, { handle: 'bob' });
    await note(amy.userId, 'SUBMISSION_VOIDED', { season: SEASON, week: 8, slot: 'rb1', playerId: 'rbDEN', playerName: 'Ray Dent', reason: 'PLAYER_INACTIVE', injuryStatus: 'Out' }, w.clock.get());
    await note(bob.userId, 'LOCK', { windowLabel: 'tnf', week: 8, players: [{ playerId: 'qbBUF', slotKey: 'qb' }] }, w.clock.get());
    const r = await run();
    expect(r.sent).toBe(1); // bob's lock still waits; amy's void goes now
    const m = w.mailer.notices[0];
    expect(m.to).toBe(amy.email);
    expect(m.subject).toBe('Action needed: your RB1 is open (Ray Dent)');
    expect(m.text).toContain('Ray Dent (RB, DEN) was voided: he was listed Out before his lock. He isn\'t burned.');
    expect(m.text).toContain('Fill the slot: https://burnoutfantasy.com/lineup');
    expect(m.text).not.toContain('Quade');
    expect(m.text).not.toMatch(/bob/i);
  });

  it('a burn names the players with slot and points, and links to the burned roster', async () => {
    const amy = await account(w, { handle: 'amy' });
    await confirmed(amy);
    await lockThursday();
    await w.t.sql(`UPDATE nfl_games SET is_final = true, played_status = 'COMPLETED' WHERE msf_game_id = 'g-tnf'`);
    w.clock.set(new Date(WINDOWS.tnf.getTime() + 4 * 3600_000));
    await evaluateAndCommitBurns({ gameWindowId: win.tnf, finalMsfGameIds: ['g-tnf'] }, burnDeps());
    await w.t.sql(`UPDATE notification_queue SET dispatched_at = now(), dispatch_result = 'sent' WHERE kind <> 'BURN'`);
    await stamp('BURN', w.clock.get());
    later(3 * 60_000);
    await run();
    const m = w.mailer.notices.at(-1)!;
    expect(m.subject).toBe('Burned: Ray Dent and Wes Kay');
    expect(m.text).toContain('RB1: Ray Dent (RB, DEN)');
    expect(m.text).toContain('WR1: Wes Kay (WR, KC)');
    expect(m.text).toContain('Burned roster: https://burnoutfantasy.com/burned');
    expect(m.text).toContain('They’re gone for the rest of the season.');
  });

  it('too late: a notice over 6 hours old is never emailed (payment notices: 24 hours)', async () => {
    const amy = await account(w);
    const now = w.clock.get();
    await note(amy.userId, 'LOCK', { windowLabel: 'tnf', week: 8, players: [] }, new Date(now.getTime() - 7 * 3600_000));
    await note(amy.userId, 'ENTRY_RECEIPT', {}, new Date(now.getTime() - 20 * 3600_000));
    await note(amy.userId, 'REFUND', {}, new Date(now.getTime() - 25 * 3600_000));
    const r = await run();
    expect(r.skipped).toEqual({ stale: 2 });
    expect(w.mailer.notices).toHaveLength(1);
    expect(w.mailer.notices[0].subject).toBe('Entry confirmed');
    expect(await results(amy.userId)).toEqual({ LOCK: 'skipped:stale', ENTRY_RECEIPT: 'sent', REFUND: 'skipped:stale' });
  });

  it('preferences: defaults on; turning a group off skips it; "nothing optional" skips all but required mail; the API validates', async () => {
    const amy = await account(w);
    const get = await amy.client.get('/v1/me/notification-preferences');
    expect(get.body).toEqual({ emailNotifications: 'on', email: { locks_burns: true, lineup_changes: true, receipts: true } });
    const put = await amy.client.put('/v1/me/notification-preferences', { email: { locks_burns: false } });
    expect(put.body.email).toEqual({ locks_burns: false, lineup_changes: true, receipts: true });

    const old = new Date(w.clock.get().getTime() - 5 * 60_000);
    await note(amy.userId, 'LOCK', { windowLabel: 'tnf', week: 8, players: [] }, old);
    await note(amy.userId, 'SLOT_REOPENED', { slotKey: 'rb1', playerId: 'rbDEN', week: 8 }, old);
    await run();
    expect(await results(amy.userId)).toEqual({ LOCK: 'skipped:preference', SLOT_REOPENED: 'sent' });

    expect((await amy.client.put('/v1/me/notification-preferences', { emailNotifications: 'off' })).body.emailNotifications).toBe('off');
    await note(amy.userId, 'LINEUP_RECEIPT', { week: 8 }, old);
    await note(amy.userId, 'PAYOUT_SENT', {}, old);
    w.mailer.notices.length = 0;
    await run();
    expect(w.mailer.notices.map((m) => m.subject)).toEqual(['Payout sent']);
    expect(await results(amy.userId)).toMatchObject({ LINEUP_RECEIPT: 'skipped:unsubscribed', PAYOUT_SENT: 'sent' });

    expect((await amy.client.put('/v1/me/notification-preferences', { email: { everything: false } })).status).toBe(400);
    expect((await amy.client.put('/v1/me/notification-preferences', { emailNotifications: 'maybe' })).status).toBe(400);
    expect((await new Client(w).get('/v1/me/notification-preferences')).status).toBe(401);
  });

  it('one-click unsubscribe: no session needed, the signed token turns optional email off; forged or junk tokens are refused', async () => {
    const amy = await account(w);
    const token = unsubscribeToken(w.ctx.notifyKey, amy.userId);
    expect(verifyUnsubscribeToken(w.ctx.notifyKey, token)).toBe(amy.userId);
    const anon = new Client(w);
    // Mail providers POST a form body with no cookie and no CSRF header (RFC 8058).
    const res = await anon.agent.post(`/v1/notifications/unsubscribe?token=${token}`).type('form').send('List-Unsubscribe=One-Click');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unsubscribed: true });
    expect((await amy.client.get('/v1/me/notification-preferences')).body.emailNotifications).toBe('off');

    const forged = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
    expect((await anon.agent.post(`/v1/notifications/unsubscribe?token=${forged}`)).status).toBe(400);
    expect((await anon.agent.post('/v1/notifications/unsubscribe?token=nope')).status).toBe(400);
    expect((await anon.agent.post('/v1/notifications/unsubscribe')).status).toBe(400);
    const otherKey = Buffer.alloc(32, 7);
    expect(verifyUnsubscribeToken(otherKey, token)).toBeNull();
  });

  it('accounts that can\'t receive mail are skipped: unverified or suspended', async () => {
    const amy = await account(w);
    const bob = await account(w);
    await w.t.sql(`UPDATE users SET email_verified_at = NULL WHERE id = $1`, [amy.userId]);
    await w.t.sql(`UPDATE users SET status = 'suspended' WHERE id = $1`, [bob.userId]);
    const old = new Date(w.clock.get().getTime() - 5 * 60_000);
    await note(amy.userId, 'LOCK', { players: [] }, old);
    await note(bob.userId, 'LOCK', { players: [] }, old);
    expect((await run()).skipped).toEqual({ account: 2 });
    expect(w.mailer.notices).toHaveLength(0);
  });

  it('a temporary failure retries with backoff; a permanent one fails at once; repeated failures give up visibly', async () => {
    const amy = await account(w);
    const old = new Date(w.clock.get().getTime() - 5 * 60_000);
    await note(amy.userId, 'LOCK', { windowLabel: 'tnf', players: [] }, old);
    w.mailer.failNotices = new MailSendError(503, false);
    expect((await run()).retrying).toBe(1);
    let [r] = await rows(amy.userId);
    expect(r).toMatchObject({ dispatched_at: null, dispatch_attempts: 1 });
    expect(r.dispatch_next_at!.getTime()).toBe(w.clock.get().getTime() + 60_000);
    expect((await run()).users).toBe(0); // not before its retry time
    later(61_000);
    w.mailer.failNotices = null;
    expect((await run()).sent).toBe(1);
    [r] = await rows(amy.userId);
    expect(r).toMatchObject({ dispatch_result: 'sent', dispatch_attempts: 2 });

    const bob = await account(w);
    await note(bob.userId, 'LOCK', { windowLabel: 'tnf', players: [] }, old);
    w.mailer.failNotices = new MailSendError(400, true);
    expect((await run()).failed).toBe(1);
    expect((await rows(bob.userId))[0].dispatch_result).toBe('failed:400');

    const cy = await account(w);
    await note(cy.userId, 'LOCK', { windowLabel: 'tnf', players: [] }, new Date(w.clock.get().getTime() - 3 * 60_000));
    w.mailer.failNotices = new MailSendError(500, false);
    for (let i = 0; i < 5; i++) {
      await run({ ...CFG, backoffMinutes: [0] });
      later(1000);
    }
    expect((await rows(cy.userId))[0]).toMatchObject({ dispatch_result: 'failed:500', dispatch_attempts: 5 });
    expect(w.logs.some((l) => l.includes('notify: email failed, giving up'))).toBe(true);
  });

  it('two senders at once never send the same notice twice; a crashed claim is picked up after 5 minutes', async () => {
    const users = await Promise.all([account(w), account(w), account(w)]);
    const old = new Date(w.clock.get().getTime() - 5 * 60_000);
    for (const u of users) await note(u.userId, 'LOCK', { windowLabel: 'tnf', players: [] }, old);
    await Promise.all([run(), run(), run()]);
    expect(w.mailer.notices.map((m) => m.to).sort()).toEqual(users.map((u) => u.email).sort());

    const dan = await account(w);
    await note(dan.userId, 'LOCK', { windowLabel: 'tnf', players: [] }, old);
    await w.t.sql(`UPDATE notification_queue SET dispatch_claimed_at = $2 WHERE user_id = $1`, [dan.userId, w.clock.get()]); // a worker died mid-send
    expect((await run()).users).toBe(0);
    later(5 * 60_000 + 1000);
    expect((await run()).sent).toBe(1);
  });

  it('decisions and rendering without the database', () => {
    const now = new Date('2026-10-29T12:00:00Z');
    const user = { id: 'u', email: 'a@b.c', verified: true, status: 'active', email_notifications: 'on' as const };
    const n = (kind: string, ageH = 0) => ({ kind, created_at: new Date(now.getTime() - ageH * 3600_000) });
    expect(skipReason(n('LOCK'), user, new Map(), now)).toBeNull();
    expect(skipReason(n('SCORE_CORRECTION'), user, new Map(), now)).toBe('preference'); // off by default
    expect(skipReason(n('SCORE_CORRECTION'), user, new Map([['SCORE_CORRECTION', true]]), now)).toBeNull();
    expect(skipReason(n('MYSTERY'), user, new Map(), now)).toBe('unsupported');
    expect(skipReason(n('LOCK', 6.1), user, new Map(), now)).toBe('stale');
    expect(skipReason(n('LOCK', 5.9), user, new Map(), now)).toBeNull();
    expect(skipReason(n('PAYOUT_SENT'), { ...user, email_notifications: 'off' }, new Map([['PAYOUT_SENT', false]]), now)).toBeNull(); // required

    // HTML is escaped; an unknown player id reads "a player", never the raw id.
    const out = renderEmail(
      [{ id: '1', kind: 'LOCK', payload: { windowLabel: '<b>tnf</b>', players: [{ playerId: 'secret-id-9', slotKey: 'qb' }] }, createdAt: now }],
      { players: new Map(), burns: new Map() },
      { appBaseUrl: 'https://app.example', unsubscribePageUrl: 'https://app.example/unsubscribe?token=t' }
    )!;
    expect(out.html).toContain('&lt;b&gt;tnf&lt;/b&gt;');
    expect(out.html).not.toContain('<b>tnf</b>');
    expect(out.text).toContain('QB: a player');
    expect(out.text + out.html).not.toContain('secret-id-9');
    expect(out.html).not.toMatch(/<img|<script/i);
    expect(renderEmail([{ id: '2', kind: 'MYSTERY', payload: {}, createdAt: now }], { players: new Map(), burns: new Map() }, { appBaseUrl: 'x', unsubscribePageUrl: 'y' })).toBeNull();

    // Burns carry slot and points from the burn record.
    const burn = renderEmail(
      [{ id: '3', kind: 'BURN', payload: { burnedAt: now.toISOString(), players: [{ playerId: 'wrKC', burnRecordId: 'b1' }] }, createdAt: now }],
      { players: new Map([['wrKC', { name: 'Wes Kay', position: 'WR', team: 'KC' }]]), burns: new Map([['b1', { slotKey: 'wr1', pointsX100: 1220 }]]) },
      { appBaseUrl: 'https://app.example', unsubscribePageUrl: 'u' }
    )!;
    expect(burn.subject).toBe('Burned: Wes Kay');
    expect(burn.text).toContain('WR1: Wes Kay (WR, KC), 12.2 pts');
    expect(burn.text).toContain('He’s gone for the rest of the season.');
  });

  it('the worker job: off without NOTIFY_EMAIL; on, it sends and flags a stalled queue in the logs', async () => {
    const { createJobs } = await import('../jobs');
    const msf = { get: async () => ({}) };
    const off = createJobs({ db: w.t.db, payments: w.payments, msf, season: SEASON, now: w.clock.get, log: silent, apiContext: w.ctx });
    expect(await off.run('notify')).toEqual({ skipped: 'NOTIFY_EMAIL_OFF' });

    const amy = await account(w);
    await note(amy.userId, 'LOCK', { windowLabel: 'tnf', players: [] }, new Date(w.clock.get().getTime() - 3 * 60_000));
    const on = createJobs({ db: w.t.db, payments: w.payments, msf, season: SEASON, now: w.clock.get, log: silent, apiContext: w.ctx, notify: CFG });
    expect(await on.run('notify')).toMatchObject({ sent: 1 });

    // A notice stuck for over 10 minutes (here: waiting on a retry) is an error line.
    await note(amy.userId, 'LOCK', { windowLabel: 'tnf', players: [] }, new Date(w.clock.get().getTime() - 3 * 60_000));
    await w.t.sql(`UPDATE notification_queue SET dispatch_next_at = $2 WHERE user_id = $1 AND dispatched_at IS NULL`, [amy.userId, new Date(w.clock.get().getTime() + 3600_000)]);
    later(11 * 60_000);
    await on.run('notify');
    expect(w.logs.some((l) => l.includes('notify: oldest pending notice is overdue'))).toBe(true);
  });
});
