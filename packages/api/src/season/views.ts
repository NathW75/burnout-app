/**
 * Read endpoints the web app needs — PRD-007 §8.1–§8.3
 *
 * Everything here reads data and changes nothing, except marking inbox items read.
 * Visibility rules are enforced in the SQL, never by the client:
 * another manager's unlocked pick never leaves Postgres (PRD-003 §6).
 */
import { createHash } from 'node:crypto';
import { CURRENT_RULES, RULES_BY_VERSION, scoreBreakdown, STAT_FIELDS, STAT_GROUPS, STAT_LABELS, type StatLine } from '@burnout/scoring-engine';
import type { ApiContext } from '../context';
import { HttpError, notFound } from '../errors';

const SLOT_ORDER = ['qb', 'rb1', 'rb2', 'wr1', 'wr2', 'wr3', 'te', 'flex', 'k'] as const;

// ── §8.2 season, week and windows ───────────────────────────────────────────

export interface WeekSummary {
  week: number;
  firstLock: Date;
  lastLock: Date;
  /** upcoming: nothing locked yet · live: some windows locked or pending · complete: every window final or canceled */
  status: 'upcoming' | 'live' | 'complete';
}

export async function currentSeason(ctx: ApiContext): Promise<{ season: string; currentWeek: number | null; weeks: WeekSummary[] }> {
  const season = ctx.config.currentSeason;
  const now = ctx.now();
  const rows = await ctx.db.query<{ week: number; first_lock: Date; last_lock: Date; pending: number; done: number; total: number }>(
    `SELECT week, min(scheduled_et) AS first_lock, max(scheduled_et) AS last_lock,
            count(*) FILTER (WHERE status = 'pending')::int AS pending,
            count(*) FILTER (WHERE status IN ('final', 'canceled'))::int AS done,
            count(*)::int AS total
       FROM game_windows WHERE season = $1 AND status <> 'postponed' AND cardinality(msf_game_ids) > 0
      GROUP BY week ORDER BY week`,
    [season]
  );
  const weeks: WeekSummary[] = rows.map((r) => ({
    week: r.week,
    firstLock: r.first_lock,
    lastLock: r.last_lock,
    status: r.done === r.total ? 'complete' : r.pending === r.total && new Date(r.first_lock) > now ? 'upcoming' : 'live',
  }));
  // The current week: the earliest week that still has a window to lock; after the season, the last week.
  const [next] = await ctx.db.query<{ week: number }>(
    `SELECT week FROM game_windows WHERE season = $1 AND status = 'pending' AND scheduled_et > $2 AND cardinality(msf_game_ids) > 0
      ORDER BY scheduled_et LIMIT 1`,
    [season, now]
  );
  return { season, currentWeek: next?.week ?? weeks.at(-1)?.week ?? null, weeks };
}

export async function weekWindows(ctx: ApiContext, season: string, week: number) {
  const rows = await ctx.db.query<{ id: string; label: string; scheduled_et: Date; status: string; games: Array<{ away: string | null; home: string | null }> | null }>(
    `SELECT w.id::text AS id, w.label, w.scheduled_et, w.status,
            (SELECT json_agg(json_build_object('away', g.away_team, 'home', g.home_team) ORDER BY g.scheduled_start, g.msf_game_id)
               FROM nfl_games g WHERE g.game_window_id = w.id) AS games
       FROM game_windows w
      WHERE w.season = $1 AND w.week = $2 AND w.status <> 'postponed' AND cardinality(w.msf_game_ids) > 0
      ORDER BY w.scheduled_et`,
    [season, week]
  );
  return rows.map((r) => ({ id: r.id, label: r.label, scheduledEt: r.scheduled_et, status: r.status, games: r.games ?? [] }));
}

// ── §8.1 season field leaderboard ───────────────────────────────────────────

/**
 * Everyone with at least one confirmed lineup this season, ranked on exact
 * centipoints with RANK() (ties share a rank; display order by handle, then
 * id), the same rules as PRD-003 §4. Not prize standings: pool boards are.
 */
const FIELD_SQL = `
  WITH field AS (
    SELECT DISTINCT s.user_id FROM season_submissions s WHERE s.season = $1
  ), t AS (
    SELECT f.user_id, u.handle,
           COALESCE((SELECT SUM(w.points_x100) FROM user_week_scores w WHERE w.user_id = f.user_id AND w.season = $1), 0)::bigint AS pts,
           COALESCE((SELECT w.points_x100 FROM user_week_scores w WHERE w.user_id = f.user_id AND w.season = $1 AND w.week = $2), 0)::int AS wk
      FROM field f JOIN users u ON u.id = f.user_id
     WHERE u.handle IS NOT NULL AND u.status = 'active'
  )
  SELECT t.user_id::text AS user_id, t.handle, t.pts::text AS pts, t.wk, (RANK() OVER (ORDER BY t.pts DESC))::int AS rnk
    FROM t ORDER BY t.pts DESC, lower(t.handle) ASC, t.user_id ASC`;

