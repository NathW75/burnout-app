/**
 * Minimal SQL seam for the burn engine's Postgres store.
 *
 * The burn engine's database work is written as plain parameterized Postgres
 * SQL ($1, $2, …) against this interface. Production wires it to Prisma
 * ($queryRawUnsafe inside $transaction, see adapters/prisma.ts); tests wire it
 * to node-postgres against a real database. Same SQL in both, so the tests
 * exercise exactly what ships.
 *
 * Why raw SQL instead of the Prisma query API here: lock and burn commits need
 * conditional UPDATE … RETURNING claims and set-based inserts inside a single
 * transaction to be race-safe across concurrent workers. Prisma 5's query API
 * cannot express UPDATE … RETURNING.
 */

export interface SqlRunner {
  /** Run one statement. Parameters are positional ($1, $2, …) and always bound, never interpolated. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface SqlDatabase extends SqlRunner {
  /** Run fn inside one database transaction. Throwing rolls everything back. */
  transaction<R>(fn: (tx: SqlRunner) => Promise<R>): Promise<R>;
}
