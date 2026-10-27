/**
 * Scoring store — PRD-002 §5–§8, §10
 *
 * ingestWeek:   MSF games + gamelogs → nfl_games, stat lines, player scores,
 *               corrections, user week scores, correction notices.
 * freezeDueWeeks: closes the correction window 48h after a week's last Final.
 * verifyFrozenWeek: integrity check; recomputes frozen scores from stat lines.
 *
 * Every write for a (season, week) happens in ONE transaction that first takes
 * a Postgres advisory lock on that week. Ingest and freeze for the same week
 * therefore never interleave: a correction is either applied before the freeze
 * or recorded as AFTER_FREEZE, never half-applied.
 *
 * Only season_submissions feed user scores. weekly_submissions is never read
 * (PRD-002 §5.3 burn isolation).
 */

import { createHash } from 'node:crypto';
import type { SqlDatabase, SqlRunner } from './sql';
import { CURRENT_RULES, scoreStatLine, STAT_FIELDS, type ScoringRules, type StatLine } from './rules';
import type { GameStatus, ParsedGamelogs } from './msf';

export class RulesVersionMismatchError extends Error {
  readonly code = 'RULES_VERSION_MISMATCH';
  constructor(season: string, pinned: string, attempted: string) {
    super(`Season ${season} is scored under ${pinned}; refusing to score with ${attempted} (PRD-002 §3.4)`);
    this.name = 'RulesVersionMismatchError';
  }
}

/** StatLine field → player_game_stats column. */
const COLUMN: Readonly<Record<keyof StatLine, string>> = {
  passYds: 'pass_yds', passTd: 'pass_td', passInt: 'pass_int', rushYds: 'rush_yds', rushTd: 'rush_td',
  receptions: 'receptions', recYds: 'rec_yds', recTd: 'rec_td', returnTd: 'return_td',
  fumbleRecTd: 'fumble_rec_td', fumblesLost: 'fumbles_lost', twoPt: 'two_pt',
  fgMade0to39: 'fg_made_0_39', fgMade40to49: 'fg_made_40_49', fgMade50Plus: 'fg_made_50_plus',
  fgMissed: 'fg_missed', xpMade: 'xp_made', xpMissed: 'xp_missed',
};
const STAT_COLUMNS = STAT_FIELDS.map((f) => COLUMN[f]);

export function statHash(stats: StatLine): string {
  return createHash('sha256').update(JSON.stringify(STAT_FIELDS.map((f) => stats[f]))).digest('hex');
}

const statsJson = (s: StatLine) => JSON.stringify(Object.fromEntries(STAT_FIELDS.map((f) => [f, s[f]])));

function rowToStats(row: Record<string, unknown>): StatLine {
  return Object.fromEntries(STAT_FIELDS.map((f) => [f, Number(row[COLUMN[f]])])) as unknown as StatLine;
}

async function lockWeek(tx: SqlRunner, season: string, week: number): Promise<void> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`scoring:${season}:${week}`]);
}

async function isFrozen(tx: SqlRunner, season: string, week: number): Promise<boolean> {
  const rows = await tx.query(`SELECT 1 FROM week_freezes WHERE season = $1 AND week = $2`, [season, week]);
  return rows.length > 0;
}

export interface IngestInput {
  season: string;
  games: GameStatus[];
  gamelogs: ParsedGamelogs;
  serverNow: Date;
  rules?: ScoringRules;
}

export interface WeekIngestResult {
  week: number;
  frozen: boolean;
  gamesChanged: number;
  linesInserted: number;
  linesUpdated: number;
  scoresFinalized: number;
  correctionsApplied: number;
  correctionsIgnored: number;
  userWeekScoresChanged: number;
  correctionNoticesQueued: number;
  unmappedGames: string[];
}

