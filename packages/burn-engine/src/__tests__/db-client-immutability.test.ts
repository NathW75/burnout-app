/**
 * AC6, application layer: the client every service uses (createDbClient)
 * rejects every update/delete path on burn_records before the query is sent.
 * The database-level half is in acceptance.test.ts.
 *
 * Requires the generated Prisma client with its query engine
 * (npm run db:generate). Prisma 5 loads the engine when the client is
 * constructed, so this suite cannot run without it. Opt out explicitly with
 * BURNOUT_SKIP_PRISMA_ENGINE=1 only in environments that cannot download the
 * engine; it is never skipped implicitly.
 */
const describeEngine = process.env.BURNOUT_SKIP_PRISMA_ENGINE === '1' ? describe.skip : describe;

describeEngine('AC6 (application layer): createDbClient blocks burn_records mutation', () => {
  // Loaded in beforeAll (Jest runs describe bodies even when skipped), so an
  // opted-out run never instantiates the engine.
  let mod: typeof import('@burnout/db');
  let db: ReturnType<typeof import('@burnout/db').createDbClient>;
  beforeAll(() => {
    mod = require('@burnout/db'); // eslint-disable-line @typescript-eslint/no-var-requires
    // Never connects: the guard throws before any query reaches the database.
    db = mod.createDbClient({ datasourceUrl: 'postgresql://unused@127.0.0.1:1/unused' });
  });
  const where = { id: '00000000-0000-0000-0000-000000000000' };

  it.each([
    ['update', () => db.burnRecord.update({ where, data: { week: 9 } })],
    ['updateMany', () => db.burnRecord.updateMany({ data: { week: 9 } })],
    ['upsert', () =>
      db.burnRecord.upsert({
        where,
        update: { week: 9 },
        create: {
          userId: where.id,
          playerId: 'p',
          season: 's',
          week: 1,
          gameWindowId: where.id,
          submissionId: where.id,
          lockedAt: new Date(),
        },
      })],
    ['delete', () => db.burnRecord.delete({ where })],
    ['deleteMany', () => db.burnRecord.deleteMany({})],
  ])('%s is rejected', async (_name, op) => {
    await expect(op()).rejects.toBeInstanceOf(mod.BurnRecordImmutableError);
  });
});
