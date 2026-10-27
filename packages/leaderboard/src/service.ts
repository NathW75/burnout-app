/**
 * Leaderboard service — PRD-003 §6, §7, §9
 *
 * What the API layer calls. Every read checks that the viewer holds an entry
 * in the pool (§7.1). Responses are built field by field: only handles,
 * entry IDs and numbers leave this module, never user IDs, emails or names (§7).
 */

import type { Redis } from 'ioredis';
import type { SqlDatabase, SqlRunner } from './sql';
import { computeBoard, type Board, type BoardRow, type StandingStatus } from './board';
import { boardVersion, readPage, writeBoard, type BoardInfo } from './cache';
import { HandleError, validateHandle } from './handles';

export class LeaderboardAccessError extends Error {
  readonly status = 403;
  constructor() {
    super('You need an entry in this pool to view it.');
    this.name = 'LeaderboardAccessError';
  }
}

export class EntryNotFoundError extends Error {
  readonly status = 404;
  constructor() {
    super('That entry is not in this pool.');
    this.name = 'EntryNotFoundError';
  }
}

export type Arrow = 'up' | 'down' | 'flat' | null;

export interface LeaderboardRowView {
  entryId: string;
  rank: number;
  baselineRank: number | null;
  /** baseline − projected rank; positive = moved up (PRD-003 §4.1). */
  movement: number | null;
  arrow: Arrow;
  handle: string;
  pointsX100: number;
  weekPointsX100: number;
  isMe: boolean;
}

export interface LeaderboardView {
  status: StandingStatus;
  /** "Projected" while LIVE or PROVISIONAL, "Final" once OFFICIAL (§4.1). */
  movementLabel: 'Projected' | 'Final';
  version: string;
  asOf: string;
  currentWeek: number;
  fieldSize: number;
  rows: LeaderboardRowView[];
  source: 'cache' | 'postgres';
}

export type SlotState = 'LOCKED' | 'SUBMITTED' | 'HIDDEN' | 'REOPENED' | 'EMPTY';
export interface PlayerLabel { name: string; team: string; position: string }
export interface LineupSlotView {
  slotKey: string;
  state: SlotState;
  player?: { playerId: string } & Partial<PlayerLabel>;
  pointsX100?: number;
}

const SLOT_ORDER = ['qb', 'rb1', 'rb2', 'wr1', 'wr2', 'wr3', 'te', 'flex', 'k'];

const arrowOf = (movement: number | null): Arrow =>
  movement === null ? null : movement > 0 ? 'up' : movement < 0 ? 'down' : 'flat';

function rowView(r: BoardRow, viewerEntryId: string): LeaderboardRowView {
  const movement = r.baselineRank === null ? null : r.baselineRank - r.rank;
  return {
    entryId: r.entryId,
    rank: r.rank,
    baselineRank: r.baselineRank,
    movement,
    arrow: arrowOf(movement),
    handle: r.handle,
    pointsX100: r.pointsX100,
    weekPointsX100: r.weekPointsX100,
    isMe: r.entryId === viewerEntryId,
  };
}

export interface LeaderboardServiceDeps {
  db: SqlDatabase;
  /** Optional: without Redis (or when it fails) every read is served from Postgres. */
  redis?: Redis;
  /** Key prefix, e.g. 'prod:'. */
  namespace?: string;
  /** Text-only player labels for the reveal (NIL: no images). */
  getPlayerLabels?: (playerIds: string[]) => Promise<Map<string, PlayerLabel>>;
  /** Profanity / impersonation list for handles. */
  handleBlocklist?: ReadonlyArray<string>;
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: object) => void;
}