interface ExistingRow {
  stats_id: string;
  score_id: string;
  msf_game_id: string;
  player_id: string;
  stat_hash: string;
  points_x100: number;
  status: 'provisional' | 'final' | 'frozen';
  [col: string]: unknown;
}

interface AppliedCorrection {
  playerId: string;
  gameWindowId: string;
  beforeX100: number;
  afterX100: number;
}

/** Runs inside the freeze transaction after scores are frozen (e.g. leaderboard official snapshots, PRD-003 §8). */
export type AfterFreezeHook = (tx: SqlRunner, ctx: { season: string; week: number; serverNow: Date }) => Promise<void>;

export interface ScoringStoreOptions {
  afterFreeze?: AfterFreezeHook;
}

export function createScoringStore(db: SqlDatabase, options: ScoringStoreOptions = {}) {
  async function ingestOneWeek(
    input: IngestInput,
    week: number,
    games: GameStatus[],
    lines: ParsedGamelogs['lines']
  ): Promise<WeekIngestResult> {
    const rules = input.rules ?? CURRENT_RULES;
    const { season, serverNow } = input;

    return db.transaction(async (tx) => {
      await lockWeek(tx, season, week);
      const result: WeekIngestResult = {
        week, frozen: false, gamesChanged: 0, linesInserted: 0, linesUpdated: 0, scoresFinalized: 0,
        correctionsApplied: 0, correctionsIgnored: 0, userWeekScoresChanged: 0, correctionNoticesQueued: 0,
        unmappedGames: [],
      };

      // §3.4: pin the season's ruleset on first use; refuse any other version afterwards.
      await tx.query(
        `INSERT INTO season_rules (season, rules_version, pinned_at) VALUES ($1, $2, $3::timestamptz)
         ON CONFLICT (season) DO NOTHING`,
        [season, rules.version, serverNow]
      );
      const [pinned] = await tx.query<{ rules_version: string }>(`SELECT rules_version FROM season_rules WHERE season = $1`, [season]);
      if (pinned.rules_version !== rules.version) throw new RulesVersionMismatchError(season, pinned.rules_version, rules.version);

      // Games: status, window mapping, and the server time Final was first observed (§7 freeze clock).
      for (const g of games) {
        const changed = await tx.query(
          `INSERT INTO nfl_games (msf_game_id, season, week, game_window_id, scheduled_start, played_status,
                                  schedule_status, is_final, final_observed_at, updated_at)
           VALUES ($1::text, $2::text, $3,
                   (SELECT id FROM game_windows WHERE season = $2::text AND $1::text = ANY (msf_game_ids) LIMIT 1),
                   $4::timestamptz, $5, $6, $7::boolean,
                   CASE WHEN $7::boolean THEN $8::timestamptz END, $8::timestamptz)
           ON CONFLICT (msf_game_id) DO UPDATE SET
             game_window_id = EXCLUDED.game_window_id, scheduled_start = EXCLUDED.scheduled_start,
             played_status = EXCLUDED.played_status, schedule_status = EXCLUDED.schedule_status,
             is_final = EXCLUDED.is_final,
             final_observed_at = COALESCE(nfl_games.final_observed_at, EXCLUDED.final_observed_at),
             updated_at = EXCLUDED.updated_at
           WHERE (nfl_games.game_window_id, nfl_games.scheduled_start, nfl_games.played_status,
                  nfl_games.schedule_status, nfl_games.is_final)
                 IS DISTINCT FROM
                 (EXCLUDED.game_window_id, EXCLUDED.scheduled_start, EXCLUDED.played_status,
                  EXCLUDED.schedule_status, EXCLUDED.is_final)
           RETURNING 1`,
          [g.msfGameId, season, week, g.scheduledStart, g.playedStatus, g.scheduleStatus, g.isFinal, serverNow]
        );
        result.gamesChanged += changed.length;
      }

      const gameRows = await tx.query<{ msf_game_id: string; game_window_id: string | null; is_final: boolean }>(
        `SELECT msf_game_id, game_window_id::text AS game_window_id, is_final FROM nfl_games WHERE season = $1 AND week = $2`,
        [season, week]
      );
      const gameMap = new Map(gameRows.map((r) => [r.msf_game_id, r]));
      result.frozen = await isFrozen(tx, season, week);

      const existingRows = await tx.query<ExistingRow>(
        `SELECT st.id::text AS stats_id, sc.id::text AS score_id, st.msf_game_id, st.player_id, st.stat_hash,
                sc.points_x100, sc.status, ${STAT_COLUMNS.map((c) => `st.${c}`).join(', ')}
           FROM player_game_stats st JOIN player_game_scores sc ON sc.stats_id = st.id
          WHERE st.season = $1 AND st.week = $2`,
        [season, week]
      );
      const existing = new Map(existingRows.map((r) => [`${r.msf_game_id}|${r.player_id}`, r]));

      const unmapped = new Set<string>();
      const applied: AppliedCorrection[] = [];

      for (const line of lines) {
        const game = gameMap.get(line.msfGameId);
        if (!game || !game.game_window_id) {
          unmapped.add(line.msfGameId);
          continue;
        }
        const hash = statHash(line.stats);
        const points = scoreStatLine(line.stats, rules);
        const targetStatus = game.is_final ? 'final' : 'provisional';
        const ex = existing.get(`${line.msfGameId}|${line.playerId}`);

        if (!ex) {
          if (result.frozen) continue; // nothing new enters a frozen week
          const statVals = STAT_FIELDS.map((f) => line.stats[f]);
          const [ins] = await tx.query<{ id: string }>(
            `INSERT INTO player_game_stats (season, week, msf_game_id, player_id, game_window_id,
                                            ${STAT_COLUMNS.join(', ')}, stat_hash, source_updated_at, ingested_at)
             VALUES ($1, $2, $3, $4, $5::uuid, ${STAT_COLUMNS.map((_, i) => `$${i + 6}`).join(', ')},
                     $${STAT_COLUMNS.length + 6}, $${STAT_COLUMNS.length + 7}::timestamptz, $${STAT_COLUMNS.length + 8}::timestamptz)
             RETURNING id::text AS id`,
            [season, week, line.msfGameId, line.playerId, game.game_window_id, ...statVals, hash, input.gamelogs.lastUpdatedOn, serverNow]
          );
          await tx.query(
            `INSERT INTO player_game_scores (stats_id, season, week, msf_game_id, player_id, game_window_id,
                                             points_x100, status, rules_version, computed_at)
             VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $7::int, $8, $9, $10::timestamptz)`,
            [ins.id, season, week, line.msfGameId, line.playerId, game.game_window_id, points, targetStatus, rules.version, serverNow]
          );
          result.linesInserted++;
          continue;
        }

        if (ex.stat_hash === hash) {
          if (ex.status === 'provisional' && targetStatus === 'final') {
            await tx.query(`UPDATE player_game_scores SET status = 'final', computed_at = $2::timestamptz WHERE id = $1::uuid`, [ex.score_id, serverNow]);
            result.scoresFinalized++;
          }
          continue;
        }

        // Stats changed.
        const before = rowToStats(ex);
        if (ex.status === 'frozen' || result.frozen) {
          // §7: after freeze, record but never apply. Recorded once per distinct new stat line.
          const recorded = await tx.query(
            `INSERT INTO score_corrections (score_id, detected_at, points_before_x100, points_after_x100,
                                            stats_before, stats_after, applied, reason)
             SELECT $1::uuid, $2::timestamptz, $3::int, $4::int, $5::jsonb, $6::jsonb, false, 'AFTER_FREEZE'
              WHERE NOT EXISTS (SELECT 1 FROM score_corrections
                                 WHERE score_id = $1::uuid AND reason = 'AFTER_FREEZE' AND stats_after = $6::jsonb)
             RETURNING 1`,
            [ex.score_id, serverNow, ex.points_x100, points, statsJson(before), statsJson(line.stats)]
          );
          result.correctionsIgnored += recorded.length;
          continue;
        }

        await tx.query(
          `UPDATE player_game_stats SET ${STAT_COLUMNS.map((c, i) => `${c} = $${i + 2}`).join(', ')},
                  stat_hash = $${STAT_COLUMNS.length + 2}, source_updated_at = $${STAT_COLUMNS.length + 3}::timestamptz,
                  ingested_at = $${STAT_COLUMNS.length + 4}::timestamptz
            WHERE id = $1::uuid`,
          [ex.stats_id, ...STAT_FIELDS.map((f) => line.stats[f]), hash, input.gamelogs.lastUpdatedOn, serverNow]
        );
        // A final score stays final; a provisional one may become final in the same ingest.
        const newStatus = ex.status === 'final' ? 'final' : targetStatus;
        await tx.query(
          `UPDATE player_game_scores SET points_x100 = $2::int, status = $3, computed_at = $4::timestamptz WHERE id = $1::uuid`,
          [ex.score_id, points, newStatus, serverNow]
        );
        result.linesUpdated++;

        if (ex.status === 'final') {
          // §6: every change to a final score is a stat correction, audited.
          await tx.query(
            `INSERT INTO score_corrections (score_id, detected_at, points_before_x100, points_after_x100,
                                            stats_before, stats_after, applied, reason)
             VALUES ($1::uuid, $2::timestamptz, $3::int, $4::int, $5::jsonb, $6::jsonb, true, 'STAT_CORRECTION')`,
            [ex.score_id, serverNow, ex.points_x100, points, statsJson(before), statsJson(line.stats)]
          );
          result.correctionsApplied++;
          applied.push({ playerId: line.playerId, gameWindowId: game.game_window_id, beforeX100: ex.points_x100, afterX100: points });
        }
      }
      result.unmappedGames = [...unmapped].sort();

      if (result.frozen) return result; // frozen week: rollups are permanent

      // Snapshot week scores of users touched by applied corrections, for the notices.
      const touched = applied.length
        ? await tx.query<{ user_id: string; player_id: string; game_window_id: string; points_x100: number | null }>(
            `SELECT s.user_id::text AS user_id, s.player_id, s.game_window_id::text AS game_window_id, u.points_x100
               FROM season_submissions s
               JOIN unnest($3::text[], $4::uuid[]) AS c(player_id, game_window_id)
                 ON c.player_id = s.player_id AND c.game_window_id = s.game_window_id
               LEFT JOIN user_week_scores u ON u.user_id = s.user_id AND u.season = s.season AND u.week = s.week
              WHERE s.season = $1 AND s.week = $2 AND s.locked_at IS NOT NULL AND s.void_reason IS NULL`,
            [season, week, applied.map((a) => a.playerId), applied.map((a) => a.gameWindowId)]
          )
        : [];

      // §5.4: recompute week scores from locked, non-voided season-long slots only.
      const rescored = await tx.query<{ user_id: string; points_x100: number }>(
        `WITH slots AS (
           SELECT s.user_id, s.season, s.week, s.game_window_id, sc.points_x100,
                  (EXISTS (SELECT 1 FROM nfl_games g WHERE g.game_window_id = s.game_window_id)
                   AND NOT EXISTS (SELECT 1 FROM nfl_games g WHERE g.game_window_id = s.game_window_id AND NOT g.is_final)) AS window_final
             FROM season_submissions s
             LEFT JOIN player_game_scores sc
               ON sc.season = s.season AND sc.player_id = s.player_id AND sc.game_window_id = s.game_window_id
            WHERE s.season = $1 AND s.week = $2 AND s.locked_at IS NOT NULL AND s.void_reason IS NULL
         ), totals AS (
           SELECT user_id, season, week, COALESCE(SUM(points_x100), 0)::int AS points_x100,
                  COUNT(*)::smallint AS slots_scored,
                  CASE WHEN bool_and(window_final) THEN 'final' ELSE 'provisional' END AS status
             FROM slots GROUP BY user_id, season, week
         )
         INSERT INTO user_week_scores (user_id, season, week, points_x100, slots_scored, status, updated_at)
         SELECT user_id, season, week, points_x100, slots_scored, status, $3::timestamptz FROM totals
         ON CONFLICT (user_id, season, week) DO UPDATE SET
           points_x100 = EXCLUDED.points_x100, slots_scored = EXCLUDED.slots_scored,
           status = EXCLUDED.status, updated_at = EXCLUDED.updated_at
         WHERE (user_week_scores.points_x100, user_week_scores.slots_scored, user_week_scores.status)
               IS DISTINCT FROM (EXCLUDED.points_x100, EXCLUDED.slots_scored, EXCLUDED.status)
         RETURNING user_id::text AS user_id, points_x100`,
        [season, week, serverNow]
      );
      // Users whose every slot was voided (e.g. cancellation) drop to zero.
      const zeroed = await tx.query(
        `UPDATE user_week_scores u SET points_x100 = 0, slots_scored = 0, status = 'provisional', updated_at = $3::timestamptz
          WHERE u.season = $1 AND u.week = $2 AND (u.points_x100 <> 0 OR u.slots_scored <> 0)
            AND NOT EXISTS (SELECT 1 FROM season_submissions s
                             WHERE s.user_id = u.user_id AND s.season = u.season AND s.week = u.week
                               AND s.locked_at IS NOT NULL AND s.void_reason IS NULL)
          RETURNING 1`,
        [season, week, serverNow]
      );
      result.userWeekScoresChanged = rescored.length + zeroed.length;

      // §7.1: one correction notice per affected user whose week score changed (in-app + recap email; never push).
      if (touched.length) {
        const after = new Map(rescored.map((r) => [r.user_id, r.points_x100]));
        const byUser = new Map<string, { before: number; changes: AppliedCorrection[] }>();
        for (const t of touched) {
          const entry = byUser.get(t.user_id) ?? { before: t.points_x100 ?? 0, changes: [] };
          entry.changes.push(...applied.filter((a) => a.playerId === t.player_id && a.gameWindowId === t.game_window_id));
          byUser.set(t.user_id, entry);
        }
        for (const [userId, { before, changes }] of byUser) {
          const weekAfter = after.get(userId);
          if (weekAfter === undefined || weekAfter === before) continue;
          await tx.query(
            `INSERT INTO notification_queue (user_id, kind, game_window_id, payload)
             VALUES ($1::uuid, 'SCORE_CORRECTION', NULL, $2::jsonb)`,
            [userId, JSON.stringify({
              season, week, weekBeforeX100: before, weekAfterX100: weekAfter,
              changes: changes.map((c) => ({ playerId: c.playerId, beforeX100: c.beforeX100, afterX100: c.afterX100 })),
              channels: ['in_app', 'recap_email'],
            })]
          );
          result.correctionNoticesQueued++;
        }
      }

      return result;
    });
  }

  return {
    /**
     * Ingest one MSF weekly pull (games + gamelogs). Idempotent: an unchanged
     * feed writes nothing. Returns per-week results; callers emit
     * SCORES_UPDATED {season, week} for any week with changes (PRD-002 §10).
     */
    async ingest(input: IngestInput): Promise<WeekIngestResult[]> {
      const weeks = new Set<number>([...input.games.map((g) => g.week), ...input.gamelogs.lines.map((l) => l.week)]);
      const results: WeekIngestResult[] = [];
      for (const week of [...weeks].sort((a, b) => a - b)) {
        results.push(
          await ingestOneWeek(
            input,
            week,
            input.games.filter((g) => g.week === week),
            input.gamelogs.lines.filter((l) => l.week === week)
          )
        );
      }
      return results;
    },

    /**
     * §7: freeze every week whose games are all Final (canceled/postponed windows
     * excluded) and whose last Final was observed at least 48h ago by the server clock.
     */
    async freezeDueWeeks(season: string, serverNow: Date): Promise<Array<{ week: number; scoresFrozen: number; lastFinalAt: Date }>> {
      const due = await db.query<{ week: number }>(
        `SELECT g.week
           FROM nfl_games g LEFT JOIN game_windows w ON w.id = g.game_window_id
          WHERE g.season = $1
            AND NOT EXISTS (SELECT 1 FROM week_freezes f WHERE f.season = g.season AND f.week = g.week)
          GROUP BY g.week
         HAVING bool_and(g.is_final OR w.status IN ('canceled', 'postponed'))
            AND max(g.final_observed_at) IS NOT NULL
            AND max(g.final_observed_at) + interval '48 hours' <= $2::timestamptz
          ORDER BY g.week`,
        [season, serverNow]
      );

      const frozen: Array<{ week: number; scoresFrozen: number; lastFinalAt: Date }> = [];
      for (const { week } of due) {
        const done = await db.transaction(async (tx) => {
          await lockWeek(tx, season, week);
          if (await isFrozen(tx, season, week)) return null;
          // Re-check inside the lock: a game may have changed since the scan.
          const [chk] = await tx.query<{ ok: boolean; last_final_at: Date }>(
            `SELECT bool_and(g.is_final OR w.status IN ('canceled', 'postponed')) AS ok, max(g.final_observed_at) AS last_final_at
               FROM nfl_games g LEFT JOIN game_windows w ON w.id = g.game_window_id
              WHERE g.season = $1 AND g.week = $2`,
            [season, week]
          );
          if (!chk.ok || !chk.last_final_at || chk.last_final_at.getTime() + 48 * 3600_000 > serverNow.getTime()) return null;

          const scores = await tx.query(
            `UPDATE player_game_scores SET status = 'frozen' WHERE season = $1 AND week = $2 AND status <> 'frozen' RETURNING 1`,
            [season, week]
          );
          await tx.query(
            `UPDATE user_week_scores SET status = 'frozen', updated_at = $3::timestamptz
              WHERE season = $1 AND week = $2 AND status <> 'frozen'`,
            [season, week, serverNow]
          );
          await tx.query(
            `INSERT INTO week_freezes (season, week, last_final_at, frozen_at, scores_frozen)
             VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5::int)`,
            [season, week, chk.last_final_at, serverNow, scores.length]
          );
          if (options.afterFreeze) await options.afterFreeze(tx, { season, week, serverNow });
          return { week, scoresFrozen: scores.length, lastFinalAt: chk.last_final_at };
        });
        if (done) frozen.push(done);
      }
      return frozen;
    },

    /** §10 integrity check: recompute every frozen score from its stat line. Any mismatch should halt payouts. */
    async verifyFrozenWeek(season: string, week: number, rules: ScoringRules = CURRENT_RULES) {
      const rows = await db.query<Record<string, unknown> & { score_id: string; points_x100: number }>(
        `SELECT sc.id::text AS score_id, sc.points_x100, ${STAT_COLUMNS.map((c) => `st.${c}`).join(', ')}
           FROM player_game_scores sc JOIN player_game_stats st ON st.id = sc.stats_id
          WHERE sc.season = $1 AND sc.week = $2 AND sc.status = 'frozen'`,
        [season, week]
      );
      const mismatches = rows
        .map((r) => ({ scoreId: r.score_id, stored: r.points_x100, recomputed: scoreStatLine(rowToStats(r), rules) }))
        .filter((m) => m.stored !== m.recomputed);
      return { checked: rows.length, mismatches };
    },
  };
}

export type ScoringStore = ReturnType<typeof createScoringStore>;
