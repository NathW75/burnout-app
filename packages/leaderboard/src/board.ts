/**
 * Leaderboard computation from Postgres — PRD-003 §4, §4.1, §8
 *
 * Postgres is the only authority for ranks. Everything here is plain SQL over
 * contest_entries (minus PRD-004 voids) + user_week_scores (PRD-002), ranked with RANK() on integer
 * centipoints. The Redis cache (cache.ts) only stores copies of these results.
 */

import type { SqlRunner } from './sql';

export type StandingStatus = 'LIVE' | 'PROVISIONAL' | 'OFFICIAL';

export interface BoardRow {
  entryId: string;
  userId: string;
  handle: string;
  pointsX100: number;
  weekPointsX100: number;
  rank: number;
  weekRank: number;
  /** Rank at the week's first lock; null for an entry with no baseline yet. */
  baselineRank: number | null;
}

export interface Board {
  poolId: string;
  season: string;
  currentWeek: number;
  status: StandingStatus;
  fieldSize: number;
  /** Display order: points descending, then handle (display only, PRD-003 §4.3). */
  rows: BoardRow[];
}

export class PoolNotFoundError extends Error {
  constructor(poolId: string) {
    super(`Contest pool ${poolId} not found`);
    this.name = 'PoolNotFoundError';
  }
}

/** The current week = the latest week with a locked or final game window. 0 before Week 1 locks. */
export async function currentWeek(q: SqlRunner, season: string): Promise<number> {
  const [r] = await q.query<{ week: number | null }>(
    `SELECT max(week)::int AS week FROM game_windows WHERE season = $1 AND status IN ('locked', 'final')`,
    [season]
  );
  return r?.week ?? 0;
}

/**
 * PRD-003 §4.5:
 *   LIVE        current week still has games in progress or still to be played
 *   PROVISIONAL every game this week is done, but the week has not frozen
 *   OFFICIAL    the week has frozen (or no week has started)
 */
export async function standingStatus(q: SqlRunner, season: string, week: number): Promise<StandingStatus> {
  if (week === 0) return 'OFFICIAL';
  const [r] = await q.query<{ open: boolean; frozen: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM game_windows WHERE season = $1 AND week = $2 AND status IN ('pending', 'locked')) AS open,
            EXISTS (SELECT 1 FROM week_freezes WHERE season = $1 AND week = $2) AS frozen`,
    [season, week]
  );
  if (r.open) return 'LIVE';
  return r.frozen ? 'OFFICIAL' : 'PROVISIONAL';
}

export async function computeBoard(q: SqlRunner, poolId: string): Promise<Board> {
  const [pool] = await q.query<{ season: string }>(`SELECT season FROM contest_pools WHERE id = $1::uuid`, [poolId]);
  if (!pool) throw new PoolNotFoundError(poolId);
  const week = await currentWeek(q, pool.season);
  const status = await standingStatus(q, pool.season, week);

  const rows = await q.query<{
    entry_id: string; user_id: string; handle: string; pts: string; wk: number; rnk: string; wrnk: string; baseline: number | null;
  }>(
    `WITH e AS (
       SELECT ce.id AS entry_id, ce.user_id, COALESCE(u.handle, '') AS handle
         FROM contest_entries ce JOIN users u ON u.id = ce.user_id
        WHERE ce.pool_id = $1::uuid
          AND NOT EXISTS (SELECT 1 FROM contest_entry_voids v WHERE v.entry_id = ce.id)  -- refunded entries leave the field (PRD-004 §10.3)
     ), t AS (
       SELECT e.*,
              COALESCE((SELECT SUM(w.points_x100) FROM user_week_scores w WHERE w.user_id = e.user_id AND w.season = $2), 0)::bigint AS pts,
              COALESCE((SELECT w.points_x100 FROM user_week_scores w WHERE w.user_id = e.user_id AND w.season = $2 AND w.week = $3), 0)::int AS wk
         FROM e
     )
     SELECT t.entry_id::text AS entry_id, t.user_id::text AS user_id, t.handle, t.pts, t.wk,
            RANK() OVER (ORDER BY t.pts DESC) AS rnk,
            RANK() OVER (ORDER BY t.wk DESC) AS wrnk,
            b.rank AS baseline
       FROM t
       LEFT JOIN leaderboard_snapshots b
         ON b.pool_id = $1::uuid AND b.week = $3 AND b.kind = 'week_start' AND b.user_id = t.user_id
      ORDER BY t.pts DESC, lower(t.handle) ASC, t.entry_id ASC`,
    [poolId, pool.season, week]
  );

  return {
    poolId,
    season: pool.season,
    currentWeek: week,
    status,
    fieldSize: rows.length,
    rows: rows.map((r) => ({
      entryId: r.entry_id,
      userId: r.user_id,
      handle: r.handle,
      pointsX100: Number(r.pts),
      weekPointsX100: Number(r.wk),
      rank: Number(r.rnk),
      weekRank: Number(r.wrnk),
      baselineRank: r.baseline === null ? null : Number(r.baseline),
    })),
  };
}

/**
 * Writes a snapshot of every pool in the season (PRD-003 §8). Idempotent per
 * (pool, week, kind): a second call for the same week writes nothing, so the
 * lock hook can run on every window lock and only the first one counts.
 */
export async function writeSnapshots(
  tx: SqlRunner,
  kind: 'week_start' | 'official',
  ctx: { season: string; week: number; serverNow: Date }
): Promise<number> {
  const rows = await tx.query(
    `INSERT INTO leaderboard_snapshots (pool_id, week, kind, user_id, handle, rank, points_x100, taken_at)
     SELECT r.pool_id, $2::int, $3::text, r.user_id, r.handle, r.rnk, r.pts, $4::timestamptz
       FROM (
         SELECT ce.pool_id, ce.user_id, COALESCE(u.handle, '') AS handle,
                COALESCE((SELECT SUM(w.points_x100) FROM user_week_scores w
                           WHERE w.user_id = ce.user_id AND w.season = p.season), 0)::bigint AS pts,
                RANK() OVER (PARTITION BY ce.pool_id ORDER BY
                  COALESCE((SELECT SUM(w.points_x100) FROM user_week_scores w
                             WHERE w.user_id = ce.user_id AND w.season = p.season), 0) DESC) AS rnk
           FROM contest_entries ce
           JOIN contest_pools p ON p.id = ce.pool_id
           JOIN users u ON u.id = ce.user_id
          WHERE p.season = $1::text AND NOT EXISTS (SELECT 1 FROM contest_entry_voids v WHERE v.entry_id = ce.id)
       ) r
      WHERE NOT EXISTS (SELECT 1 FROM leaderboard_snapshots s
                         WHERE s.pool_id = r.pool_id AND s.week = $2::int AND s.kind = $3::text)
     RETURNING 1`,
    [ctx.season, ctx.week, kind, ctx.serverNow]
  );
  return rows.length;
}

/** Hooks to pass into the burn engine (afterLock) and the scoring engine (afterFreeze). */
export const leaderboardHooks = {
  afterLock: (tx: SqlRunner, ctx: { season: string; week: number; serverNow: Date }) =>
    writeSnapshots(tx, 'week_start', ctx).then(() => undefined),
  afterFreeze: (tx: SqlRunner, ctx: { season: string; week: number; serverNow: Date }) =>
    writeSnapshots(tx, 'official', ctx).then(() => undefined),
};