interface FieldEntry { userId: string; rank: number; handle: string; pointsX100: number; weekPointsX100: number }
interface Field { season: string; week: number; version: string; entries: FieldEntry[] }

/** Cache life for the computed board. Short: scoring runs every 15 minutes during games. */
export const FIELD_CACHE_SECONDS = 30;

/** The week shown as "this week": the latest week with a locked or final window. */
async function boardWeek(ctx: ApiContext, season: string): Promise<number> {
  const [r] = await ctx.db.query<{ week: number | null }>(
    `SELECT max(week)::int AS week FROM game_windows WHERE season = $1 AND status IN ('locked', 'final')`,
    [season]
  );
  return r?.week ?? 0;
}

async function computeField(ctx: ApiContext, season: string): Promise<Field> {
  const week = await boardWeek(ctx, season);
  const rows = await ctx.db.query<{ user_id: string; handle: string; pts: string; wk: number; rnk: number }>(FIELD_SQL, [season, week]);
  const entries = rows.map((r) => ({ userId: r.user_id, rank: r.rnk, handle: r.handle, pointsX100: Number(r.pts), weekPointsX100: r.wk }));
  const version = createHash('sha256').update(JSON.stringify([week, entries])).digest('hex').slice(0, 16);
  return { season, week, version, entries };
}

/** Postgres is the authority; Redis only saves recomputing it (and a Redis failure falls back). */
async function field(ctx: ApiContext, season: string): Promise<Field> {
  const key = `${ctx.ns}field:${season}`;
  if (ctx.redis) {
    try {
      const hit = await ctx.redis.get(key);
      if (hit) return JSON.parse(hit) as Field;
    } catch (err) {
      ctx.log('warn', 'field board cache read failed', { error: String(err) });
    }
  }
  const f = await computeField(ctx, season);
  if (ctx.redis) {
    try {
      await ctx.redis.set(key, JSON.stringify(f), 'EX', FIELD_CACHE_SECONDS);
    } catch (err) {
      ctx.log('warn', 'field board cache write failed', { error: String(err) });
    }
  }
  return f;
}

/** Ids stay on the server: the client sees handles only (PRD-007 §5.6). */
const view = (viewer: string) => (e: FieldEntry) => ({
  rank: e.rank, handle: e.handle, pointsX100: e.pointsX100, weekPointsX100: e.weekPointsX100, isMe: e.userId === viewer,
});

export async function fieldBoard(ctx: ApiContext, viewer: string, season: string, offset: number, limit: number) {
  const f = await field(ctx, season);
  const me = f.entries.find((e) => e.userId === viewer);
  return {
    season, week: f.week, version: f.version, fieldSize: f.entries.length, offset,
    rows: f.entries.slice(offset, offset + limit).map(view(viewer)),
    me: me ? view(viewer)(me) : null,
  };
}

export async function fieldMe(ctx: ApiContext, viewer: string, season: string) {
  const f = await field(ctx, season);
  const me = f.entries.find((e) => e.userId === viewer);
  return { season, week: f.week, fieldSize: f.entries.length, me: me ? view(viewer)(me) : null };
}

/**
 * Post-lock reveal on the field board (PRD-007 Q3, PRD-003 §6): another
 * manager's locked picks only. Unlocked and empty slots come back HIDDEN, and
 * their rows never leave Postgres. A manager's own lineup is shown in full.
 */
