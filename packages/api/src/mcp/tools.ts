/**
 * The four Phase 1a tools (PRD-011 §6). Every handler runs inside a READ ONLY
 * transaction, so a write anywhere on this path fails in Postgres.
 *
 * Rules for every output: players as text only (NIL); managers by handle
 * only, never email or real name; another manager's unlocked pick never
 * appears; field figures only above the 50-manager floor, rounded to whole
 * percentages.
 */
import { createLeaderboardService, LeaderboardAccessError } from '@burnout/leaderboard';
import type { ApiContext } from '../context';
import { INACTIVE_STATUSES, SELECTABLE_POSITIONS } from '../players/msf-players';
import { availablePlayerIds, getPool } from '../players/pool';
import { currentSeason, fieldBoard } from '../season/views';
import type { SqlDatabase } from '../sql';

export const FIELD_FLOOR = 50;
export const ELITE_TOP = 20;
const SLOT_ORDER = ['qb', 'rb1', 'rb2', 'wr1', 'wr2', 'wr3', 'te', 'flex', 'k'];
type Position = (typeof SELECTABLE_POSITIONS)[number];

/** A tool's own refusal (e.g. a pool you haven't entered): returned to the AI as an error result, not a protocol error. */
export class ToolError extends Error {}

/** Runs fn with a context whose database is one READ ONLY transaction (PRD-011 §9). */
export async function readOnly<T>(ctx: ApiContext, fn: (ro: ApiContext) => Promise<T>): Promise<T> {
  return ctx.db.transaction(async (tx) => {
    await tx.query('SET TRANSACTION READ ONLY');
    const db: SqlDatabase = { query: (sql, params) => tx.query(sql, params), transaction: (f) => f(tx) };
    const leaderboard = createLeaderboardService({ db, log: ctx.log });
    return fn({ ...ctx, db, leaderboard });
  });
}

const pts = (x100: number | null | undefined) => (x100 === null || x100 === undefined ? null : Math.round(Number(x100)) / 100);
const pct = (n: number, d: number) => Math.round((n * 100) / d);

async function weekNow(ctx: ApiContext): Promise<number> {
  return (await currentSeason(ctx)).currentWeek ?? 1;
}

/** Season-to-date points by person (one ID per person, aliases folded in). */
async function seasonPoints(ctx: ApiContext, season: string): Promise<Map<string, number>> {
  const rows = await ctx.db.query<{ person: string; x100: string }>(
    `SELECT COALESCE(p.canonical_id, p.msf_player_id) AS person, sum(s.points_x100)::bigint::text AS x100
       FROM player_game_scores s JOIN nfl_players p ON p.msf_player_id = s.player_id
      WHERE s.season = $1 GROUP BY 1`,
    [season]
  );
  return new Map(rows.map((r) => [r.person, Number(r.x100)]));
}

/** Each team's bye: the scheduled week (1–18) with no game for it. */
async function byeWeeks(ctx: ApiContext, season: string): Promise<Map<string, number>> {
  const rows = await ctx.db.query<{ team: string; week: number }>(
    `WITH weeks AS (SELECT DISTINCT week FROM nfl_games WHERE season = $1),
          teams AS (SELECT home_team AS team FROM nfl_games WHERE season = $1 UNION SELECT away_team FROM nfl_games WHERE season = $1),
          played AS (SELECT week, home_team AS team FROM nfl_games WHERE season = $1 UNION SELECT week, away_team FROM nfl_games WHERE season = $1)
     SELECT t.team, w.week FROM teams t CROSS JOIN weeks w
      WHERE NOT EXISTS (SELECT 1 FROM played x WHERE x.team = t.team AND x.week = w.week)
      ORDER BY t.team, w.week`,
    [season]
  );
  const out = new Map<string, number>();
  for (const r of rows) if (!out.has(r.team)) out.set(r.team, r.week);
  return out;
}

// ── get_my_pool (§6.1) ──────────────────────────────────────────────────────

export interface MyPoolArgs {
  position?: Position;
  week?: number;
  state?: 'available' | 'unavailable' | 'locked_pending_final' | 'burned';
  limit?: number;
}

