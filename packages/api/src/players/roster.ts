/**
 * Roster sync and submission re-resolve — PRD-006 §7.3, PRD-001 §6.5
 */
import { audit } from '../auth/audit';
import type { ApiContext } from '../context';
import type { SqlRunner } from '../sql';
import type { ParsedPlayer } from './msf-players';

/** A player's game window in a week, through his current team (§7.2). Null on bye / unsigned. */
export const PLAYER_WINDOW_SQL = `
  SELECT g.game_window_id::text AS game_window_id
    FROM nfl_players p
    JOIN nfl_games g ON g.season = $2 AND g.week = $3 AND p.team IS NOT NULL AND p.team IN (g.home_team, g.away_team)
   WHERE p.msf_player_id = $1 AND g.game_window_id IS NOT NULL
   ORDER BY g.scheduled_start LIMIT 1`;

export async function playerWindow(q: SqlRunner, playerId: string, season: string, week: number): Promise<string | null> {
  const [r] = await q.query<{ game_window_id: string }>(PLAYER_WINDOW_SQL, [playerId, season, week]);
  return r?.game_window_id ?? null;
}

/**
 * Upserts the player table. With `complete` (a full roster feed), players
 * missing from the feed lose their team, so they can no longer be selected.
 */
export async function syncPlayers(ctx: ApiContext, players: ParsedPlayer[], opts: { complete: boolean }): Promise<{ upserted: number; unrostered: number }> {
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const res = await tx.query(
      `INSERT INTO nfl_players (msf_player_id, first_name, last_name, position, team, roster_status, injury_status, updated_at)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::timestamptz[])
       ON CONFLICT (msf_player_id) DO UPDATE SET
         first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, position = EXCLUDED.position, team = EXCLUDED.team,
         roster_status = EXCLUDED.roster_status, injury_status = EXCLUDED.injury_status, updated_at = EXCLUDED.updated_at
       WHERE (nfl_players.first_name, nfl_players.last_name, nfl_players.position, nfl_players.team, nfl_players.roster_status, nfl_players.injury_status)
             IS DISTINCT FROM (EXCLUDED.first_name, EXCLUDED.last_name, EXCLUDED.position, EXCLUDED.team, EXCLUDED.roster_status, EXCLUDED.injury_status)
       RETURNING 1`,
      [
        players.map((p) => p.msfPlayerId), players.map((p) => p.firstName), players.map((p) => p.lastName), players.map((p) => p.position),
        players.map((p) => p.team), players.map((p) => p.rosterStatus), players.map((p) => p.injuryStatus), players.map(() => now),
      ]
    );
    let unrostered = 0;
    if (opts.complete && players.length > 0) {
      const gone = await tx.query(
        `UPDATE nfl_players SET team = NULL, updated_at = $2 WHERE team IS NOT NULL AND NOT (msf_player_id = ANY ($1::text[])) RETURNING 1`,
        [players.map((p) => p.msfPlayerId), now]
      );
      unrostered = gone.length;
    }
    return { upserted: res.length, unrostered };
  });
}

export interface ReresolveResult {
  checked: number;
  repointed: number;
  voided: number;
  skipped: string | null;
}

/**
 * For every unlocked, unvoided submission this week, re-derive the player's
 * window from his current team: same → nothing; different and still open →
 * re-point; no game / unsigned / new window closed → void PLAYER_NO_GAME.
 * Locked submissions are never touched (the DB guard also forbids it).
 */
export async function reresolveSubmissions(ctx: ApiContext, season: string, week: number): Promise<ReresolveResult> {
  const now = ctx.now();
  // No schedule for the week yet (or windows not mapped): do nothing rather than void everything.
  const [known] = await ctx.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM nfl_games WHERE season = $1 AND week = $2 AND game_window_id IS NOT NULL AND home_team IS NOT NULL`,
    [season, week]
  );
  if (known.n === 0) return { checked: 0, repointed: 0, voided: 0, skipped: 'NO_SCHEDULE' };

  const subs = await ctx.db.query<{ id: string }>(
    `SELECT s.id::text AS id FROM season_submissions s
      WHERE s.season = $1 AND s.week = $2 AND s.locked_at IS NULL AND s.void_reason IS NULL
        AND EXISTS (SELECT 1 FROM nfl_players p WHERE p.msf_player_id = s.player_id)`,
    [season, week]
  );
  const result: ReresolveResult = { checked: subs.length, repointed: 0, voided: 0, skipped: null };
  for (const { id } of subs) {
    const outcome = await ctx.db.transaction(async (tx) => {
      const [s] = await tx.query<{ user_id: string; player_id: string; slot_key: string; game_window_id: string }>(
        `SELECT user_id::text AS user_id, player_id, slot_key, game_window_id::text AS game_window_id
           FROM season_submissions WHERE id = $1::uuid AND locked_at IS NULL AND void_reason IS NULL FOR UPDATE`,
        [id]
      );
      if (!s) return null;
      const target = await playerWindow(tx, s.player_id, season, week);
      if (target === s.game_window_id) return null;
      const [w] = target
        ? await tx.query<{ status: string; scheduled_et: Date; label: string }>(
            `SELECT status, scheduled_et, label FROM game_windows WHERE id = $1::uuid FOR SHARE`,
            [target]
          )
        : [];
      const [player] = await tx.query<{ name: string; team: string | null }>(
        `SELECT first_name || ' ' || last_name AS name, team FROM nfl_players WHERE msf_player_id = $1`,
        [s.player_id]
      );
      if (target && w && w.status === 'pending' && new Date(w.scheduled_et) > now) {
        await tx.query(`UPDATE season_submissions SET game_window_id = $2::uuid WHERE id = $1::uuid`, [id, target]);
        await audit(tx, { event: 'SUBMISSION_REPOINTED', userId: s.user_id, at: now, slotKey: s.slot_key, gameId: target,
          metadata: { submissionId: id, playerId: s.player_id, fromWindow: s.game_window_id, toWindow: target, team: player?.team } });
        await tx.query(`INSERT INTO notification_queue (user_id, kind, game_window_id, payload) VALUES ($1, 'SUBMISSION_REPOINTED', $2, $3::jsonb)`, [
          s.user_id, target,
          JSON.stringify({ season, week, slot: s.slot_key, playerId: s.player_id, playerName: player?.name, team: player?.team, newWindowLabel: w.label, newLockAt: w.scheduled_et }),
        ]);
        return 'repointed' as const;
      }
      await tx.query(`UPDATE season_submissions SET void_reason = 'PLAYER_NO_GAME' WHERE id = $1::uuid`, [id]);
      await audit(tx, { event: 'SUBMISSION_VOIDED', userId: s.user_id, at: now, slotKey: s.slot_key,
        metadata: { submissionId: id, playerId: s.player_id, reason: 'PLAYER_NO_GAME', team: player?.team ?? null } });
      await tx.query(`INSERT INTO notification_queue (user_id, kind, payload) VALUES ($1, 'SUBMISSION_VOIDED', $2::jsonb)`, [
        s.user_id, JSON.stringify({ season, week, slot: s.slot_key, playerId: s.player_id, playerName: player?.name, team: player?.team ?? null, reason: 'PLAYER_NO_GAME' }),
      ]);
      return 'voided' as const;
    });
    if (outcome === 'repointed') result.repointed++;
    if (outcome === 'voided') result.voided++;
  }
  ctx.log('info', 'submissions re-resolved', { season, week, ...result });
  return result;
}
