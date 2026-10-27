/**
 * SQL seam (structurally identical to the engines' SqlDatabase) and the
 * node-postgres implementation used in production.
 */
import type { Pool, PoolClient } from 'pg';

export interface SqlRunner {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface SqlDatabase extends SqlRunner {
  transaction<R>(fn: (tx: SqlRunner) => Promise<R>): Promise<R>;
}

function runner(c: Pool | PoolClient): SqlRunner {
  return {
    async query<T>(text: string, params: unknown[] = []) {
      return (await c.query(text, params)).rows as T[];
    },
  };
}

export function pgDatabase(pool: Pool): SqlDatabase {
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