export async function getMyPool(ctx: ApiContext, userId: string, args: MyPoolArgs) {
  const season = ctx.config.currentSeason;
  const current = await weekNow(ctx);
  const week = args.week ?? current;
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 300);
  const cards = await getPool(ctx, userId, season, week);
  const burns = await ctx.db.query<{ person: string; week: number }>(
    `SELECT COALESCE(p.canonical_id, p.msf_player_id) AS person, min(b.week)::int AS week
       FROM burn_records b JOIN nfl_players p ON p.msf_player_id = b.player_id
      WHERE b.user_id = $1::uuid AND b.season = $2 GROUP BY 1`,
    [userId, season]
  );
  const burnedIn = new Map(burns.map((b) => [b.person, b.week]));
  const points = await seasonPoints(ctx, season);
  const byes = await byeWeeks(ctx, season);

  type Player = { player_id: string; name: string; team: string; position: string; bye_week: number | null; injury_status: string; season_points: number; projected_points: null };
  const lists = {
    available: [] as Player[],
    unavailable: [] as Array<Player & { reason: string }>,
    locked_pending_final: [] as Player[],
    burned: [] as Array<Player & { burned_week: number }>,
  };
  const elite = new Map<string, Set<string>>(); // position → top players by season points
  for (const pos of SELECTABLE_POSITIONS) {
    const top = cards.filter((c) => c.position === pos).sort((a, b) => (points.get(b.playerId) ?? 0) - (points.get(a.playerId) ?? 0)).slice(0, ELITE_TOP);
    elite.set(pos, new Set(top.filter((c) => (points.get(c.playerId) ?? 0) > 0).map((c) => c.playerId)));
  }
  const eliteRemaining: Record<string, number> = {};

  for (const c of cards) {
    const p: Player = {
      player_id: c.playerId, name: c.name, team: c.team, position: c.position, bye_week: byes.get(c.team) ?? null,
      injury_status: c.injuryStatus, season_points: pts(points.get(c.playerId) ?? 0)!, projected_points: null,
    };
    const bw = burnedIn.get(c.playerId);
    let state: keyof typeof lists;
    if (bw !== undefined && bw <= week) {
      lists.burned.push({ ...p, burned_week: bw });
      state = 'burned';
    } else if (c.burnState === 'locked') {
      lists.locked_pending_final.push(p);
      state = 'locked_pending_final';
    } else {
      const reason = INACTIVE_STATUSES.has(c.injuryStatus) ? 'INACTIVE' : c.bye ? 'NO_GAME_THIS_WEEK' : week === current && !c.windowOpen ? 'GAME_STARTED' : null;
      if (reason) lists.unavailable.push({ ...p, reason });
      else lists.available.push(p);
      state = reason ? 'unavailable' : 'available';
    }
    if (state !== 'burned' && elite.get(c.position)?.has(c.playerId)) eliteRemaining[c.position] = (eliteRemaining[c.position] ?? 0) + 1;
  }
  const byPoints = (a: Player, b: Player) => b.season_points - a.season_points || a.name.localeCompare(b.name);
  lists.available.sort(byPoints);
  lists.unavailable.sort(byPoints);
  lists.locked_pending_final.sort(byPoints);
  lists.burned.sort((a, b) => a.burned_week - b.burned_week || a.name.localeCompare(b.name));

  const keep = <T extends Player>(xs: T[]) => (args.position ? xs.filter((x) => x.position === args.position) : xs);
  const states = (['available', 'unavailable', 'locked_pending_final', 'burned'] as const).filter((s) => !args.state || s === args.state);
  const counts = Object.fromEntries((['available', 'unavailable', 'locked_pending_final', 'burned'] as const).map((s) => [s, keep(lists[s] as Player[]).length]));
  const players = Object.fromEntries(states.map((s) => [s, keep(lists[s] as Player[]).slice(0, limit)]));

  const mine = await ctx.db.query<{ slot_key: string; player_id: string; name: string | null; position: string | null; team: string | null; label: string; scheduled_et: Date; locked: boolean; void_reason: string | null }>(
    `SELECT s.slot_key, s.player_id, p.first_name || ' ' || p.last_name AS name, p.position, p.team, w.label, w.scheduled_et,
            (s.locked_at IS NOT NULL) AS locked, s.void_reason
       FROM season_submissions s JOIN game_windows w ON w.id = s.game_window_id
       LEFT JOIN nfl_players p ON p.msf_player_id = s.player_id
      WHERE s.user_id = $1::uuid AND s.season = $2 AND s.week = $3`,
    [userId, season, current]
  );
  const bySlot = new Map(mine.map((m) => [m.slot_key, m]));
  return {
    season,
    week,
    summary: {
      total_available: counts.available,
      total_unavailable: counts.unavailable,
      total_locked_pending_final: counts.locked_pending_final,
      total_burned: counts.burned,
      elite_remaining: Object.fromEntries((args.position ? [args.position] : [...SELECTABLE_POSITIONS]).map((pos) => [pos, eliteRemaining[pos] ?? 0])),
      elite_basis: `top ${ELITE_TOP} at each position by points so far this season`,
    },
    players,
    limit_per_list: limit,
    my_lineup_this_week: {
      week: current,
      slots: SLOT_ORDER.map((slot) => {
        const m = bySlot.get(slot);
        return m
          ? { slot, player_id: m.player_id, name: m.name, position: m.position, team: m.team, window: m.label, locks_at: new Date(m.scheduled_et).toISOString(), locked: m.locked, voided: m.void_reason !== null }
          : { slot, player_id: null, name: null, position: null, team: null, window: null, locks_at: null, locked: false, voided: false };
      }),
    },
  };
}

