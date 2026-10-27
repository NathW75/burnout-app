/**
 * Redis test helper: a real Redis (TEST_REDIS_URL) with a unique key
 * namespace per test, deleted on close. Suites that need Redis gate on
 * describeDbRedis so they skip, not fail, where it isn't configured.
 */
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';

export const describeDbRedis = process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL ? describe : describe.skip;

export interface TestRedis {
  redis: Redis;
  namespace: string;
  close: () => Promise<void>;
}

export async function createTestRedis(): Promise<TestRedis> {
  const redis = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
  const namespace = `test:${randomUUID().slice(0, 8)}:`;
  return {
    redis,
    namespace,
    async close() {
      let cursor = '0';
      do {
        const [next, found] = await redis.scan(cursor, 'MATCH', `${namespace}*`, 'COUNT', 500);
        if (found.length) await redis.del(...found);
        cursor = next;
      } while (cursor !== '0');
      await redis.quit();
    },
  };
}
