/**
 * Season schedule import — PRD-006 §11.6
 *
 * Builds game_windows from the MySportsFeeds season schedule: one window per
 * distinct scheduled kickoff per week (PRD-001 glossary). Each window locks at
 * exactly that kickoff (hard constraint 4), so a Sunday with 4:05 and 4:25
 * games has two late windows.
 *
 * Rules:
 * - A window is FROZEN once it is not 'pending', or once its kickoff has
 *   arrived (the lock job is about to claim it). Frozen windows are never
 *   changed; the database enforces it (WINDOW_SCHEDULE_FIXED). Feed changes to
 *   their games are reported for review: cancelling a locked game is an admin
 *   action (PRD-001 §6.1), never automatic.
 * - Pending windows follow the feed. A game whose kickoff moves is moved into
 *   the window for its new kickoff (created if needed); a postponed or
 *   canceled game leaves its window. The window's own kickoff never changes,
 *   so a lock time can't silently move.
 * - Picks on moved games are re-pointed or voided by the same re-resolve the
 *   roster sync uses (PRD-001 §6.4/§6.5), which notifies the user.
 * - A pending window left with no games is deleted when nothing references
 *   it, set to 'postponed' when only voided picks do, and reported otherwise.
 * - A game the feed no longer lists stays where it is and is reported, so a
 *   partial feed can't empty the schedule.
 * - Canceled windows are history. Once an admin cancels a locked game, the
 *   feed can place it again in the week it moved to (PRD-001 §6.3).
 * - A DELAYED game keeps its window: a delay is a late kickoff, not a new
 *   scheduled time.
 */
import type { GameStatus } from '@burnout/scoring-engine';
import type { ApiContext } from '../context';
import { reresolveSubmissions, type ReresolveResult } from '../players/roster';

/** Feed statuses meaning the game is not being played at its listed time. */
export const OFF_SCHEDULE_STATUSES: ReadonlySet<string> = new Set(['POSTPONED', 'CANCELED', 'CANCELLED']);
const KNOWN_STATUSES: ReadonlySet<string> = new Set(['NORMAL', 'DELAYED', 'SUSPENDED', ...OFF_SCHEDULE_STATUSES]);

export type ScheduleReviewReason =
  | 'LOCKED_GAME_MOVED' //            the feed moved a game whose window is frozen
  | 'LOCKED_GAME_OFF_SCHEDULE' //     the feed postponed/canceled a frozen game: admin cancellation (§6.1/§6.3)
  | 'GAME_MISSING_FROM_FEED' //       a game we hold isn't in the feed any more
  | 'UNKNOWN_SCHEDULE_STATUS' //      kept in its window; check what the status means
  | 'EMPTY_WINDOW_HAS_LIVE_PICKS'; // all games left a window that still has unlocked picks

export interface ScheduleReviewItem {
  reason: ScheduleReviewReason;
  msfGameId?: string;
  windowId?: string;
  detail?: Record<string, unknown>;
}

export interface ScheduleImportResult {
  gamesInFeed: number;
  windowsCreated: number;
  windowsUpdated: number;
  windowsRemoved: number;
  windowsPostponed: number;
  gamesUnscheduled: number;
  reresolve: ReresolveResult | null;
  review: ScheduleReviewItem[];
}

const ET = 'America/New_York';

/** "Sunday Late · 4:25 PM": day, block and exact kickoff (ET). */
export function windowLabel(kickoff: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: ET, weekday: 'long', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(kickoff);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const h24 = Number(new Intl.DateTimeFormat('en-US', { timeZone: ET, hour: 'numeric', hourCycle: 'h23' }).format(kickoff));
  const day = get('weekday');
  const block = day === 'Sunday'
    ? h24 < 12 ? 'Morning' : h24 < 16 ? 'Early' : h24 < 19 ? 'Late' : 'Night'
    : h24 < 12 ? 'Morning' : h24 < 17 ? 'Afternoon' : 'Night';
  return `${day} ${block} · ${get('hour')}:${get('minute')} ${get('dayPeriod').toUpperCase()}`;
}

interface WindowRow {
  id: string;
  week: number;
  scheduled_et: Date;
  status: string;
  label: string;
  msf_game_ids: string[];
}

