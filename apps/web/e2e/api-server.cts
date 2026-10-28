/**
 * End-to-end API server: the real PRD-006 app on a fresh Postgres database
 * built from the shipped migrations, real Redis, an in-memory mailer, and a
 * Week 8 laid out around the current time. Test-only helpers live under
 * /__e2e and exist only in this file; production code has nothing like them.
 *
 *   E2E_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/postgres \
 *   E2E_REDIS_URL=redis://127.0.0.1:63799 \
 *   tsx --tsconfig e2e/tsconfig.json e2e/api-server.cts
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import express from 'express';
import Redis from 'ioredis';
import { Client, Pool } from 'pg';
import { createPaymentsService, FakeProcessor } from '@burnout/payments';
import { createApp } from '../../../packages/api/src/app';
import { aggregate, statsKey, type GameLine } from '../../../packages/api/src/players/stats';
import { createJobs, type MsfFetcher } from '../../../packages/api/src/jobs';
import { DEFAULT_NOTIFY_CONFIG } from '../../../packages/api/src/notify/dispatcher';
import { MemoryMailer } from '../../../packages/api/src/mailer';
import { pgDatabase } from '../../../packages/api/src/sql';

export const SEASON = '2026-2027-regular';
const PORT = Number(process.env.E2E_API_PORT ?? 3001);
const WEB_ORIGIN = process.env.E2E_WEB_ORIGIN ?? 'http://localhost:4173';
const DB_NAME = 'burnout_e2e';
const MIGRATIONS = join(__dirname, '../../../packages/db/prisma/migrations');

async function freshDatabase(adminUrl: string): Promise<string> {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${DB_NAME}`;
  const c = new Client({ connectionString: url.toString() });
  await c.connect();
  for (const dir of readdirSync(MIGRATIONS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    await c.query(readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8'));
  }
  await c.end();
  return url.toString();
}

/** Week 8 around now: Thursday's window locked an hour ago, the rest still open. */
export const GAMES = [
  { label: 'Thursday Night · 8:15 PM', offsetH: -1, id: 'g-tnf', home: 'DEN', away: 'KC' },
  { label: 'Sunday Early · 1:00 PM', offsetH: 3, id: 'g-early', home: 'MIA', away: 'BUF' },
  { label: 'Sunday Late · 4:25 PM', offsetH: 6, id: 'g-late', home: 'DAL', away: 'SF' },
  { label: 'Sunday Night · 8:20 PM', offsetH: 30, id: 'g-snf', home: 'NYG', away: 'PHI' },
  { label: 'Monday Night · 8:15 PM', offsetH: 54, id: 'g-mnf', home: 'GB', away: 'DET' },
];

const PLAYERS: Array<[string, string, string, string, string, string?]> = [
  ['qbKC', 'Quinn', 'Kay', 'QB', 'KC'], ['qbBUF', 'Quade', 'Buff', 'QB', 'BUF'], ['qbSF', 'Quill', 'Sfo', 'QB', 'SF'],
  ['rbDEN', 'Ray', 'Dent', 'RB', 'DEN'], ['rbMIA', 'Rex', 'Mia', 'RB', 'MIA'], ['rbSF', 'Rod', 'Sfo', 'RB', 'SF'], ['rbPHI', 'Ron', 'Phi', 'RB', 'PHI', 'Questionable'],
  ['rbCHI', 'Reed', 'Chi', 'RB', 'CHI'], ['rbGB', 'Rhett', 'Bay', 'RB', 'GB', 'Out'],
  ['wrKC', 'Wes', 'Kay', 'WR', 'KC'], ['wrBUF', 'Will', 'Buff', 'WR', 'BUF'], ['wrDAL', 'Walt', 'Dal', 'WR', 'DAL'], ['wrPHI', 'Wade', 'Phi', 'WR', 'PHI'], ['wrNYG', 'Webb', 'Gnat', 'WR', 'NYG'], ['wrDET', 'Wynn', 'Det', 'WR', 'DET'],
  ['teSF', 'Ty', 'Sfo', 'TE', 'SF'], ['teGB', 'Tom', 'Bay', 'TE', 'GB'], ['teMIA', 'Tad', 'Mia', 'TE', 'MIA'],
  ['kDET', 'Kip', 'Det', 'K', 'DET'], ['kMIA', 'Kai', 'Mia', 'K', 'MIA'],
  ['fbSF', 'Fred', 'Sfo', 'FB', 'SF'],
];

