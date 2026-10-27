/**
 * SQL seam. Structurally identical to @burnout/burn-engine and @burnout/leaderboard's SqlDatabase, so
 * the same Prisma adapter (prismaSqlDatabase) and test harness serve both.
 * Declared here rather than imported to keep the engines independent.
 */
export interface SqlRunner {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface SqlDatabase extends SqlRunner {
  transaction<R>(fn: (tx: SqlRunner) => Promise<R>): Promise<R>;
}