export async function fieldReveal(ctx: ApiContext, viewer: string, season: string, week: number, handle: string) {
  const [target] = await ctx.db.query<{ id: string; handle: string }>(
    `SELECT id::text AS id, handle FROM users WHERE lower(handle) = lower($1) AND status = 'active'`,
    [handle]
  );
  if (!target) throw notFound('No such manager');
  const own = target.id === viewer;
  const subs = await ctx.db.query<{
    slot_key: string; player_id: string; locked: boolean; voided: boolean; burned: boolean; points_x100: number | null;
    name: string | null; team: string | null; position: string | null; window_label: string | null;
  }>(
    `SELECT s.slot_key, s.player_id, (s.locked_at IS NOT NULL) AS locked, (s.void_reason IS NOT NULL) AS voided,
            EXISTS (SELECT 1 FROM burn_records b WHERE b.submission_id = s.id) AS burned, sc.points_x100,
            p.first_name || ' ' || p.last_name AS name, p.team, p.position, w.label AS window_label
       FROM season_submissions s
       LEFT JOIN player_game_scores sc ON sc.season = s.season AND sc.player_id = s.player_id AND sc.game_window_id = s.game_window_id
       LEFT JOIN nfl_players p ON p.msf_player_id = s.player_id
       LEFT JOIN game_windows w ON w.id = s.game_window_id
      WHERE s.user_id = $1::uuid AND s.season = $2 AND s.week = $3
        AND ($4::boolean OR (s.locked_at IS NOT NULL AND s.void_reason IS NULL))`,
    [target.id, season, week, own]
  );
  const bySlot = new Map(subs.map((s) => [s.slot_key, s]));
  return {
    handle: target.handle,
    week,
    slots: SLOT_ORDER.map((slotKey) => {
      const s = bySlot.get(slotKey);
      if (!s) return { slotKey, state: own ? 'EMPTY' : 'HIDDEN' };
      const player = { playerId: s.player_id, name: s.name, team: s.team, position: s.position };
      if (s.locked && !s.voided) return { slotKey, state: 'LOCKED', player, windowLabel: s.window_label, pointsX100: s.points_x100 ?? 0, burned: s.burned };
      if (s.voided) return { slotKey, state: 'VOIDED', player };
      return { slotKey, state: 'SUBMITTED', player, windowLabel: s.window_label };
    }),
  };
}

// ── §8.3 burns, inbox, receipts ─────────────────────────────────────────────

type StatRow = Record<(typeof STAT_COLUMNS)[number][1], number | null>;
/** player_game_stats column → StatLine field. */
const STAT_COLUMNS = [
  ['passYds', 'pass_yds'], ['passTd', 'pass_td'], ['passInt', 'pass_int'], ['rushYds', 'rush_yds'], ['rushTd', 'rush_td'],
  ['receptions', 'receptions'], ['recYds', 'rec_yds'], ['recTd', 'rec_td'], ['returnTd', 'return_td'], ['fumbleRecTd', 'fumble_rec_td'],
  ['fumblesLost', 'fumbles_lost'], ['twoPt', 'two_pt'], ['fgMade0to39', 'fg_made_0_39'], ['fgMade40to49', 'fg_made_40_49'],
  ['fgMade50Plus', 'fg_made_50_plus'], ['fgMissed', 'fg_missed'], ['xpMade', 'xp_made'], ['xpMissed', 'xp_missed'],
] as const;

/**
 * Burned players with the points they scored and, for transparency (Nath,
 * 2026-10-30), the stat line behind those points: each stat with what it
 * earned under the ruleset that scored it. The lines add up to the total.
 */
export async function myBurns(ctx: ApiContext, userId: string, season: string) {
  const rows = await ctx.db.query<{
    week: number; slot_key: string | null; player_id: string; name: string | null; position: string | null; team: string | null;
    points_x100: number | null; rules_version: string | null; has_stats: boolean; burned_at: Date; window_label: string;
  } & StatRow>(
    `SELECT b.week, s.slot_key, b.player_id, p.first_name || ' ' || p.last_name AS name, p.position, p.team,
            sc.points_x100, sc.rules_version, st.id IS NOT NULL AS has_stats, b.burned_at, w.label AS window_label,
            ${STAT_COLUMNS.map(([, c]) => `st.${c}`).join(', ')}
       FROM burn_records b
       JOIN game_windows w ON w.id = b.game_window_id
       LEFT JOIN season_submissions s ON s.id = b.submission_id
       LEFT JOIN nfl_players p ON p.msf_player_id = b.player_id
       LEFT JOIN player_game_scores sc ON sc.season = b.season AND sc.player_id = b.player_id AND sc.game_window_id = b.game_window_id
       LEFT JOIN player_game_stats st ON st.id = sc.stats_id
      WHERE b.user_id = $1::uuid AND b.season = $2
      ORDER BY b.burned_at, b.week`,
    [userId, season]
  );
  return rows.map((r) => {
    const rules = (r.rules_version && RULES_BY_VERSION[r.rules_version]) || CURRENT_RULES;
    const line = Object.fromEntries(STAT_COLUMNS.map(([f, c]) => [f, Number(r[c] ?? 0)])) as unknown as StatLine;
    return {
      week: r.week, slot: r.slot_key, playerId: r.player_id, name: r.name, position: r.position, team: r.team,
      pointsX100: r.points_x100 ?? 0, burnedAt: r.burned_at, windowLabel: r.window_label,
      rulesVersion: r.rules_version ?? null,
      breakdown: r.has_stats ? scoreBreakdown(line, rules) : null,
    };
  });
}