export function createLeaderboardService(deps: LeaderboardServiceDeps) {
  const ns = deps.namespace ?? '';
  const log = deps.log ?? (() => {});

  async function viewerEntry(q: SqlRunner, viewerUserId: string, poolId: string): Promise<string> {
    const [e] = await q.query<{ id: string }>(
      `SELECT ce.id::text AS id FROM contest_entries ce WHERE ce.pool_id = $1::uuid AND ce.user_id = $2::uuid
          AND NOT EXISTS (SELECT 1 FROM contest_entry_voids v WHERE v.entry_id = ce.id)`,
      [poolId, viewerUserId]
    );
    if (!e) throw new LeaderboardAccessError();
    return e.id;
  }

  /** Full or paged board: cache first, Postgres on miss or any Redis failure. */
  async function loadRows(poolId: string, offset: number, limit: number, extra: string[]) {
    if (deps.redis) {
      try {
        const hit = await readPage(deps.redis, ns, poolId, offset, limit, extra);
        if (hit) return { info: hit.info, rows: hit.rows, extra: hit.extra, source: 'cache' as const };
      } catch (err) {
        log('warn', 'Leaderboard cache read failed; serving from Postgres', { poolId, error: String(err) });
      }
    }
    const board = await computeBoard(deps.db, poolId);
    const info: BoardInfo = {
      poolId, season: board.season, currentWeek: board.currentWeek, status: board.status,
      fieldSize: board.fieldSize, version: boardVersion(board), asOf: new Date().toISOString(),
    };
    const byId = new Map(board.rows.map((r) => [r.entryId, r]));
    return {
      info,
      rows: board.rows.slice(offset, offset + limit),
      extra: new Map(extra.filter((id) => byId.has(id)).map((id) => [id, byId.get(id)!])),
      source: 'postgres' as const,
    };
  }

  return {
    /** Rebuild every pool's cached board for a season. Call on SCORES_UPDATED and after snapshots. */
    async rebuild(season: string, asOf: Date): Promise<BoardInfo[]> {
      if (!deps.redis) return [];
      const pools = await deps.db.query<{ id: string }>(`SELECT id::text AS id FROM contest_pools WHERE season = $1`, [season]);
      const out: BoardInfo[] = [];
      for (const { id } of pools) out.push(await writeBoard(deps.redis, ns, await computeBoard(deps.db, id), asOf));
      return out;
    },

    async getBoard(
      viewerUserId: string,
      poolId: string,
      opts: { offset?: number; limit?: number; ifVersion?: string } = {}
    ): Promise<LeaderboardView | { notModified: true; version: string }> {
      const me = await viewerEntry(deps.db, viewerUserId, poolId);
      const offset = Math.max(0, opts.offset ?? 0);
      const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
      const { info, rows, source } = await loadRows(poolId, offset, limit, []);
      if (opts.ifVersion && opts.ifVersion === info.version) return { notModified: true, version: info.version };
      return {
        status: info.status,
        movementLabel: info.status === 'OFFICIAL' ? 'Final' : 'Projected',
        version: info.version,
        asOf: info.asOf,
        currentWeek: info.currentWeek,
        fieldSize: info.fieldSize,
        rows: rows.map((r) => rowView(r, me)),
        source,
      };
    },

    /** The viewer's standing card (PRD-003 §9). */
    async getMe(viewerUserId: string, poolId: string) {
      const me = await viewerEntry(deps.db, viewerUserId, poolId);
      const { info, rows } = await loadRows(poolId, 0, Number.MAX_SAFE_INTEGER, []);
      const mine = rows.find((r) => r.entryId === me)!;
      const higher = rows.filter((r) => r.pointsX100 > mine.pointsX100).map((r) => r.pointsX100);
      const lower = rows.filter((r) => r.pointsX100 < mine.pointsX100).map((r) => r.pointsX100);
      const field = rows.length;
      const view = rowView(mine, me);
      return {
        status: info.status,
        movementLabel: info.status === 'OFFICIAL' ? ('Final' as const) : ('Projected' as const),
        handle: mine.handle,
        rank: mine.rank,
        baselineRank: view.baselineRank,
        movement: view.movement,
        arrow: view.arrow,
        fieldSize: field,
        /** Share of the rest of the field ranked below you. */
        percentile: field <= 1 ? 100 : Math.floor((lower.length * 100) / (field - 1)),
        pointsX100: mine.pointsX100,
        behindAboveX100: higher.length ? Math.min(...higher) - mine.pointsX100 : null,
        aheadBelowX100: lower.length ? mine.pointsX100 - Math.max(...lower) : null,
        weekPointsX100: mine.weekPointsX100,
        weekRank: mine.weekRank,
        fieldAvgWeekX100: field ? Math.round(rows.reduce((a, r) => a + r.weekPointsX100, 0) / field) : 0,
        topWeekX100: field ? Math.max(...rows.map((r) => r.weekPointsX100)) : 0,
      };
    },

    /** Week ranks for any week (always from Postgres). */
    async getWeek(viewerUserId: string, poolId: string, week: number) {
      const me = await viewerEntry(deps.db, viewerUserId, poolId);
      const rows = await deps.db.query<{ entry_id: string; handle: string; wk: number; rnk: string }>(
        `WITH t AS (
           SELECT ce.id AS entry_id, COALESCE(u.handle, '') AS handle,
                  COALESCE((SELECT w.points_x100 FROM user_week_scores w
                             WHERE w.user_id = ce.user_id AND w.season = p.season AND w.week = $2 AND w.week >= ce.scoring_from_week), 0)::int AS wk
             FROM contest_entries ce JOIN contest_pools p ON p.id = ce.pool_id JOIN users u ON u.id = ce.user_id
            WHERE ce.pool_id = $1::uuid AND NOT EXISTS (SELECT 1 FROM contest_entry_voids v WHERE v.entry_id = ce.id))
         SELECT entry_id::text AS entry_id, handle, wk, RANK() OVER (ORDER BY wk DESC) AS rnk
           FROM t ORDER BY wk DESC, lower(handle), entry_id`,
        [poolId, week]
      );
      return rows.map((r) => ({ entryId: r.entry_id, handle: r.handle, weekPointsX100: Number(r.wk), weekRank: Number(r.rnk), isMe: r.entry_id === me }));
    },

    /**
     * Post-lock reveal (PRD-003 §6). For anyone but the owner, a slot shows a
     * player only once its submission has locked; otherwise it is HIDDEN,
     * with no player, window, or filled/empty information.
     */
    async getLineup(viewerUserId: string, poolId: string, entryId: string, week: number): Promise<LineupSlotView[]> {
      const me = await viewerEntry(deps.db, viewerUserId, poolId);
      const [target] = await deps.db.query<{ user_id: string; season: string }>(
        `SELECT ce.user_id::text AS user_id, p.season FROM contest_entries ce JOIN contest_pools p ON p.id = ce.pool_id
          WHERE ce.id = $1::uuid AND ce.pool_id = $2::uuid AND NOT EXISTS (SELECT 1 FROM contest_entry_voids v WHERE v.entry_id = ce.id)`,
        [entryId, poolId]
      );
      if (!target) throw new EntryNotFoundError();
      const own = entryId === me;

      // The owner query and the reveal query differ: for anyone else, unlocked rows never leave Postgres.
      const subs = await deps.db.query<{
        slot_key: string; player_id: string; game_window_id: string; locked: boolean; voided: boolean; points_x100: number | null;
      }>(
        `SELECT s.slot_key, s.player_id, s.game_window_id::text AS game_window_id,
                (s.locked_at IS NOT NULL) AS locked, (s.void_reason IS NOT NULL) AS voided, sc.points_x100
           FROM season_submissions s
           LEFT JOIN player_game_scores sc
             ON sc.season = s.season AND sc.player_id = s.player_id AND sc.game_window_id = s.game_window_id
          WHERE s.user_id = $1::uuid AND s.season = $2 AND s.week = $3
            AND ($4::boolean OR s.locked_at IS NOT NULL OR s.void_reason IS NOT NULL)`,
        [target.user_id, target.season, week, own]
      );
      const [w] = await deps.db.query<{ open: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM game_windows WHERE season = $1 AND week = $2 AND status = 'pending') AS open`,
        [target.season, week]
      );
      const weekFullyLocked = !w.open;
      const bySlot = new Map(subs.map((s) => [s.slot_key, s]));
      const labels = deps.getPlayerLabels
        ? await deps.getPlayerLabels(subs.filter((s) => own || s.locked).map((s) => s.player_id))
        : new Map<string, PlayerLabel>();

      return SLOT_ORDER.map((slotKey): LineupSlotView => {
        const s = bySlot.get(slotKey);
        if (s?.locked) {
          return { slotKey, state: 'LOCKED', player: { playerId: s.player_id, ...labels.get(s.player_id) }, pointsX100: s.points_x100 ?? 0 };
        }
        if (s?.voided) return { slotKey, state: 'REOPENED' };
        if (own) {
          return s ? { slotKey, state: 'SUBMITTED', player: { playerId: s.player_id, ...labels.get(s.player_id) } } : { slotKey, state: 'EMPTY' };
        }
        return { slotKey, state: weekFullyLocked && !s ? 'EMPTY' : 'HIDDEN' };
      });
    },

    /**
     * Set or change a handle (PRD-003 §7). The database enforces the 2-per-season
     * limit and the 30-day reservation; this maps its refusals to HandleError.
     */
    async setHandle(userId: string, handle: string, season: string, now: Date): Promise<void> {
      validateHandle(handle, deps.handleBlocklist);
      try {
        await deps.db.transaction(async (tx) => {
          const [u] = await tx.query<{ handle: string | null }>(`SELECT handle FROM users WHERE id = $1::uuid FOR UPDATE`, [userId]);
          if (!u) throw new Error(`User ${userId} not found`);
          if (u.handle === handle) return;
          await tx.query(`UPDATE user_handle_history SET valid_to = $2::timestamptz WHERE user_id = $1::uuid AND valid_to IS NULL`, [userId, now]);
          await tx.query(
            `INSERT INTO user_handle_history (user_id, handle, season, is_change, valid_from) VALUES ($1::uuid, $2, $3, $4, $5::timestamptz)`,
            [userId, handle, season, u.handle !== null, now]
          );
          await tx.query(`UPDATE users SET handle = $2 WHERE id = $1::uuid`, [userId, handle]);
        });
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        if (msg.includes('HANDLE_CHANGE_LIMIT')) throw new HandleError('HANDLE_CHANGE_LIMIT', 'You have used both handle changes for this season.');
        if (msg.includes('HANDLE_RESERVED') || msg.includes('users_handle_lower_key')) throw new HandleError('HANDLE_TAKEN', 'That handle is taken.');
        throw err;
      }
    },
  };
}

export type LeaderboardService = ReturnType<typeof createLeaderboardService>;
export type { Board };