// ── get_burn_history (§6.2) ─────────────────────────────────────────────────

export async function getBurnHistory(ctx: ApiContext, userId: string, args: { week?: number; position?: Position }) {
  const season = ctx.config.currentSeason;
  const rows = await ctx.db.query<{
    player_id: string; person: string; name: string | null; position: string | null; slot_key: string | null; week: number;
    submitted_at: Date | null; locked_at: Date; burned_at: Date; x100: number | null;
  }>(
    `SELECT b.player_id, COALESCE(p.canonical_id, p.msf_player_id) AS person, p.first_name || ' ' || p.last_name AS name, p.position,
            s.slot_key, b.week, s.submitted_at, b.locked_at, b.burned_at, sc.points_x100 AS x100
       FROM burn_records b
       LEFT JOIN nfl_players p ON p.msf_player_id = b.player_id
       LEFT JOIN season_submissions s ON s.id = b.submission_id
       LEFT JOIN player_game_scores sc ON sc.season = b.season AND sc.player_id = b.player_id AND sc.game_window_id = b.game_window_id
      WHERE b.user_id = $1::uuid AND b.season = $2 AND ($3::int IS NULL OR b.week = $3) AND ($4::text IS NULL OR p.position = $4)
      ORDER BY b.week, b.burned_at, b.player_id`,
    [userId, season, args.week ?? null, args.position ?? null]
  );
  // The field for each burn's week: everyone with a locked pick that week; and how many of them started the same person.
  const field = await ctx.db.query<{ week: number; person: string; managers: number; starters: number }>(
    `WITH locked AS (
       SELECT s.user_id, s.week, COALESCE(p.canonical_id, p.msf_player_id) AS person
         FROM season_submissions s JOIN nfl_players p ON p.msf_player_id = s.player_id
        WHERE s.season = $1 AND s.locked_at IS NOT NULL AND s.void_reason IS NULL AND s.week = ANY ($2::int[])),
     wk AS (SELECT week, count(DISTINCT user_id)::int AS managers FROM locked GROUP BY week)
     SELECT l.week, l.person, wk.managers, count(DISTINCT l.user_id)::int AS starters
       FROM locked l JOIN wk ON wk.week = l.week
      WHERE l.person = ANY ($3::text[])
      GROUP BY l.week, l.person, wk.managers`,
    [season, [...new Set(rows.map((r) => r.week))], [...new Set(rows.map((r) => r.person))]]
  );
  const fieldOf = new Map(field.map((f) => [`${f.week}:${f.person}`, f]));
  const burns = rows.map((r) => {
    const f = fieldOf.get(`${r.week}:${r.person}`);
    const enough = !!f && f.managers >= FIELD_FLOOR;
    return {
      player_id: r.player_id, name: r.name, position: r.position, slot: r.slot_key, week: r.week,
      submitted_at: r.submitted_at ? new Date(r.submitted_at).toISOString() : null,
      locked_at: new Date(r.locked_at).toISOString(), burned_at: new Date(r.burned_at).toISOString(),
      points: pts(r.x100 ?? 0)!,
      field_start_rate_at_lock: enough ? pct(f!.starters, f!.managers) : null,
      field_below_minimum: !enough,
      regret_index: null,
    };
  });
  const total = burns.reduce((a, b) => a + b.points, 0);
  return {
    season,
    burns,
    summary: { total_burns: burns.length, total_points: Math.round(total * 100) / 100, avg_points_per_burn: burns.length ? Math.round((total / burns.length) * 100) / 100 : null },
  };
}

