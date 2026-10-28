/**
 * Revocable server-side sessions — PRD-006 §5 (D1, D2)
 *
 * The token is returned once and never stored: Postgres keeps its SHA-256.
 * Valid sessions are cached in Redis (≤ 60 s) under the token hash; every
 * change to a session or its user deletes the affected cache keys in the
 * same request, so revocation is immediate.
 */
import type { ApiContext } from '../context';
import type { SqlRunner } from '../sql';
import { randomToken, sha256Hex } from './crypto';

export interface SessionInfo {
  id: string;
  userId: string;
  client: 'web' | 'mobile';
  mfaPending: boolean;
  stepUpAt: Date | null;
  lastSeenAt: Date;
  createdAt: Date;
  expiresAt: Date;
  email: string;
  handle: string | null;
  role: 'user' | 'admin';
  emailVerified: boolean;
  hasFactor: boolean;
}

interface Row {
  id: string; user_id: string; client: 'web' | 'mobile'; mfa_pending: boolean; step_up_at: Date | null;
  last_seen_at: Date; created_at: Date; expires_at: Date; revoked_at: Date | null;
  email: string; handle: string | null; role: 'user' | 'admin'; status: string; email_verified_at: Date | null; has_factor: boolean;
}

const cacheKey = (ctx: ApiContext, tokenHash: string) => `${ctx.ns}sess:${tokenHash}`;

export async function createSession(
  q: SqlRunner,
  ctx: ApiContext,
  s: { userId: string; client: 'web' | 'mobile'; ip?: string; userAgent?: string; mfaPending: boolean }
): Promise<{ token: string; sessionId: string }> {
  const token = randomToken();
  const now = ctx.now();
  const expires = new Date(now.getTime() + (s.mfaPending ? ctx.config.pendingMfaMs : ctx.config.sessionMaxMs));
  const [row] = await q.query<{ id: string }>(
    `INSERT INTO sessions (user_id, token_hash, client, ip_address, user_agent, mfa_pending, created_at, last_seen_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8) RETURNING id::text AS id`,
    [s.userId, sha256Hex(token), s.client, s.ip ?? null, s.userAgent?.slice(0, 500) ?? null, s.mfaPending, now, expires]
  );
  return { token, sessionId: row.id };
}

function toInfo(r: Row): SessionInfo {
  return {
    id: r.id, userId: r.user_id, client: r.client, mfaPending: r.mfa_pending,
    stepUpAt: r.step_up_at ? new Date(r.step_up_at) : null, lastSeenAt: new Date(r.last_seen_at),
    createdAt: new Date(r.created_at), expiresAt: new Date(r.expires_at),
    email: r.email, handle: r.handle, role: r.role, emailVerified: r.email_verified_at !== null, hasFactor: r.has_factor,
  };
}

async function loadRow(q: SqlRunner, tokenHash: string): Promise<Row | null> {
  const [r] = await q.query<Row>(
    `SELECT s.id::text AS id, s.user_id::text AS user_id, s.client, s.mfa_pending, s.step_up_at, s.last_seen_at,
            s.created_at, s.expires_at, s.revoked_at, u.email, u.handle, u.role, u.status, u.email_verified_at,
            EXISTS (SELECT 1 FROM auth_factors f WHERE f.user_id = u.id AND f.confirmed_at IS NOT NULL AND f.disabled_at IS NULL) AS has_factor
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1`,
    [tokenHash]
  );
  return r ?? null;
}

function isValid(ctx: ApiContext, r: Row, now: Date): boolean {
  return (
    r.revoked_at === null &&
    r.status === 'active' &&
    now < new Date(r.expires_at) &&
    now.getTime() - new Date(r.last_seen_at).getTime() < ctx.config.sessionIdleMs
  );
}