/** The scoring rules as the engine applies them, for the rules page (never a hand-copied table). */
export function scoringRules() {
  const rules = CURRENT_RULES;
  return {
    version: rules.version,
    stats: STAT_FIELDS.map((f) => ({ stat: f, label: STAT_LABELS[f], group: STAT_GROUPS[f], centipoints: rules.centipointsPer[f] })),
    correctionsWindowHours: 48,
  };
}

/** Player ids a notice names: `playerId`, or each of `players[].playerId` (LOCK, BURN). */
export function noticePlayerIds(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const p = payload as Record<string, unknown>;
  const ids = new Set<string>();
  if (typeof p.playerId === 'string') ids.add(p.playerId);
  if (Array.isArray(p.players)) {
    for (const x of p.players) {
      if (typeof x === 'object' && x !== null && typeof (x as Record<string, unknown>).playerId === 'string') ids.add((x as Record<string, string>).playerId);
    }
  }
  return [...ids];
}

/**
 * Inbox page cursor: the last item's time and id. Two notices can share a
 * timestamp (one transaction), so the time alone could skip one at a page edge.
 * A bare timestamp is still accepted.
 */
export function parseNoticeCursor(raw: string | undefined): { at: Date; id: string | null } | null {
  if (!raw) return null;
  const [t, id] = raw.split('|');
  const at = new Date(t);
  if (Number.isNaN(at.getTime())) throw new HttpError(400, 'VALIDATION', 'before is not a valid cursor');
  if (id !== undefined && !/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, 'VALIDATION', 'before is not a valid cursor');
  return { at, id: id ?? null };
}

export async function myNotifications(ctx: ApiContext, userId: string, before: { at: Date; id: string | null } | null, limit: number) {
  const rows = await ctx.db.query<{ id: string; kind: string; payload: object; created_at: Date; read_at: Date | null }>(
    `SELECT id::text AS id, kind, payload, created_at, read_at FROM notification_queue
      WHERE user_id = $1::uuid
        AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz OR (created_at = $2::timestamptz AND $3::uuid IS NOT NULL AND id < $3::uuid))
      ORDER BY created_at DESC, id DESC LIMIT $4`,
    [userId, before?.at ?? null, before?.id ?? null, limit]
  );
  const [{ unread }] = await ctx.db.query<{ unread: number }>(
    `SELECT count(*)::int AS unread FROM notification_queue WHERE user_id = $1::uuid AND read_at IS NULL`,
    [userId]
  );
  // Names for the players the notices mention (text only: name, position, team; PRD-007 §5.1).
  const ids = [...new Set(rows.flatMap((r) => noticePlayerIds(r.payload)))];
  const players: Record<string, { name: string; position: string; team: string | null }> = {};
  if (ids.length) {
    const ps = await ctx.db.query<{ id: string; name: string; position: string; team: string | null }>(
      `SELECT msf_player_id AS id, first_name || ' ' || last_name AS name, position, team FROM nfl_players WHERE msf_player_id = ANY ($1::text[])`,
      [ids]
    );
    for (const p of ps) players[p.id] = { name: p.name, position: p.position, team: p.team };
  }
  const last = rows.at(-1);
  return {
    unread,
    items: rows.map((r) => ({ id: r.id, kind: r.kind, payload: r.payload, createdAt: r.created_at, read: r.read_at !== null })),
    players,
    nextBefore: rows.length === limit && last ? `${last.created_at.toISOString()}|${last.id}` : null,
  };
}

export async function markNotificationsRead(ctx: ApiContext, userId: string, sel: { ids: string[] } | { all: true }): Promise<number> {
  const now = ctx.now();
  const rows =
    'all' in sel
      ? await ctx.db.query(`UPDATE notification_queue SET read_at = $2 WHERE user_id = $1::uuid AND read_at IS NULL RETURNING 1`, [userId, now])
      : await ctx.db.query(
          `UPDATE notification_queue SET read_at = $2 WHERE user_id = $1::uuid AND id = ANY ($3::uuid[]) AND read_at IS NULL RETURNING 1`,
          [userId, now, sel.ids]
        );
  return rows.length;
}

export async function myReceipts(ctx: ApiContext, userId: string, season: string) {
  const rows = await ctx.db.query<{ id: string; week: number; gate3_at: Date; sha256: string | null }>(
    `SELECT id::text AS id, week, gate3_at, lineup_sha256 AS sha256 FROM submission_receipts
      WHERE user_id = $1::uuid AND season = $2 ORDER BY gate3_at DESC`,
    [userId, season]
  );
  return rows.map((r) => ({ id: r.id, week: r.week, confirmedAt: r.gate3_at, sha256: r.sha256 }));
}