// ── get_pool_standings (§6.3) ───────────────────────────────────────────────

export async function getPoolStandings(ctx: ApiContext, userId: string, args: { pool_id?: string }) {
  const season = ctx.config.currentSeason;
  const entered = await ctx.db.query<{ id: string; name: string; buy_in_cents: number }>(
    `SELECT p.id::text AS id, p.name, p.buy_in_cents FROM contest_pools p
      WHERE p.season = $1 AND p.status <> 'draft' AND ($3::uuid IS NULL OR p.id = $3::uuid)
        AND EXISTS (SELECT 1 FROM contest_entries ce WHERE ce.pool_id = p.id AND ce.user_id = $2::uuid
                      AND NOT EXISTS (SELECT 1 FROM contest_entry_voids v WHERE v.entry_id = ce.id))
      ORDER BY p.buy_in_cents, p.name`,
    [season, userId, args.pool_id ?? null]
  );
  if (args.pool_id && !entered.length) throw new ToolError('You haven’t entered that pool, so its standings aren’t available to you.');
  const pools = [];
  for (const p of entered) {
    try {
      const board = await ctx.leaderboard.getBoard(userId, p.id, { limit: 100 });
      if ('notModified' in board) continue;
      const me = await ctx.leaderboard.getMe(userId, p.id);
      const row = (r: { rank: number; handle: string; pointsX100: number; weekPointsX100: number; isMe: boolean; movement: number | null }) => ({
        rank: r.rank, handle: r.handle, total_points: pts(r.pointsX100)!, week_points: pts(r.weekPointsX100)!, is_me: r.isMe, rank_change: r.movement,
      });
      const rows = board.rows.map(row);
      if (!rows.some((r) => r.is_me)) rows.push(row({ rank: me.rank, handle: me.handle, pointsX100: me.pointsX100, weekPointsX100: me.weekPointsX100, isMe: true, movement: me.movement }));
      pools.push({
        pool_id: p.id, name: p.name, buy_in: p.buy_in_cents / 100, week: board.currentWeek, status: board.status,
        total_entrants: board.fieldSize, my_rank: me.rank, my_total_points: pts(me.pointsX100)!, rows,
      });
    } catch (err) {
      if (!(err instanceof LeaderboardAccessError)) throw err;
    }
  }
  // The season field board: the same view every signed-in manager sees in the app (handles only).
  const fb = await fieldBoard(ctx, userId, season, 0, 10);
  return {
    season,
    free_play: entered.length === 0,
    pools,
    season_field: {
      week: fb.week,
      field_size: fb.fieldSize,
      my_rank: fb.me?.rank ?? null,
      my_total_points: fb.me ? pts(fb.me.pointsX100) : null,
      top: fb.rows.map((r) => ({ rank: r.rank, handle: r.handle, total_points: pts(r.pointsX100)!, week_points: pts(r.weekPointsX100)!, is_me: r.isMe })),
    },
  };
}

// ── get_field_burn_rates (§6.4, §6.5) ───────────────────────────────────────

export interface FieldArgs {
  scope?: 'season' | 'pool';
  pool_id?: string;
  position?: Position;
  week?: number;
  top_n?: number;
}