/** Last week, for history: one game (KC @ DEN) a week ago, still pending until the lock job runs. */
export const LAST_WEEK = { label: 'Sunday Early · 1:00 PM', offsetH: -7 * 24, id: 'g7', home: 'DEN', away: 'KC' };

async function seed(db: ReturnType<typeof pgDatabase>): Promise<void> {
  const now = Date.now();
  {
    const g = LAST_WEEK;
    const at = new Date(Math.floor((now + g.offsetH * 3600_000) / 60_000) * 60_000);
    const [w] = await db.query<{ id: string }>(
      `INSERT INTO game_windows (week, season, label, scheduled_et, status, msf_game_ids) VALUES (7, $1, $2, $3, 'pending', $4) RETURNING id::text AS id`,
      [SEASON, g.label, at, [g.id]]
    );
    await db.query(
      `INSERT INTO nfl_games (msf_game_id, season, week, game_window_id, scheduled_start, home_team, away_team, played_status, schedule_status, is_final, updated_at)
       VALUES ($1, $2, 7, $3, $4, $5, $6, 'UNPLAYED', 'NORMAL', false, now())`,
      [g.id, SEASON, w.id, at, g.home, g.away]
    );
  }
  for (const g of GAMES) {
    const at = new Date(Math.floor((now + g.offsetH * 3600_000) / 60_000) * 60_000);
    const status = g.offsetH < 0 ? 'locked' : 'pending';
    const [w] = await db.query<{ id: string }>(
      `INSERT INTO game_windows (week, season, label, scheduled_et, status, msf_game_ids) VALUES (8, $1, $2, $3, $4, $5) RETURNING id::text AS id`,
      [SEASON, g.label, at, status, [g.id]]
    );
    await db.query(
      `INSERT INTO nfl_games (msf_game_id, season, week, game_window_id, scheduled_start, home_team, away_team, played_status, schedule_status, is_final, updated_at)
       VALUES ($1, $2, 8, $3, $4, $5, $6, 'UNPLAYED', 'NORMAL', false, now())`,
      [g.id, SEASON, w.id, at, g.home, g.away]
    );
  }
  for (const [id, first, last, pos, team, injury] of PLAYERS) {
    await db.query(
      `INSERT INTO nfl_players (msf_player_id, first_name, last_name, position, team, roster_status, injury_status, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'ROSTER', $6, now())`,
      [id, first, last, pos, team, injury ?? 'Active']
    );
  }
}

/** Picker stats (PRD-007 §8.7) as the worker would leave them: seven played weeks per player, deterministic. */
async function seedStats(redis: Redis, namespace: string): Promise<void> {
  const lines: GameLine[] = [];
  PLAYERS.forEach(([id, , , pos], i) => {
    for (let week = 1; week <= 7; week++) {
      const f = ((i * 7 + week * 3) % 11) + 1; // 1..11, varies by player and week
      const z = { att: 0, yds: 0, tds: 0 };
      lines.push({
        playerId: id, gameId: `s${week}-${id}`, week, start: new Date(Date.UTC(2026, 8, 10 + (week - 1) * 7, 17)).toISOString(),
        rush: pos === 'RB' || pos === 'FB' ? { att: 8 + f, yds: 30 + f * 9, tds: f > 9 ? 1 : 0 } : pos === 'QB' ? { att: 3, yds: f * 2, tds: 0 } : z,
        rec: pos === 'WR' || pos === 'TE' ? { tgt: 4 + f, rec: 2 + Math.floor(f / 2), yds: 20 + f * 8, tds: f > 9 ? 1 : 0 } : pos === 'RB' ? { tgt: f % 5, rec: f % 4, yds: f * 3, tds: 0 } : { tgt: 0, rec: 0, yds: 0, tds: 0 },
        pass: pos === 'QB' ? { att: 25 + f, cmp: 15 + f, yds: 180 + f * 15, tds: f > 6 ? 2 : 1, int: f % 3 === 0 ? 1 : 0 } : { att: 0, cmp: 0, yds: 0, tds: 0, int: 0 },
        k: pos === 'K' ? { fgm: f % 3, fga: (f % 3) + 1, xpm: 2, xpa: 2 } : { fgm: 0, fga: 0, xpm: 0, xpa: 0 },
        ptsX100: (5 + f) * 100 + (pos === 'QB' ? 600 : 0),
      });
    }
  });
  const positions = new Map(PLAYERS.map(([id, , , pos]) => [id, pos]));
  const players = aggregate(lines, new Map(), positions);
  await redis.set(statsKey(namespace, SEASON), JSON.stringify({ season: SEASON, asOf: new Date().toISOString(), weeks: [1, 2, 3, 4, 5, 6, 7], players }));
}

