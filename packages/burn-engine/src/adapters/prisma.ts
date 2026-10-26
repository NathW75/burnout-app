/**
 * Wires the burn engine's SqlDatabase seam to Prisma.
 *
 *   import { createDbClient } from '@burnout/db';
 *   const db = prismaSqlDatabase(createDbClient());
 *   const store = createPostgresBurnStore(db);
 *
 * Parameters go through $queryRawUnsafe's bound-parameter path ($1, $2, …);
 * nothing is ever interpolated into SQL text.
 *
 * Typed structurally so this package does not need the generated client to
 * compile; DbClient from @burnout/db satisfies PrismaRawClient (asserted in
 * __tests__/prisma-adapter.test.ts).
 */

import type { SqlDatabase, SqlRunner } from '../sql';

export interface PrismaRawRunner {
  $queryRawUnsafe<T = unknown>(query: string, ...values: any[]): PromiseLike<T>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface PrismaRawClient extends PrismaRawRunner {
  $transaction<R>(
    fn: (tx: PrismaRawRunner) => Promise<R>,
    options?: { maxWait?: number; timeout?: number }
  ): PromiseLike<R>;
}

/** Interactive transaction limits. Prisma's 5s default is too tight for a full-slate lock. */
export const BURN_ENGINE_TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

function runner(r: PrismaRawRunner): SqlRunner {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      return (await r.$queryRawUnsafe<T[]>(sql, ...params)) as T[];
    },
  };
}

export function prismaSqlDatabase(client: PrismaRawClient): SqlDatabase {
  return {
    ...runner(client),
    async transaction<R>(fn: (tx: SqlRunner) => Promise<R>): Promise<R> {
      return client.$transaction((tx) => fn(runner(tx)), BURN_ENGINE_TX_OPTIONS);
    },
  };
}