export async function getFieldBurnRates(ctx: ApiContext, userId: string, args: FieldArgs) {
  const season = ctx.config.currentSeason;
  const scope = args.scope ?? 'season';
  const topN = Math.min(Math.max(args.top_n ?? 20, 1), 100);
  if (scope === 'pool') {
    if (!args.pool_id) throw new ToolError('scope "pool" needs a pool_id.');
    const [ok] = await ctx.db.query(
      `SELECT 1 FROM contest_entries ce JOIN contest_pools p ON p.id = ce.pool_id
        WHERE ce.pool_id = $1::uuid AND ce.user_id = $2::uuid AND p.season = $3
          AND NOT EXISTS (SELECT 1 FROM contest_entry_voids v WHERE v.entry_id = ce.id)`,
      [args.pool_id, userId, season]
    );
    if (!ok) throw new ToolError('You haven’t entered that pool, so its field isn’t available to you.');
  }
  const [{ latest }] = await ctx.db.query<{ latest: number | null }>(`SELECT max(week)::int AS latest FROM burn_records WHERE season = $1`, [season]);
  const throughWeek = args.week ?? latest ?? (await weekNow(ctx));
  const poolId = scope === 'pool' ? args.pool_id! : null;

  // The field: managers in scope with a locked pick through the week; and those with one in the week itself.
  const [sizes] = await ctx.db.query<{ season_managers: number; week_managers: number }>(
    `WITH scoped AS (
       SELECT DISTINCT s.user_id, s.week FROM season_submissions s
        WHERE s.season = $1 AND s.locked_at IS NOT NULL AND s.void_reason IS NULL AND s.week <= $2
          AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM contest_entries ce WHERE ce.pool_id = $3::uuid AND ce.user_id = s.user_id
                                             AND NOT EXISTS (SELECT 1 FROM contest_entry_voids v WHERE v.entry_id = ce.id))))
     SELECT count(DISTINCT user_id)::int AS season_managers, count(DISTINCT user_id) FILTER (WHERE week = $2)::int AS week_managers FROM scoped`,
    [season, throughWeek, poolId]
  );
  // The floor applies to every slice: the season field and the week's field must each have 50 managers.
  if (sizes.season_managers < FIELD_FLOOR || sizes.week_managers < FIELD_FLOOR) {
    return { season, scope, pool_id: poolId, week: throughWeek, field_below_minimum: true, minimum_field: FIELD_FLOOR };
  }
  const rows = await ctx.db.query<{ person: string; name: string; team: string | null; position: string; burned_through: number; burned_week: number }>(
    `WITH field AS (
       SELECT DISTINCT s.user_id FROM season_submissions s
        WHERE s.season = $1 AND s.locked_at IS NOT NULL AND s.void_reason IS NULL AND s.week <= $2
          AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM contest_entries ce WHERE ce.pool_id = $3::uuid AND ce.user_id = s.user_id
                                             AND NOT EXISTS (SELECT 1 FROM contest_entry_voids v WHERE v.entry_id = ce.id)))),
     burns AS (
       SELECT DISTINCT b.user_id, b.week, COALESCE(p.canonical_id, p.msf_player_id) AS person
         FROM burn_records b JOIN nfl_players p ON p.msf_player_id = b.player_id JOIN field f ON f.user_id = b.user_id
        WHERE b.season = $1 AND b.week <= $2)
     SELECT b.person, c.first_name || ' ' || c.last_name AS name, c.team, c.position,
            count(DISTINCT b.user_id)::int AS burned_through,
            count(DISTINCT b.user_id) FILTER (WHERE b.week = $2)::int AS burned_week
       FROM burns b JOIN nfl_players c ON c.msf_player_id = b.person
      WHERE ($4::text IS NULL OR c.position = $4)
      GROUP BY b.person, c.first_name, c.last_name, c.team, c.position`,
    [season, throughWeek, poolId, args.position ?? null]
  );
  const mineBurned = new Set((await ctx.db.query<{ person: string }>(
    `SELECT DISTINCT COALESCE(p.canonical_id, p.msf_player_id) AS person FROM burn_records b JOIN nfl_players p ON p.msf_player_id = b.player_id
      WHERE b.user_id = $1::uuid AND b.season = $2`,
    [userId, season]
  )).map((r) => r.person));
  const available = await availablePlayerIds(ctx.db, userId, season);
  const players = rows
    .map((r) => ({
      player_id: r.person, name: r.name, team: r.team, position: r.position,
      cumulative_burn_rate: pct(r.burned_through, sizes.season_managers),
      week_burn_rate: pct(r.burned_week, sizes.week_managers),
      i_have_burned: mineBurned.has(r.person),
      i_have_available: available.has(r.person),
    }))
    .sort((a, b) => b.cumulative_burn_rate - a.cumulative_burn_rate || b.week_burn_rate - a.week_burn_rate || a.name.localeCompare(b.name));
  const positional_summary = Object.fromEntries(
    (args.position ? [args.position] : [...SELECTABLE_POSITIONS])
      .map((pos) => {
        const at = players.filter((p) => p.position === pos);
        return [pos, at.length
          ? { avg_burn_rate: Math.round(at.reduce((a, p) => a + p.cumulative_burn_rate, 0) / at.length), most_burned: { player_id: at[0].player_id, name: at[0].name, cumulative_burn_rate: at[0].cumulative_burn_rate } }
          : { avg_burn_rate: 0, most_burned: null }];
      })
  );
  return {
    season, scope, pool_id: poolId, week: throughWeek, field_below_minimum: false,
    field_size: Math.floor(sizes.season_managers / 10) * 10,
    players: players.slice(0, topN),
    positional_summary,
  };
}