const keyOf = (week: number, at: Date | number) => `${week}|${typeof at === 'number' ? at : at.getTime()}`;
const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

export async function importSchedule(ctx: ApiContext, season: string, feed: GameStatus[]): Promise<ScheduleImportResult> {
  const now = ctx.now();
  const review: ScheduleReviewItem[] = [];
  const result: ScheduleImportResult = {
    gamesInFeed: feed.length, windowsCreated: 0, windowsUpdated: 0, windowsRemoved: 0, windowsPostponed: 0,
    gamesUnscheduled: 0, reresolve: null, review,
  };

  const emptied = await ctx.db.transaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`burnout:schedule:${season}`]);
    const windows = await tx.query<WindowRow>(
      `SELECT id::text AS id, week, scheduled_et, status, label, msf_game_ids
         FROM game_windows WHERE season = $1 ORDER BY scheduled_et, id FOR UPDATE`,
      [season]
    );
    const frozen = (w: WindowRow) => w.status !== 'pending' || new Date(w.scheduled_et) <= now;

    // Where each game sits today. A frozen window's claim wins over a pending one.
    // Canceled windows are history: a game moved to another week after an admin
    // canceled it (PRD-001 §6.3) is placed again in its new week.
    const placedIn = new Map<string, WindowRow>();
    for (const w of windows) {
      if (w.status === 'canceled') continue;
      for (const id of w.msf_game_ids) {
        const cur = placedIn.get(id);
        if (!cur || (frozen(w) && !frozen(cur))) placedIn.set(id, w);
      }
    }
    const feedById = new Map(feed.map((g) => [g.msfGameId, g]));

    // 1. Frozen games are never re-placed; report anything the feed changed about them.
    const frozenGames = new Set<string>();
    for (const [id, w] of placedIn) {
      if (!frozen(w)) continue;
      frozenGames.add(id);
      const g = feedById.get(id);
      if (!g) {
        review.push({ reason: 'GAME_MISSING_FROM_FEED', msfGameId: id, windowId: w.id });
      } else if (OFF_SCHEDULE_STATUSES.has(g.scheduleStatus)) {
        review.push({ reason: 'LOCKED_GAME_OFF_SCHEDULE', msfGameId: id, windowId: w.id, detail: { scheduleStatus: g.scheduleStatus, windowStatus: w.status } });
      } else if (g.week !== w.week || g.scheduledStart.getTime() !== new Date(w.scheduled_et).getTime()) {
        if (g.scheduleStatus !== 'DELAYED') {
          review.push({ reason: 'LOCKED_GAME_MOVED', msfGameId: id, windowId: w.id,
            detail: { windowKickoff: new Date(w.scheduled_et).toISOString(), feedKickoff: g.scheduledStart.toISOString(), feedWeek: g.week } });
        }
      }
    }

    // 2. Where every other game should be. A locked window's kickoff is closed:
    //    a game moving onto it stays where it is and is reported.
    const closedKickoffs = new Set(
      windows.filter((x) => frozen(x) && x.status !== 'canceled' && x.status !== 'postponed').map((x) => keyOf(x.week, new Date(x.scheduled_et)))
    );
    const groups = new Map<string, { week: number; at: Date; ids: string[] }>();
    const place = (id: string, week: number, at: Date) => {
      const k = keyOf(week, at);
      const grp = groups.get(k) ?? { week, at, ids: [] };
      grp.ids.push(id);
      groups.set(k, grp);
    };
    const unscheduled: GameStatus[] = [];
    for (const g of feed) {
      if (frozenGames.has(g.msfGameId)) continue;
      if (OFF_SCHEDULE_STATUSES.has(g.scheduleStatus)) {
        unscheduled.push(g);
        continue;
      }
      if (!KNOWN_STATUSES.has(g.scheduleStatus)) {
        review.push({ reason: 'UNKNOWN_SCHEDULE_STATUS', msfGameId: g.msfGameId, detail: { scheduleStatus: g.scheduleStatus } });
      }
      const cur = placedIn.get(g.msfGameId);
      const [week, at] = g.scheduleStatus === 'DELAYED' && cur ? [cur.week, new Date(cur.scheduled_et)] : [g.week, g.scheduledStart];
      if (closedKickoffs.has(keyOf(week, at))) {
        review.push({ reason: 'LOCKED_GAME_MOVED', msfGameId: g.msfGameId, detail: { feedKickoff: at.toISOString(), feedWeek: week } });
        if (cur) place(g.msfGameId, cur.week, new Date(cur.scheduled_et));
        continue;
      }
      place(g.msfGameId, week, at);
    }
    for (const [id, w] of placedIn) {
      if (frozen(w) || feedById.has(id)) continue;
      review.push({ reason: 'GAME_MISSING_FROM_FEED', msfGameId: id, windowId: w.id });
      place(id, w.week, new Date(w.scheduled_et)); // stays put
    }

    // 3. Reconcile pending windows with the groups. A window's kickoff never changes.
    const pendingByKey = new Map<string, WindowRow>();
    for (const w of windows) {
      if (frozen(w)) continue;
      const k = keyOf(w.week, new Date(w.scheduled_et));
      if (!pendingByKey.has(k)) pendingByKey.set(k, w);
    }
    const matched = new Set<string>();
    const windowOfGame = new Map<string, string>();
    for (const [k, grp] of [...groups].sort((a, b) => a[1].at.getTime() - b[1].at.getTime())) {
      const ids = [...grp.ids].sort();
      const label = windowLabel(grp.at);
      let w = pendingByKey.get(k);
      if (w) {
        matched.add(w.id);
        if (!sameIds(ids, w.msf_game_ids) || w.label !== label) {
          await tx.query(`UPDATE game_windows SET msf_game_ids = $2::text[], label = $3 WHERE id = $1::uuid`, [w.id, ids, label]);
          result.windowsUpdated++;
        }
      } else {
        const [row] = await tx.query<{ id: string }>(
          `INSERT INTO game_windows (week, season, label, scheduled_et, status, msf_game_ids)
           VALUES ($1, $2, $3, $4::timestamptz, 'pending', $5::text[]) RETURNING id::text AS id`,
          [grp.week, season, label, grp.at, ids]
        );
        w = { id: row.id, week: grp.week, scheduled_et: grp.at, status: 'pending', label, msf_game_ids: ids };
        matched.add(w.id);
        result.windowsCreated++;
      }
      for (const id of ids) windowOfGame.set(id, w.id);
    }
    const emptiedIds: string[] = [];
    for (const w of windows) {
      if (frozen(w) || matched.has(w.id)) continue;
      if (w.msf_game_ids.length > 0) {
        await tx.query(`UPDATE game_windows SET msf_game_ids = '{}' WHERE id = $1::uuid`, [w.id]);
        result.windowsUpdated++;
      }
      emptiedIds.push(w.id);
    }

    // 4. nfl_games rows (team lookups for lineups go through them). Scoring owns
    //    played status and finals; this only writes the schedule fields.
    for (const g of feed) {
      const windowId = windowOfGame.get(g.msfGameId);
      if (!windowId) continue;
      await tx.query(
        `INSERT INTO nfl_games (msf_game_id, season, week, game_window_id, scheduled_start, played_status, schedule_status,
                                is_final, final_observed_at, updated_at, home_team, away_team)
         VALUES ($1, $2, $3, $4::uuid, $5::timestamptz, $6, $7, $8::boolean, CASE WHEN $8::boolean THEN $9::timestamptz END, $9::timestamptz, $10, $11)
         ON CONFLICT (msf_game_id) DO UPDATE SET
           week = EXCLUDED.week, game_window_id = EXCLUDED.game_window_id, scheduled_start = EXCLUDED.scheduled_start,
           schedule_status = EXCLUDED.schedule_status,
           home_team = COALESCE(EXCLUDED.home_team, nfl_games.home_team), away_team = COALESCE(EXCLUDED.away_team, nfl_games.away_team),
           updated_at = EXCLUDED.updated_at
         WHERE (nfl_games.week, nfl_games.game_window_id, nfl_games.scheduled_start, nfl_games.schedule_status, nfl_games.home_team, nfl_games.away_team)
               IS DISTINCT FROM (EXCLUDED.week, EXCLUDED.game_window_id, EXCLUDED.scheduled_start, EXCLUDED.schedule_status,
                                 COALESCE(EXCLUDED.home_team, nfl_games.home_team), COALESCE(EXCLUDED.away_team, nfl_games.away_team))`,
        [g.msfGameId, season, g.week, windowId, g.scheduledStart, g.playedStatus, g.scheduleStatus, g.isFinal, now, g.homeTeam ?? null, g.awayTeam ?? null]
      );
    }
    // Postponed / canceled games that aren't frozen: no window, so their players have no game this week.
    for (const g of unscheduled) {
      const changed = await tx.query(
        `INSERT INTO nfl_games (msf_game_id, season, week, game_window_id, scheduled_start, played_status, schedule_status, is_final, updated_at, home_team, away_team)
         VALUES ($1, $2, $3, NULL, $4::timestamptz, $5, $6, false, $7::timestamptz, $8, $9)
         ON CONFLICT (msf_game_id) DO UPDATE SET game_window_id = NULL, schedule_status = EXCLUDED.schedule_status, updated_at = EXCLUDED.updated_at
         WHERE nfl_games.game_window_id IS DISTINCT FROM NULL OR nfl_games.schedule_status IS DISTINCT FROM EXCLUDED.schedule_status
         RETURNING 1`,
        [g.msfGameId, season, g.week, g.scheduledStart, g.playedStatus, g.scheduleStatus, now, g.homeTeam ?? null, g.awayTeam ?? null]
      );
      result.gamesUnscheduled += changed.length;
    }
    return emptiedIds;
  });

  // 5. Picks follow their players' games (re-point or void, with notices).
  const changed = result.windowsCreated + result.windowsUpdated + result.gamesUnscheduled > 0;
  const [cw] = await ctx.db.query<{ week: number }>(
    `SELECT week FROM game_windows WHERE season = $1 AND status = 'pending' AND scheduled_et > $2 AND cardinality(msf_game_ids) > 0 ORDER BY scheduled_et LIMIT 1`,
    [season, now]
  );
  if (changed && cw) result.reresolve = await reresolveSubmissions(ctx, season, cw.week);

  // 6. Retire windows that lost all their games.
  if (emptied.length) {
    await ctx.db.transaction(async (tx) => {
      const removed = await tx.query<{ id: string }>(
        `DELETE FROM game_windows w
          WHERE w.id = ANY ($1::uuid[]) AND w.status = 'pending' AND cardinality(w.msf_game_ids) = 0
            AND NOT EXISTS (SELECT 1 FROM season_submissions x WHERE x.game_window_id = w.id)
            AND NOT EXISTS (SELECT 1 FROM weekly_submissions x WHERE x.game_window_id = w.id)
            AND NOT EXISTS (SELECT 1 FROM lock_events x WHERE x.game_window_id = w.id)
            AND NOT EXISTS (SELECT 1 FROM burn_records x WHERE x.game_window_id = w.id)
            AND NOT EXISTS (SELECT 1 FROM player_game_stats x WHERE x.game_window_id = w.id)
            AND NOT EXISTS (SELECT 1 FROM player_game_scores x WHERE x.game_window_id = w.id)
        RETURNING w.id::text AS id`,
        [emptied]
      );
      result.windowsRemoved = removed.length;
      const left = emptied.filter((id) => !removed.some((r) => r.id === id));
      if (!left.length) return;
      // Only voided picks left: 'postponed' keeps the window from ever locking.
      const parked = await tx.query<{ id: string }>(
        `UPDATE game_windows w SET status = 'postponed'
          WHERE w.id = ANY ($1::uuid[]) AND w.status = 'pending' AND cardinality(w.msf_game_ids) = 0
            AND NOT EXISTS (SELECT 1 FROM season_submissions x WHERE x.game_window_id = w.id AND x.locked_at IS NULL AND x.void_reason IS NULL)
        RETURNING w.id::text AS id`,
        [left]
      );
      result.windowsPostponed = parked.length;
      for (const id of left.filter((x) => !parked.some((p) => p.id === x))) review.push({ reason: 'EMPTY_WINDOW_HAS_LIVE_PICKS', windowId: id });
    });
  }

  ctx.log(review.length ? 'warn' : 'info', 'schedule imported', { season, ...result, reresolve: result.reresolve, review });
  return result;
}
