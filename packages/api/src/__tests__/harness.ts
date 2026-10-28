/**
 * HTTP test harness: real Postgres (shipped migrations) + real Redis, the
 * real Express app via supertest, a controllable clock, MemoryMailer and
 * FakeProcessor.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { createPaymentsService, FakeProcessor, type PaymentsService } from '@burnout/payments';
import { createTestDb, createTestRedis, SEASON, TestClock, type TestDb, type TestRedis } from '@burnout/test-support';
import { createApp, type CreateAppDeps } from '../app';
import { totp } from '../auth/totp';
import type { ApiConfig, ApiContext } from '../context';
import { MemoryMailer } from '../mailer';

export const T0 = new Date('2026-10-28T12:00:00Z'); // Wednesday of Week 8
export const ORIGIN = 'https://burnoutfantasy.com';
export const PASSWORD = 'correct horse battery staple';

export interface World {
  t: TestDb;
  r: TestRedis;
  clock: TestClock;
  fake: FakeProcessor;
  payments: PaymentsService;
  mailer: MemoryMailer;
  app: Express;
  ctx: ApiContext;
  logs: string[];
  close: () => Promise<void>;
}

export async function createWorld(config: Partial<ApiConfig> = {}, deps: Pick<CreateAppDeps, 'verifyTurnstile'> = {}): Promise<World> {
  const t = await createTestDb();
  const r = await createTestRedis();
  const clock = new TestClock(T0);
  const fake = new FakeProcessor();
  const logs: string[] = [];
  const log = (level: string, message: string, meta?: object) => logs.push(JSON.stringify({ level, message, ...(meta ?? {}) }));
  const payments = await createPaymentsService({ db: t.db, processor: fake, getServerTime: clock.get, env: {}, log });
  const mailer = new MemoryMailer();
  const { app, ctx } = createApp({
    ...deps,
    db: t.db, redis: r.redis, namespace: r.namespace, payments, mailer, log,
    totpEncryptionKey: randomBytes(32).toString('base64'),
    getServerTime: clock.get,
    config: { bcryptCost: 4, cookieSecure: false, corsOrigins: [ORIGIN], appBaseUrl: ORIGIN, currentSeason: SEASON, trustProxy: 1, ...config },
  });
  return { t, r, clock, fake, payments, mailer, app, ctx, logs, close: async () => { await r.close(); await t.close(); } };
}

/** A signed-in client: a cookie agent (web) or a bearer token (mobile). */
export class Client {
  readonly agent: ReturnType<typeof request.agent>;
  token: string | null = null;
  ip = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  constructor(readonly w: World, readonly kind: 'web' | 'mobile' = 'web') {
    this.agent = request.agent(w.app);
  }
  private prep(req: request.Test): request.Test {
    req.set('X-Forwarded-For', this.ip).set('User-Agent', 'jest-client');
    if (this.kind === 'mobile' && this.token) req.set('Authorization', `Bearer ${this.token}`);
    if (this.kind === 'web') req.set('X-Burnout-CSRF', '1');
    return req;
  }
  get(url: string) {
    return this.prep(this.agent.get(url));
  }
  post(url: string, body: object = {}) {
    return this.prep(this.agent.post(url)).send(body);
  }
  put(url: string, body: object = {}) {
    return this.prep(this.agent.put(url)).send(body);
  }
  delete(url: string, body: object = {}) {
    return this.prep(this.agent.delete(url)).send(body);
  }
  del(url: string) {
    return this.prep(this.agent.delete(url));
  }
}

export interface Account {
  client: Client;
  userId: string;
  email: string;
  handle: string;
  totpSecret?: string;
  backupCodes?: string[];
}

export function tokenFromLink(link: string): string {
  return new URL(link).searchParams.get('token')!;
}

/**
 * Signs up, verifies the email, signs in and enrolls TOTP, which every
 * account needs to use the API (PRD-007 §8.6). `totp: false` stops after
 * sign-in, leaving an enrollment-only session.
 */