/** Resolves a presented token to a live session, or null. Refreshes last_seen_at at most every 5 minutes. */
export async function resolveSession(ctx: ApiContext, token: string): Promise<SessionInfo | null> {
  if (!token || token.length > 200) return null;
  const hash = sha256Hex(token);
  const now = ctx.now();
  let row: Row | null = null;
  if (ctx.redis) {
    try {
      const cached = await ctx.redis.get(cacheKey(ctx, hash));
      if (cached) row = JSON.parse(cached) as Row;
    } catch (err) {
      ctx.log('warn', 'session cache unavailable', { error: String(err) });
    }
  }
  if (!row) {
    row = await loadRow(ctx.db, hash);
    if (!row) return null;
    if (ctx.redis && isValid(ctx, row, now)) {
      try {
        await ctx.redis.set(cacheKey(ctx, hash), JSON.stringify(row), 'EX', ctx.config.sessionCacheSeconds);
      } catch {
        /* cache is optional */
      }
    }
  }
  if (!isValid(ctx, row, now)) return null;

  if (now.getTime() - new Date(row.last_seen_at).getTime() > ctx.config.touchIntervalMs) {
    await ctx.db.query(`UPDATE sessions SET last_seen_at = $2 WHERE id = $1::uuid AND revoked_at IS NULL`, [row.id, now]);
    await dropCache(ctx, [hash]);
    row = { ...row, last_seen_at: now };
  }
  return toInfo(row);
}

async function dropCache(ctx: ApiContext, hashes: string[]): Promise<void> {
  if (!ctx.redis || hashes.length === 0) return;
  try {
    await ctx.redis.del(...hashes.map((h) => cacheKey(ctx, h)));
  } catch (err) {
    ctx.log('error', 'session cache invalidation failed', { error: String(err) });
  }
}

/** Drops cached copies of every live session of a user (call after any change to the user or their factors). */
export async function invalidateUserSessions(ctx: ApiContext, q: SqlRunner, userId: string): Promise<void> {
  const rows = await q.query<{ token_hash: string }>(`SELECT token_hash FROM sessions WHERE user_id = $1::uuid AND revoked_at IS NULL`, [userId]);
  await dropCache(ctx, rows.map((r) => r.token_hash));
}

/**
 * Revokes sessions and drops their cache entries. Scope: one session, all of
 * a user's sessions, or all but one.
 */
export async function revokeSessions(
  ctx: ApiContext,
  q: SqlRunner,
  scope: { sessionId: string; userId?: string } | { userId: string; exceptSessionId?: string }
): Promise<number> {
  const now = ctx.now();
  const rows =
    'sessionId' in scope
      ? await q.query<{ token_hash: string }>(
          `UPDATE sessions SET revoked_at = $2 WHERE id = $1::uuid AND revoked_at IS NULL AND ($3::uuid IS NULL OR user_id = $3::uuid) RETURNING token_hash`,
          [scope.sessionId, now, scope.userId ?? null]
        )
      : await q.query<{ token_hash: string }>(
          `UPDATE sessions SET revoked_at = $2 WHERE user_id = $1::uuid AND revoked_at IS NULL AND id IS DISTINCT FROM $3::uuid RETURNING token_hash`,
          [scope.userId, now, scope.exceptSessionId ?? null]
        );
  // Signed out everywhere (logout-all, password reset, suspension): no device keeps getting this account's push (PRD-008 §9).
  if ('userId' in scope && !('sessionId' in scope) && !scope.exceptSessionId) {
    await q.query(`UPDATE push_subscriptions SET revoked_at = $2 WHERE user_id = $1::uuid AND revoked_at IS NULL`, [scope.userId, now]);
  }
  await dropCache(ctx, rows.map((r) => r.token_hash));
  return rows.length;
}

/** Changes a session in place (MFA completion, step-up) and drops its cache entry. */
export async function updateSession(ctx: ApiContext, q: SqlRunner, sessionId: string, set: { mfaPending?: boolean; stepUpAt?: Date; expiresAt?: Date }): Promise<void> {
  const [r] = await q.query<{ token_hash: string }>(
    `UPDATE sessions SET mfa_pending = COALESCE($2, mfa_pending), step_up_at = COALESCE($3, step_up_at), expires_at = COALESCE($4, expires_at)
      WHERE id = $1::uuid AND revoked_at IS NULL RETURNING token_hash`,
    [sessionId, set.mfaPending ?? null, set.stepUpAt ?? null, set.expiresAt ?? null]
  );
  if (r) await dropCache(ctx, [r.token_hash]);
}
