/**
 * PRD-008 Phase 2: web push against Postgres. A fake push service stands in
 * for FCM / Mozilla / Apple; everything else is real.
 */
import { describeDbRedis, SEASON } from '@burnout/test-support';
import { DEFAULT_NOTIFY_CONFIG, notifyStats, runNotify, runPush, type NotifyConfig } from '../notify/dispatcher';
import { isAllowedPushEndpoint, PushSendError, webPushSender, type PushSender, type PushSubscriptionKeys } from '../notify/push';
import { account, buildWeek, Client, createWorld, type Account, type World } from './harness';

const CFG: NotifyConfig = { ...DEFAULT_NOTIFY_CONFIG, apiBaseUrl: 'https://api.example.test' };
const KEY = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
const P256 = 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';
const AUTH = 'tBHItJI5svbpez7KI4CCXg';
const ep = (n: number) => `https://fcm.googleapis.com/fcm/send/device-${n}`;

/** A push service that records what it got and answers with whatever status a test sets per endpoint. */
function fakePush() {
  const sent: Array<{ endpoint: string; msg: { title: string; body: string; url: string; tag: string } }> = [];
  const status = new Map<string, number>();
  const sender: PushSender = {
    async send(sub: PushSubscriptionKeys, payload: string) {
      const s = status.get(sub.endpoint);
      if (s) throw new PushSendError(s);
      sent.push({ endpoint: sub.endpoint, msg: JSON.parse(payload) });
    },
  };
  return { sender, sent, status };
}