async function main() {
  const adminUrl = process.env.E2E_DATABASE_URL;
  const redisUrl = process.env.E2E_REDIS_URL;
  if (!adminUrl || !redisUrl) throw new Error('E2E_DATABASE_URL and E2E_REDIS_URL are required');
  const pool = new Pool({ connectionString: await freshDatabase(adminUrl), max: 10 });
  const db = pgDatabase(pool);
  await seed(db);
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 2 });
  const namespace = `e2e:${randomBytes(4).toString('hex')}:`;
  const mailer = new MemoryMailer();
  const payments = await createPaymentsService({ db, processor: new FakeProcessor(), env: {}, log: () => {} });
  const { app: api, ctx } = createApp({
    db, redis, namespace, payments, mailer,
    totpEncryptionKey: randomBytes(32).toString('base64'),
    log: (level, message, meta) => level !== 'info' && console.error(JSON.stringify({ level, message, ...meta })),
    config: { bcryptCost: 4, cookieSecure: false, corsOrigins: [WEB_ORIGIN], appBaseUrl: WEB_ORIGIN, currentSeason: SEASON, trustProxy: 0, edgeSecret: null, vapidPublicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U' },
  });

  await seedStats(redis, namespace);

  const app = express();
  // ── test-only helpers ──
  app.get('/__e2e/mail', (req, res) => {
    const m = mailer.last(String(req.query.template) as 'verify_email', String(req.query.to));
    if (!m) return res.status(404).json({ error: 'NO_MAIL' });
    res.json({ link: m.data.link });
  });
  app.get('/__e2e/notices', (req, res) => {
    res.json({ notices: mailer.notices.filter((m) => m.to === String(req.query.to)) });
  });
  app.post('/__e2e/windows/:label/lock-now', async (req, res) => {
    // Moves a window's scheduled kickoff into the past: it is now locked for every rule that reads scheduled_et.
    const rows = await db.query(`UPDATE game_windows SET scheduled_et = now() - interval '1 second' WHERE season = $1 AND week = 8 AND label LIKE $2 RETURNING 1`, [SEASON, `${req.params.label}%`]);
    res.json({ updated: rows.length });
  });
  app.post('/__e2e/history', express.json(), (req, res, next) => void history(req, res).catch(next));
  async function history(req: express.Request, res: express.Response) {
    // Real history through the real engines: last week's picks lock (lock job), the game goes
    // Final, and the scoring job ingests stats and burns (PRD-001, PRD-002). Plus a rival with
    // one locked and one unlocked pick this week, for the reveal. Safe to call more than once.
    const handle = String(req.body?.handle ?? '');
    const [user] = await db.query<{ id: string }>(`SELECT id::text AS id FROM users WHERE handle = $1`, [handle]);
    if (!user) {
      res.status(404).json({ error: 'NO_USER' });
      return;
    }
    const [rival] = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name, handle, email_verified_at, updated_at)
       VALUES ('rival_e2e@example.com', 'x', 'rival_e2e', 'rival_e2e', now(), now())
       ON CONFLICT (email) DO UPDATE SET updated_at = now() RETURNING id::text AS id`
    );
    const win = async (week: number, labelPrefix: string) =>
      (await db.query<{ id: string }>(`SELECT id::text AS id FROM game_windows WHERE season = $1 AND week = $2 AND label LIKE $3`, [SEASON, week, `${labelPrefix}%`]))[0].id;
    const w7 = await win(7, 'Sunday Early');
    const sub = (userId: string, week: number, slot: string, player: string, windowId: string, locked: boolean) =>
      db.query(
        `INSERT INTO season_submissions (user_id, week, season, slot_key, player_id, game_window_id, locked_at)
         SELECT $1::uuid, $2::smallint, $3::text, $4::text, $5::text, $6::uuid, CASE WHEN $7::boolean THEN now() END
          WHERE NOT EXISTS (SELECT 1 FROM season_submissions WHERE user_id = $1::uuid AND season = $3::text AND week = $2::smallint AND slot_key = $4::text)`,
        [userId, week, SEASON, slot, player, windowId, locked]
      );
    for (const [slot, player] of [['qb', 'qbKC'], ['rb1', 'rbDEN'], ['wr1', 'wrKC']]) await sub(user.id, 7, slot, player, w7, false);
    await sub(rival.id, 7, 'rb1', 'rbDEN', w7, false);
    await sub(rival.id, 8, 'wr1', 'wrKC', await win(8, 'Thursday Night'), true); // Thursday already locked
    await sub(rival.id, 8, 'wr2', 'wrDAL', await win(8, 'Sunday Late'), false); // not locked: must stay hidden

    const week8 = await db.query<{ id: string; at: Date; home: string; away: string }>(
      `SELECT msf_game_id AS id, scheduled_start AS at, home_team AS home, away_team AS away FROM nfl_games WHERE season = $1 AND week = 8`, [SEASON]
    );
    const [g7] = await db.query<{ at: Date }>(`SELECT scheduled_start AS at FROM nfl_games WHERE msf_game_id = 'g7'`);
    const game = (id: string, week: number, at: Date, home: string, away: string, played: string) =>
      ({ schedule: { id, week, startTime: at.toISOString(), playedStatus: played, scheduleStatus: 'NORMAL', homeTeam: { abbreviation: home }, awayTeam: { abbreviation: away } } });
    const log = (id: string, position: string, stats: object) => ({ player: { id, position }, game: { id: 'g7', week: 7 }, stats });
    const stamp = new Date().toISOString();
    const msf: MsfFetcher = {
      async get(path) {
        if (path.includes('/week/7/games.json')) return { lastUpdatedOn: stamp, games: [game('g7', 7, g7.at, 'DEN', 'KC', 'COMPLETED')] };
        if (path.includes('/week/7/player_gamelogs.json')) {
          return {
            lastUpdatedOn: stamp,
            gamelogs: [
              log('qbKC', 'QB', { passing: { passYards: 300, passTD: 2 } }),
              log('rbDEN', 'RB', { rushing: { rushYards: 85, rushTD: 1 } }),
              log('wrKC', 'WR', { receiving: { receptions: 6, recYards: 92 } }),
            ],
          };
        }
        if (path.includes('/week/8/games.json')) return { lastUpdatedOn: stamp, games: week8.map((g) => game(g.id, 8, g.at, g.home, g.away, 'UNPLAYED')) };
        if (path.includes('/week/8/player_gamelogs.json')) return { lastUpdatedOn: stamp, gamelogs: [] };
        throw new Error(`e2e msf: no fixture for ${path}`);
      },
    };
    // Email delivery with no grouping wait, so the test sees the email at once (PRD-008).
    const notify = { ...DEFAULT_NOTIFY_CONFIG, groupSeconds: 0, apiBaseUrl: `http://localhost:${PORT}` };
    const jobs = createJobs({ db, redis, namespace, payments, msf, season: SEASON, now: () => new Date(), log: () => {}, apiContext: ctx, msfRetryDelayMs: 0, notify });
    const locks = await jobs.jobs.locks();
    const scoring = await jobs.jobs.scoring();
    await jobs.jobs.notify();
    await redis.del(`${namespace}field:${SEASON}`); // the field board is cached for 30 s
    res.json({ locks, scoring });
  }
  app.use(api);
  app.listen(PORT, () => console.log(`e2e api listening on ${PORT}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