export async function account(
  w: World,
  o: { handle?: string; verify?: boolean; totp?: boolean; kind?: 'web' | 'mobile'; admin?: boolean } = {}
): Promise<Account> {
  const handle = o.handle ?? `p_${randomUUID().slice(0, 8)}`;
  const email = `${handle.toLowerCase()}@example.com`;
  const c = new Client(w, o.kind ?? 'web');
  const s = await c.post('/v1/auth/signup', { email, password: PASSWORD, handle });
  if (s.status !== 202) throw new Error(`signup ${s.status} ${JSON.stringify(s.body)}`);
  if (o.verify !== false) {
    const v = await c.post('/v1/auth/verify-email', { token: tokenFromLink(w.mailer.last('verify_email', email)!.data.link) });
    if (v.status !== 200) throw new Error(`verify ${v.status}`);
  }
  const [{ id }] = await w.t.sql<{ id: string }>(`SELECT id::text AS id FROM users WHERE email = $1`, [email]);
  if (o.admin) await w.t.sql(`UPDATE users SET role = 'admin' WHERE id = $1`, [id]);
  await login(c, email);
  const acc: Account = { client: c, userId: id, email, handle };
  if (o.totp !== false && o.verify !== false) {
    const setup = await c.post('/v1/auth/mfa/totp/setup', { password: PASSWORD });
    if (setup.status !== 200) throw new Error(`totp setup ${setup.status} ${JSON.stringify(setup.body)}`);
    acc.totpSecret = setup.body.secret;
    const conf = await c.post('/v1/auth/mfa/totp/confirm', { code: totp(acc.totpSecret!, w.clock.get()) });
    if (conf.status !== 200) throw new Error(`totp confirm ${conf.status}`);
    acc.backupCodes = conf.body.backupCodes;
  }
  return acc;
}

/** Sign in again after a test jumps the clock past the 24 h idle timeout (D1 working as designed). */
export async function relogin(a: Account) {
  const res = await login(a.client, a.email);
  if (res.status !== 200) throw new Error(`relogin ${res.status}`);
  if (res.body.mfaRequired) {
    const mfa = await a.client.post('/v1/auth/login/mfa', { code: nextCode(a.client.w, a) });
    if (mfa.status !== 200) throw new Error(`relogin mfa ${mfa.status} ${JSON.stringify(mfa.body)}`);
  }
}

/** Full sign-in for another device of an enrolled account: password, then a fresh code. */
export async function signIn(c: Client, a: Account) {
  const res = await login(c, a.email);
  if (res.status !== 200) throw new Error(`sign-in ${res.status}`);
  if (res.body.mfaRequired) {
    const mfa = await c.post('/v1/auth/login/mfa', { code: nextCode(c.w, a) });
    if (mfa.status !== 200) throw new Error(`sign-in mfa ${mfa.status} ${JSON.stringify(mfa.body)}`);
  }
  return res;
}

export async function login(c: Client, email: string, password = PASSWORD) {
  const res = await c.post('/v1/auth/login', { email, password, client: c.kind });
  if (res.status === 200 && c.kind === 'mobile') c.token = res.body.token;
  return res;
}

/** Fresh step-up: advance one TOTP step (codes can't be replayed) and confirm. */
export async function stepUp(w: World, a: Account) {
  w.clock.advanceMs(30_000);
  const res = await a.client.post('/v1/auth/step-up', { code: totp(a.totpSecret!, w.clock.get()) });
  if (res.status !== 200) throw new Error(`step-up ${res.status} ${JSON.stringify(res.body)}`);
  return res;
}

export function nextCode(w: World, a: Account): string {
  w.clock.advanceMs(30_000);
  return totp(a.totpSecret!, w.clock.get());
}

// ── football world (Week 8) ──────────────────────────────────────────────────

export const WINDOWS = {
  tnf: new Date('2026-10-30T00:15:00Z'),
  early: new Date('2026-11-01T18:00:00Z'),
  late: new Date('2026-11-01T21:25:00Z'),
  snf: new Date('2026-11-02T01:20:00Z'),
  mnf: new Date('2026-11-03T01:15:00Z'),
};