describeDbRedis('PRD-008 web push (Postgres + Redis)', () => {
  let w: World;
  let push: ReturnType<typeof fakePush>;
  beforeEach(async () => {
    w = await createWorld({ sessionIdleMs: 7 * 24 * 3600_000, vapidPublicKey: KEY });
    await buildWeek(w);
    push = fakePush();
  });
  afterEach(async () => {
    await w.close();
  });

  const subscribe = (a: Account, n: number) => a.client.post('/v1/me/push-subscriptions', { endpoint: ep(n), keys: { p256dh: P256, auth: AUTH } });
  const note = (userId: string, kind: string, payload: object, createdAt = w.clock.get()) =>
    w.t.sql(`INSERT INTO notification_queue (user_id, kind, payload, created_at) VALUES ($1, $2, $3, $4)`, [userId, kind, payload, createdAt]);
  const voided = (userId: string) =>
    note(userId, 'SUBMISSION_VOIDED', { season: SEASON, week: 8, slot: 'rb1', playerId: 'rbDEN', playerName: 'Ray Dent', reason: 'PLAYER_INACTIVE', injuryStatus: 'Out' });
  const run = () => runPush(w.ctx, CFG, push.sender);
  const pushRows = (userId: string) =>
    w.t.sql<{ kind: string; push_result: string | null; push_attempts: number; push_next_at: Date | null; dispatch_result: string | null }>(
      `SELECT kind, push_result, push_attempts, push_next_at, dispatch_result FROM notification_queue WHERE user_id = $1 ORDER BY created_at`,
      [userId]
    );

  it('config is public; a device subscribes and gets the notice on every device, linked to the right page', async () => {
    expect((await new Client(w).get('/v1/push/config')).body).toEqual({ enabled: true, publicKey: KEY });
    const amy = await account(w, { handle: 'amy' });
    expect((await subscribe(amy, 1)).body).toEqual({ subscribed: true, devices: 1 });
    expect((await subscribe(amy, 2)).body.devices).toBe(2);
    expect((await subscribe(amy, 2)).body.devices).toBe(2); // same browser again: still two

    await voided(amy.userId);
    const r = await run();
    expect(r).toMatchObject({ users: 1, sent: 1, noticesSent: 1, failed: 0 });
    expect(push.sent.map((s) => s.endpoint).sort()).toEqual([ep(1), ep(2)]);
    expect(push.sent[0].msg).toEqual({
      title: 'Action needed: your RB1 is open (Ray Dent)',
      body: expect.stringContaining('Ray Dent (RB, DEN) was voided'),
      url: 'https://burnoutfantasy.com/lineup',
      tag: expect.stringMatching(/^bl-submission_voided-[0-9a-f]{8}$/),
    });
    expect((await pushRows(amy.userId))[0]).toMatchObject({ push_result: 'sent', dispatch_result: null }); // email tracks itself
    expect((await run()).sent).toBe(0); // never twice

    // Email and push are separate: the email sender still sends it once.
    expect((await runNotify(w.ctx, CFG)).sent).toBe(1);
    expect((await pushRows(amy.userId))[0]).toMatchObject({ push_result: 'sent', dispatch_result: 'sent' });
  });

  it('no device: skipped, never retried; a device that subscribes later only gets new notices', async () => {
    const amy = await account(w);
    await voided(amy.userId);
    expect((await run()).skipped).toEqual({ no_device: 1 });
    await subscribe(amy, 1);
    expect((await run()).sent).toBe(0);
    expect(push.sent).toHaveLength(0);
  });

  it('a device the push service says is gone is removed; the others still get it', async () => {
    const amy = await account(w);
    await subscribe(amy, 1);
    await subscribe(amy, 2);
    push.status.set(ep(1), 410);
    await voided(amy.userId);
    expect((await run()).sent).toBe(1);
    expect(push.sent.map((s) => s.endpoint)).toEqual([ep(2)]);
    const subs = await w.t.sql<{ endpoint: string; revoked: boolean; ok: boolean }>(
      `SELECT endpoint, revoked_at IS NOT NULL AS revoked, last_ok_at IS NOT NULL AS ok FROM push_subscriptions ORDER BY endpoint`);
    expect(subs).toEqual([{ endpoint: ep(1), revoked: true, ok: false }, { endpoint: ep(2), revoked: false, ok: true }]);
    expect((await notifyStats(w.ctx)).pushDevices).toBe(1);

    // Every device gone: skipped as no_device, not retried.
    push.status.set(ep(2), 404);
    await voided(amy.userId);
    expect((await run()).skipped).toEqual({ no_device: 1 });
    expect((await notifyStats(w.ctx)).pushDevices).toBe(0);
  });

  it('a push service outage retries with backoff, then delivers', async () => {
    const amy = await account(w);
    await subscribe(amy, 1);
    push.status.set(ep(1), 503);
    await voided(amy.userId);
    expect((await run()).retrying).toBe(1);
    const [row] = await pushRows(amy.userId);
    expect(row).toMatchObject({ push_result: null, push_attempts: 1 });
    expect(row.push_next_at!.getTime() - w.clock.get().getTime()).toBe(60_000);
    expect((await run()).retrying).toBe(0); // not due yet
    push.status.delete(ep(1));
    w.clock.advanceMs(61_000);
    expect((await run()).sent).toBe(1);
    expect((await pushRows(amy.userId))[0].push_result).toBe('sent');
  });

  it('push follows its own switches; turning email off entirely does not turn push off', async () => {
    const amy = await account(w);
    await subscribe(amy, 1);
    const put = await amy.client.put('/v1/me/notification-preferences', { emailNotifications: 'off', push: { lineup_changes: false } });
    expect(put.body).toMatchObject({ emailNotifications: 'off', push: { locks_burns: true, lineup_changes: false, receipts: true } });
    expect(put.body.email.lineup_changes).toBe(true); // email switches untouched
    await voided(amy.userId);
    await note(amy.userId, 'LOCK', { windowLabel: 'tnf', week: 8, players: [{ playerId: 'qbBUF', slotKey: 'qb' }] }, new Date(w.clock.get().getTime() - 3 * 60_000));
    const r = await run();
    expect(r).toMatchObject({ sent: 1, skipped: { preference: 1 } });
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0].msg.tag).toMatch(/^bl-lock-/);
    expect(push.sent[0].msg.url).toBe('https://burnoutfantasy.com/');
  });

  it('subscribe rules: signed in, push on, known push service, sane keys; a browser that switches accounts moves', async () => {
    expect((await new Client(w).post('/v1/me/push-subscriptions', { endpoint: ep(1), keys: { p256dh: P256, auth: AUTH } })).status).toBe(401);
    const amy = await account(w, { handle: 'amy' });
    const bob = await account(w, { handle: 'bob' });
    const bad = async (body: object) => (await amy.client.post('/v1/me/push-subscriptions', body)).status;
    expect(await bad({ endpoint: 'https://evil.example.com/hook', keys: { p256dh: P256, auth: AUTH } })).toBe(400);
    expect(await bad({ endpoint: 'http://fcm.googleapis.com/fcm/send/x', keys: { p256dh: P256, auth: AUTH } })).toBe(400);
    expect(await bad({ endpoint: ep(1), keys: { p256dh: 'short', auth: AUTH } })).toBe(400);
    expect(await bad({ endpoint: ep(1), keys: { p256dh: P256, auth: 'has spaces in it!!' } })).toBe(400);
    expect(await bad({ endpoint: ep(1), keys: { p256dh: P256, auth: AUTH }, extra: 1 })).toBe(400);

    expect((await subscribe(amy, 1)).status).toBe(201);
    expect((await subscribe(bob, 1)).body.devices).toBe(1); // same browser, now bob's
    const [owner] = await w.t.sql<{ user_id: string }>(`SELECT user_id::text FROM push_subscriptions WHERE endpoint = $1`, [ep(1)]);
    expect(owner.user_id).toBe(bob.userId);

    expect((await amy.client.delete('/v1/me/push-subscriptions', { endpoint: ep(1) })).body).toEqual({ removed: false, devices: 0 }); // not hers
    expect((await bob.client.delete('/v1/me/push-subscriptions', { endpoint: ep(1) })).body).toEqual({ removed: true, devices: 0 });
    expect((await subscribe(bob, 1)).body.devices).toBe(1); // turning it back on revives it

    w.ctx.config.vapidPublicKey = null;
    expect((await new Client(w).get('/v1/push/config')).body).toEqual({ enabled: false, publicKey: null });
    expect((await subscribe(amy, 3)).status).toBe(409);
  });

  it('signing out everywhere stops push on every device', async () => {
    const amy = await account(w);
    await subscribe(amy, 1);
    await subscribe(amy, 2);
    expect((await amy.client.post('/v1/auth/logout-all')).status).toBe(200);
    const [{ n }] = await w.t.sql<{ n: number }>(`SELECT count(*)::int AS n FROM push_subscriptions WHERE revoked_at IS NULL`);
    expect(n).toBe(0);
  });

  it('endpoints: only known push services over plain https', async () => {
    for (const ok of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/QGx',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
    ]) expect(isAllowedPushEndpoint(ok)).toBe(true);
    for (const bad of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com:8443/fcm/send/abc',
      'https://user:pw@fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com.evil.com/x',
      'https://evil.com/fcm.googleapis.com',
      'https://127.0.0.1/x',
      'not a url',
    ]) expect(isAllowedPushEndpoint(bad)).toBe(false);
    // The real sender refuses to post anywhere else, even if a bad row got in.
    const s = webPushSender({ publicKey: KEY, privateKey: 'x', subject: 'mailto:a@b.test' });
    await expect(s.send({ endpoint: 'https://evil.com/x', p256dh: P256, auth: AUTH }, '{}')).rejects.toMatchObject({ status: 410, gone: true });
  });
});
