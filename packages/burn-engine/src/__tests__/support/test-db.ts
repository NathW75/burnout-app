/**
 * Integration test helpers: an isolated Postgres database per suite, a
 * node-postgres implementation of SqlDatabase, a controllable server clock,
 * and fixture builders.
 */
import { randomUUID } from 'node:crypto';
import { Client, Pool, type PoolClient } from 'pg';
import type { SqlDatabase, SqlRunner } from '../../sql';

const TEMPLATE_DB = 'burnout_test_template';

export const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

export interface TestDb {
  db: SqlDatabase;
  /** Direct SQL for test setup and assertions (outside the engine). */
  sql: <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;
  close: () => Promise<void>;
}

function runner(c: Pool | PoolClient): SqlRunner {
  return {
    async query<T>(text: string, params: unknown[] = []) {
      const res = await c.query(text, params);
      return res.rows as T[];
    },
  };
}

export function pgSqlDatabase(pool: Pool): SqlDatabase {
  return {
    ...runner(pool),
    async transaction<R>(fn: (tx: SqlRunner) => Promise<R>): Promise<R> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(runner(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

export async function createTestDb(): Promise<TestDb> {
  const adminUrl = process.env.TEST_DATABASE_URL!;
  const name = `burnout_t_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString(), max: 5 });
  const db = pgSqlDatabase(pool);

  return {
    db,
    sql: (text, params) => db.query(text, params),
    async close() {
      await pool.end();
      const a = new Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

/** Controllable stand-in for the NTP-synced server clock. */
export class TestClock {
  constructor(private now: Date) {}
  get = (): Date => new Date(this.now.getTime());
  set(d: Date): void {
    this.now = new Date(d.getTime());
  }
  advanceMs(ms: number): void {
    this.now = new Date(this.now.getTime() + ms);
  }
}

export const SEASON = '2026-2027-regular';
export const silentLog = () => {};

// ── Fixtures ────────────────────────────────────────────────────────────────

export async function createUser(t: TestDb, label = 'user'): Promise<string> {
  const [row] = await t.sql<{ id: string }>(
    `INSERT INTO users (email, password_hash, display_name, updated_at)
     VALUES ($1, 'x', $2, now()) RETURNING id`,
    [`${label}-${randomUUID()}@test.local`, label]
  );
  return row.id;
}

export async function createWindow(
  t: TestDb,
  opts: { scheduledEt: Date; week?: number; label?: string; msfGameIds?: string[]; status?: string }
): Promise<string> {
  const [row] = await t.sql<{ id: string }>(
    `INSERT INTO game_windows (week, season, label, scheduled_et, status, msf_game_ids)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      opts.week ?? 8,
      SEASON,
      opts.label ?? 'Sunday Early',
      opts.scheduledEt,
      opts.status ?? 'pending',
      opts.msfGameIds ?? ['msf-game-1'],
    ]
  );
  return row.id;
}

export async function addPoolEntry(t: TestDb, userId: string, playerId: string): Promise<void> {
  await t.sql(`INSERT INTO pool_entries (user_id, player_id, season) VALUES ($1, $2, $3)`, [
    userId,
    playerId,
    SEASON,
  ]);
}

export async function submitSeason(
  t: TestDb,
  opts: { userId: string; windowId: string; playerId: string; slotKey?: string; week?: number }
): Promise<string> {
  const [row] = await t.sql<{ id: string }>(
    `INSERT INTO season_submissions (user_id, week, season, slot_key, player_id, game_window_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [opts.userId, opts.week ?? 8, SEASON, opts.slotKey ?? 'rb1', opts.playerId, opts.windowId]
  );
  return row.id;
}

export async function submitWeekly(
  t: TestDb,
  opts: { userId: string; windowId: string; playerId: string; slotKey?: string; week?: number }
): Promise<string> {
  const [row] = await t.sql<{ id: string }>(
    `INSERT INTO weekly_submissions (user_id, contest_id, week, season, slot_key, player_id, game_window_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [opts.userId, randomUUID(), opts.week ?? 8, SEASON, opts.slotKey ?? 'rb1', opts.playerId, opts.windowId]
  );
  return row.id;
}

export async function count(t: TestDb, table: string, where = 'true', params: unknown[] = []): Promise<number> {
  const [row] = await t.sql<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params);
  return row.n;
}