export const PLAYERS: Array<[id: string, first: string, last: string, pos: string, team: string | null]> = [
  ['qbKC', 'Quinn', 'Kay', 'QB', 'KC'], ['qbBUF', 'Quade', 'Buff', 'QB', 'BUF'],
  ['rbDEN', 'Ray', 'Dent', 'RB', 'DEN'], ['rbMIA', 'Rex', 'Mia', 'RB', 'MIA'], ['rbSF', 'Rod', 'Sfo', 'RB', 'SF'], ['rbCHI', 'Ron', 'Chi', 'RB', 'CHI'],
  ['wrKC', 'Wes', 'Kay', 'WR', 'KC'], ['wrBUF', 'Will', 'Buff', 'WR', 'BUF'], ['wrDAL', 'Walt', 'Dal', 'WR', 'DAL'], ['wrPHI', 'Wade', 'Phi', 'WR', 'PHI'], ['wrNYG', 'Webb', 'Gnat', 'WR', 'NYG'],
  ['teSF', 'Ty', 'Sfo', 'TE', 'SF'], ['teGB', 'Tom', 'Bay', 'TE', 'GB'],
  ['kDET', 'Kip', 'Det', 'K', 'DET'], ['kMIA', 'Kai', 'Mia', 'K', 'MIA'],
  ['fbSF', 'Fred', 'Sfo', 'FB', 'SF'],
];

export const LINEUP = { qb: 'qbBUF', rb1: 'rbDEN', rb2: 'rbMIA', wr1: 'wrKC', wr2: 'wrDAL', wr3: 'wrPHI', te: 'teSF', flex: 'wrNYG', k: 'kDET' };

/** Five windows, five games (CHI on bye), sixteen players. Returns window ids by name. */
export async function buildWeek(w: World): Promise<Record<keyof typeof WINDOWS, string>> {
  const games: Array<[keyof typeof WINDOWS, string, string, string]> = [
    ['tnf', 'g-tnf', 'DEN', 'KC'], ['early', 'g-early', 'BUF', 'MIA'], ['late', 'g-late', 'SF', 'DAL'], ['snf', 'g-snf', 'PHI', 'NYG'], ['mnf', 'g-mnf', 'DET', 'GB'],
  ];
  const ids = {} as Record<keyof typeof WINDOWS, string>;
  for (const [name, gameId, home, away] of games) {
    const [win] = await w.t.sql<{ id: string }>(
      `INSERT INTO game_windows (week, season, label, scheduled_et, status, msf_game_ids) VALUES (8, $1, $2, $3, 'pending', $4) RETURNING id::text AS id`,
      [SEASON, name, WINDOWS[name], [gameId]]
    );
    ids[name] = win.id;
    await w.t.sql(
      `INSERT INTO nfl_games (msf_game_id, season, week, game_window_id, scheduled_start, home_team, away_team, played_status, schedule_status, is_final, updated_at)
       VALUES ($1, $2, 8, $3, $4, $5, $6, 'UNPLAYED', 'NORMAL', false, now())`,
      [gameId, SEASON, win.id, WINDOWS[name], home, away]
    );
  }
  for (const [id, first, last, pos, team] of PLAYERS) {
    await w.t.sql(
      `INSERT INTO nfl_players (msf_player_id, first_name, last_name, position, team, roster_status, injury_status, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'ROSTER', 'Active', now())`,
      [id, first, last, pos, team]
    );
  }
  return ids;
}

/** Runs the three gates for a lineup; returns the confirm response. */
export async function submitLineup(w: World, a: Account, slots: object = LINEUP, week = 8) {
  const rev = await a.client.post(`/v1/seasons/${SEASON}/weeks/${week}/lineup/review`, { slots });
  if (rev.status !== 201) return rev;
  w.clock.advanceMs(5_000);
  const ack = await a.client.post(`/v1/lineup-confirmations/${rev.body.confirmationId}/acknowledge`, { burnRules: true, permanent: true, noRefund: true });
  if (ack.status !== 200) return ack;
  w.clock.advanceMs(5_000);
  return a.client.post(`/v1/lineup-confirmations/${rev.body.confirmationId}/confirm`);
}
