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

async function seed(db: ReturnType<typeof pgDatabase>): Promise<void> {
  const now = Date.now();
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
  const { app: api } = createApp({
    db, redis, namespace, payments, mailer,
    totpEncryptionKey: randomBytes(32).toString('base64'),
    log: (level, message, meta) => level !== 'info' && console.error(JSON.stringify({ level, message, ...meta })),
    config: { bcryptCost: 4, cookieSecure: false, corsOrigins: [WEB_ORIGIN], appBaseUrl: WEB_ORIGIN, currentSeason: SEASON, trustProxy: 0, edgeSecret: null },
  });

  const app = express();
  // ── test-only helpers ──
  app.get('/__e2e/mail', (req, res) => {
    const m = mailer.last(String(req.query.template) as 'verify_email', String(req.query.to));
    if (!m) return res.status(404).json({ error: 'NO_MAIL' });
    res.json({ link: m.data.link });
  });
  app.post('/__e2e/windows/:label/lock-now', async (req, res) => {
    // Moves a window's scheduled kickoff into the past: it is now locked for every rule that reads scheduled_et.
    const rows = await db.query(`UPDATE game_windows SET scheduled_et = now() - interval '1 second' WHERE season = $1 AND week = 8 AND label LIKE $2 RETURNING 1`, [SEASON, `${req.params.label}%`]);
    res.json({ updated: rows.length });
  });
  app.use(api);
  app.listen(PORT, () => console.log(`e2e api listening on ${PORT}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
