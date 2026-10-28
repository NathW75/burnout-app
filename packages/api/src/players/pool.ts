/**
 * Player pool for the lineup builder — PRD-006 §8, PRD-001 §10
 * NIL: cards carry text only.
 */
import type { ApiContext } from '../context';
import type { SqlRunner } from '../sql';
import { INACTIVE_STATUSES, SELECTABLE_POSITIONS } from './msf-players';

export interface PlayerCard {
  playerId: string;
  name: string;
  team: string;
  position: string;
  opponent: string | null;
  homeAway: 'home' | 'away' | null;
  scheduledEt: string | null;
  bye: boolean;
  windowOpen: boolean;
  injuryStatus: string;
  projectedPoints: number | null;
  weekOwnershipPct: number;
  seasonOwnershipPct: number;
  burnState: 'available' | 'locked' | 'burned';
  /** False → shown greyed out. Out/IR players are greyed but never burned. */
  selectable: boolean;
  unavailableReason: 'BURNED' | 'LOCKED' | 'INACTIVE' | 'BYE' | 'WINDOW_CLOSED' | null;
}

/**
 * Burned for this user (PRD-001 §5.4): the person counts, not the ID. True if
 * the player, or any other MSF ID for the same person, was burned.
 * $1 = user id, $2 = season; `p` is the nfl_players row in the outer query.
 */
export const BURNED_BY_PERSON_SQL = `
  EXISTS (SELECT 1 FROM pool_entries pe JOIN nfl_players x ON x.msf_player_id = pe.player_id
           WHERE pe.user_id = $1::uuid AND pe.season = $2 AND pe.burned
             AND COALESCE(x.canonical_id, x.msf_player_id) = COALESCE(p.canonical_id, p.msf_player_id))`;

/**
 * Players the user may still select this season: selectable positions, on a
 * team, one ID per person (aliases never), and not burned by them under any
 * of that person's IDs (PRD-006 §7.5).
 */
export async function availablePlayerIds(q: SqlRunner, userId: string, season: string): Promise<Set<string>> {
  const rows = await q.query<{ id: string }>(
    `SELECT p.msf_player_id AS id FROM nfl_players p
      WHERE p.position = ANY ($3::text[]) AND p.team IS NOT NULL AND p.canonical_id IS NULL
        AND NOT ${BURNED_BY_PERSON_SQL}`,
    [userId, season, [...SELECTABLE_POSITIONS]]
  );
  return new Set(rows.map((r) => r.id));
}

interface Ownership {
  week: Record<string, number>;
  season: Record<string, number>;
}

/** Week: share of this week's submitters who submitted the player. Season: share of burners who burned him. Cached 5 min. */
async function ownership(ctx: ApiContext, season: string, week: number): Promise<Ownership> {
  const key = `${ctx.ns}own:${season}:${week}`;
  if (ctx.redis) {
    try {
      const hit = await ctx.redis.get(key);
      if (hit) return JSON.parse(hit) as Ownership;
    } catch {
      /* compute from Postgres */
    }
  }
  const weekRows = await ctx.db.query<{ player_id: string; pct: number }>(
    `WITH subs AS (SELECT DISTINCT user_id, player_id FROM season_submissions WHERE season = $1 AND week = $2 AND void_reason IS NULL),
          n AS (SELECT count(DISTINCT user_id)::float AS n FROM subs)
     SELECT player_id, round((count(*) * 100.0 / NULLIF((SELECT n FROM n), 0))::numeric, 1)::float AS pct FROM subs GROUP BY player_id`,
    [season, week]
  );
  const seasonRows = await ctx.db.query<{ player_id: string; pct: number }>(
    `WITH b AS (SELECT DISTINCT user_id, player_id FROM burn_records WHERE season = $1),
          n AS (SELECT count(DISTINCT user_id)::float AS n FROM b)
     SELECT player_id, round((count(*) * 100.0 / NULLIF((SELECT n FROM n), 0))::numeric, 1)::float AS pct FROM b GROUP BY player_id`,
    [season]
  );
  const result: Ownership = {
    week: Object.fromEntries(weekRows.map((r) => [r.player_id, Number(r.pct)])),
    season: Object.fromEntries(seasonRows.map((r) => [r.player_id, Number(r.pct)])),
  };
  if (ctx.redis) {
    try {
      await ctx.redis.set(key, JSON.stringify(result), 'EX', 300);
    } catch {
      /* optional */
    }
  }
  return result;
}

