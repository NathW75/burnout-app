/**
 * The Prisma wiring: compile-time proof that the real DbClient satisfies the
 * adapter's structural type, plus a check that parameters are passed as bound
 * values and transactions get the burn engine's limits.
 */
import type { DbClient } from '@burnout/db';
import { BURN_ENGINE_TX_OPTIONS, prismaSqlDatabase, type PrismaRawClient } from '../adapters/prisma';

// Compile-time assertion: fails `tsc` if DbClient stops fitting the adapter.
export const dbClientFitsAdapter = (c: DbClient): PrismaRawClient => c;

describe('prismaSqlDatabase', () => {
  it('binds parameters positionally and runs transactions with burn-engine limits', async () => {
    const calls: unknown[][] = [];
    const runner = {
      $queryRawUnsafe: async <T>(sql: string, ...values: unknown[]): Promise<T> => {
        calls.push([sql, ...values]);
        return [{ ok: 1 }] as T;
      },
    };
    let txOptions: unknown;
    const client: PrismaRawClient = {
      ...runner,
      $transaction: async (fn, options) => {
        txOptions = options;
        return fn(runner);
      },
    };
    const db = prismaSqlDatabase(client);
    const at = new Date('2026-11-01T18:00:00Z');

    expect(await db.query('SELECT $1::uuid, $2::timestamptz', ['id-1', at])).toEqual([{ ok: 1 }]);
    await db.transaction((tx) => tx.query('UPDATE x SET y = $1', ["Robert'); DROP TABLE burn_records;--"]));

    expect(calls).toEqual([
      ['SELECT $1::uuid, $2::timestamptz', 'id-1', at],
      ['UPDATE x SET y = $1', "Robert'); DROP TABLE burn_records;--"],
    ]);
    expect(txOptions).toEqual(BURN_ENGINE_TX_OPTIONS);
  });
});
