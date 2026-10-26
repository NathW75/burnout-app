/**
 * @burnout/db
 *
 * Prisma client for Burnout League, with the burn_records immutability guard
 * applied at the application layer (PRD-001 §5.3, AC6).
 *
 * Always obtain a client through createDbClient(). Do not instantiate the raw
 * PrismaClient in application code: the raw client does not carry the guard.
 * The database also enforces immutability with a trigger (see the init
 * migration), so raw SQL is blocked too. Two layers, on purpose.
 */

import { Prisma, PrismaClient } from './generated/client';

export { Prisma, PrismaClient };
export type * from './generated/client';

export class BurnRecordImmutableError extends Error {
  readonly code = 'BURN_RECORD_IMMUTABLE';
  constructor(operation: string) {
    super(
      `burn_records is write-once (PRD-001 §5.3). Operation "${operation}" is not permitted from application code.`
    );
    this.name = 'BurnRecordImmutableError';
  }
}

const reject = (operation: string) => () => {
  throw new BurnRecordImmutableError(operation);
};

export function createDbClient(options?: { datasourceUrl?: string }) {
  const base = new PrismaClient(
    options?.datasourceUrl ? { datasourceUrl: options.datasourceUrl } : undefined
  );

  return base.$extends({
    name: 'burn-record-immutability',
    query: {
      burnRecord: {
        update: reject('update'),
        updateMany: reject('updateMany'),
        upsert: reject('upsert'),
        delete: reject('delete'),
        deleteMany: reject('deleteMany'),
      },
    },
  });
}

export type DbClient = ReturnType<typeof createDbClient>;

/** Transaction client handed to callbacks of DbClient.$transaction. */
export type DbTx = Parameters<Parameters<DbClient['$transaction']>[0]>[0];