export async function getPool(ctx: ApiContext, userId: string, season: string, week: number): Promise<PlayerCard[]> {
  const now = ctx.now();
  const rows = await ctx.db.query<{
    id: string; name: string; team: string; position: string; injury_status: string;
    opponent: string | null; home_away: 'home' | 'away' | null; scheduled_et: Date | null; status: string | null;
    burned: boolean; locked: boolean;
  }>(
    `SELECT p.msf_player_id AS id, p.first_name || ' ' || p.last_name AS name, p.team, p.position, p.injury_status,
            g.opponent, g.home_away, g.scheduled_et, g.status,
            ${BURNED_BY_PERSON_SQL} AS burned,
            EXISTS (SELECT 1 FROM season_submissions s JOIN nfl_players x ON x.msf_player_id = s.player_id
                     WHERE s.user_id = $1::uuid AND s.season = $2 AND s.week = $3
                       AND COALESCE(x.canonical_id, x.msf_player_id) = p.msf_player_id
                       AND s.locked_at IS NOT NULL AND s.void_reason IS NULL) AS locked
       FROM nfl_players p
       LEFT JOIN LATERAL (
         SELECT CASE WHEN p.team = gm.home_team THEN gm.away_team ELSE gm.home_team END AS opponent,
                CASE WHEN p.team = gm.home_team THEN 'home' ELSE 'away' END AS home_away,
                gw.scheduled_et, gw.status
           FROM nfl_games gm LEFT JOIN game_windows gw ON gw.id = gm.game_window_id
          WHERE gm.season = $2 AND gm.week = $3 AND p.team IN (gm.home_team, gm.away_team)
          ORDER BY gm.scheduled_start LIMIT 1) g ON true
      WHERE p.position = ANY ($4::text[]) AND p.team IS NOT NULL AND p.canonical_id IS NULL -- one card per person (§7.5)
      ORDER BY p.position, p.last_name, p.first_name, p.msf_player_id`,
    [userId, season, week, [...SELECTABLE_POSITIONS]]
  );
  const own = await ownership(ctx, season, week);
  const reason = (r: (typeof rows)[number], windowOpen: boolean): PlayerCard['unavailableReason'] =>
    r.burned ? 'BURNED' : r.locked ? 'LOCKED' : INACTIVE_STATUSES.has(r.injury_status) ? 'INACTIVE' : r.opponent === null ? 'BYE' : !windowOpen ? 'WINDOW_CLOSED' : null;
  return rows.map((r) => {
    const windowOpen = r.status === 'pending' && !!r.scheduled_et && new Date(r.scheduled_et) > now;
    const unavailableReason = reason(r, windowOpen);
    return {
    playerId: r.id,
    name: r.name,
    team: r.team,
    position: r.position,
    opponent: r.opponent,
    homeAway: r.home_away,
    scheduledEt: r.scheduled_et ? new Date(r.scheduled_et).toISOString() : null,
    bye: r.opponent === null,
    windowOpen,
    injuryStatus: r.injury_status,
    projectedPoints: null, // PRD-006 Q3
    weekOwnershipPct: own.week[r.id] ?? 0,
    seasonOwnershipPct: own.season[r.id] ?? 0,
    burnState: r.burned ? 'burned' : r.locked ? 'locked' : 'available',
    selectable: unavailableReason === null,
    unavailableReason,
    };
  });
}
