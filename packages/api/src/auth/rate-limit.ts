/**
 * Fixed-window counters in Redis — PRD-006 §6.2, §10.
 * If Redis is unavailable the limiter fails open (and logs): availability of
 * sign-in beats rate limiting, and the per-session code-attempt cap in
 * Postgres still bounds second-factor guessing.
 */
import type { Redis } from 'ioredis';

export interface RateLimiter {
  /** Counts one hit; returns true while the key is within its limit. */
  hit(key: string, limit: number, windowSeconds: number): Promise<boolean>;
  /** True if the key is already over its limit (does not count a hit). */
  blocked(key: string, limit: number): Promise<boolean>;
  reset(key: string): Promise<void>;
}

export function redisRateLimiter(redis: Redis, namespace = '', log: (m: string) => void = () => {}): RateLimiter {
  const k = (key: string) => `${namespace}rl:${key}`;
  return {
    async hit(key, limit, windowSeconds) {
      try {
        const res = await redis.multi().incr(k(key)).expire(k(key), windowSeconds, 'NX').exec();
        const n = Number(res?.[0]?.[1] ?? 0);
        return n <= limit;
      } catch (err) {
        log(`rate limiter unavailable: ${String(err)}`);
        return true;
      }
    },
    async blocked(key, limit) {
      try {
        return Number((await redis.get(k(key))) ?? 0) >= limit;
      } catch {
        return false;
      }
    },
    async reset(key) {
      try {
        await redis.del(k(key));
      } catch {
        /* best effort */
      }
    },
  };
}
