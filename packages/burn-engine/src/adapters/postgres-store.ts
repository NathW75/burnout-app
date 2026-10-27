/**
 * Postgres implementation of the burn engine's storage dependencies
 * (PRD-001 §4.4, §5.2, §6.1).
 *
 * Every state change is one transaction, and every transaction starts with a
 * conditional UPDATE on game_windows that claims the window's state
 * transition (pending→locked, locked→final, pending|locked→canceled). If the
 * claim matches no row, the transaction writes nothing. That is what makes the
 * lock cron and the Final poller safe to run on several workers at once, and
 * what stops a canceled window from being burned or a rescheduled window from
 * locking at its old time.
 *
 * Isolation: READ COMMITTED (Postgres default) is sufficient. The claim
 * UPDATE takes a row lock on the game window, and concurrent claimers re-check
 * the WHERE clause against the committed row after the lock is released.
 *
 * Submission writers (the lineup API) must read the window with
 * SELECT … FOR SHARE in the same transaction that inserts or edits a
 * season_submissions row and refuse unless status = 'pending'. That serializes
 * submissions against the lock claim so no submission can slip in after lock.
 *
 * weekly_submissions is never read or written here (§3.3 burn isolation).
 */

import type { SqlDatabase, SqlRunner } from '../sql';
import type { GameWindow, GameWindowStatus } from '../types';
import type { LockCommitOutcome } from '../lock-engine';
import type { BurnCommitOutcome } from '../burn-evaluator';
import type { CancellationOutcome } from '../disruption-handler';

interface GameWindowRow {
  id: string;
  week: number;
  season: string;
  label: string;
  scheduled_et: Date;
  status: GameWindowStatus;
  msf_game_ids: string[];
  final_posted_at: Date | null;
}

const WINDOW_COLUMNS = `id::text AS id, week, season, label, scheduled_et, status, msf_game_ids, final_posted_at`;

function toGameWindow(r: GameWindowRow): GameWindow {
  return {
    id: r.id,
    week: Number(r.week),
    season: r.season,
    label: r.label,
    scheduledEt: r.scheduled_et,
    status: r.status,
    msfGameIds: r.msf_game_ids ?? [],
    ...(r.final_posted_at ? { finalPostedAt: r.final_posted_at } : {}),
  };
}

/** Locked, not voided, not yet burned: condition (a) holds and no burn exists yet. */
const ELIGIBLE_FOR_BURN = `
  s.game_window_id = $1::uuid
  AND s.locked_at IS NOT NULL
  AND s.void_reason IS NULL
  AND NOT EXISTS (SELECT 1 FROM burn_records b WHERE b.submission_id = s.id)`;

export interface PostgresBurnStore {
  getPendingWindowsToLock(serverNow: Date): Promise<GameWindow[]>;
  getGameWindow(gameWindowId: string): Promise<GameWindow | null>;
  commitLock(gameWindowId: string, serverNow: Date): Promise<LockCommitOutcome>;
  commitBurns(gameWindowId: string, serverNow: Date): Promise<BurnCommitOutcome>;
  commitCancellation(params: {
    gameWindowId: string;
    adminUserId: string;
    authorizationReference: string;
    serverNow: Date;
  }): Promise<CancellationOutcome>;
}

/** Runs inside the lock transaction after the lock is written (e.g. leaderboard week_start snapshots, PRD-003 §4.1). */
export type AfterLockHook = (
  tx: SqlRunner,
  ctx: { gameWindowId: string; season: string; week: number; serverNow: Date }
) => Promise<void>;

export interface PostgresBurnStoreOptions {
  /**
   * Runs inside the lock transaction, within a SAVEPOINT. If it throws, only
   * its own writes roll back: the lock still commits on time. A downstream
   * feature (e.g. leaderboard snapshots) must never delay or block a lock.
   */
  afterLock?: AfterLockHook;
  /** Called when afterLock fails. Wire to an alerting logger. */
  onAfterLockError?: (err: unknown, ctx: { gameWindowId: string }) => void;
}

export function createPostgresBurnStore(db: SqlDatabase, options: PostgresBurnStoreOptions = {}): PostgresBurnStore {
  return {
    async getPendingWindowsToLock(serverNow) {
      const rows = await db.query<GameWindowRow>(
        `SELECT ${WINDOW_COLUMNS}
           FROM game_windows
          WHERE status = 'pending' AND scheduled_et <= $1::timestamptz
          ORDER BY scheduled_et, id`,
        [serverNow]
      );
      return rows.map(toGameWindow);
    },

    async getGameWindow(gameWindowId) {
      const [row] = await db.query<GameWindowRow>(
        `SELECT ${WINDOW_COLUMNS} FROM game_windows WHERE id = $1::uuid`,
        [gameWindowId]
      );
      return row ? toGameWindow(row) : null;
    },

    commitLock(gameWindowId, serverNow) {
      return db.transaction(async (tx): Promise<LockCommitOutcome> => {
        // 1. Claim pending → locked. Re-checks scheduled_et so a window moved
        //    later (§6.4) between the read and now does not lock early.
        const [claimed] = await tx.query<{ label: string; season: string; week: number }>(
          `UPDATE game_windows
              SET status = 'locked'
            WHERE id = $1::uuid AND status = 'pending' AND scheduled_et <= $2::timestamptz
        RETURNING label, season, week`,
          [gameWindowId, serverNow]
        );
        if (!claimed) return { claimed: false };

        // 2 + 3. Lock submissions and queue ONE LOCK notification per user listing
        //        all of their players locked in this window (PRD-001 §8.1), in one statement.
        const [counts] = await tx.query<{ submissions_locked: number; notifications_queued: number }>(
          `WITH locked AS (
             UPDATE season_submissions
                SET locked_at = $2::timestamptz
              WHERE game_window_id = $1::uuid AND locked_at IS NULL AND void_reason IS NULL
          RETURNING id, user_id, player_id, slot_key, week
           ), queued AS (
             INSERT INTO notification_queue (user_id, kind, game_window_id, payload)
             SELECT user_id, 'LOCK', $1::uuid,
                    jsonb_build_object(
                      'gameWindowId', $1::uuid, 'windowLabel', $3::text, 'lockedAt', $2::timestamptz,
                      'week', min(week),
                      'players', jsonb_agg(
                        jsonb_build_object('submissionId', id, 'playerId', player_id, 'slotKey', slot_key)
                        ORDER BY slot_key))
               FROM locked
              GROUP BY user_id
          RETURNING 1
           )
           SELECT (SELECT count(*) FROM locked)::int AS submissions_locked,
                  (SELECT count(*) FROM queued)::int AS notifications_queued`,
          [gameWindowId, serverNow, claimed.label]
        );

        // 4. Audit row. Last statement: if anything above failed we never get here.
        await tx.query(
          `INSERT INTO lock_events (game_window_id, fired_at, submissions_locked, notifications_queued)
           VALUES ($1::uuid, $2::timestamptz, $3::int, $4::int)`,
          [gameWindowId, serverNow, counts.submissions_locked, counts.notifications_queued]
        );

        // Same transaction, isolated by a savepoint: commits with the lock when it
        // succeeds, rolls back alone when it fails. The lock is never held hostage.
        if (options.afterLock) {
          await tx.query(`SAVEPOINT after_lock_hook`);
          try {
            await options.afterLock(tx, { gameWindowId, season: claimed.season, week: Number(claimed.week), serverNow });
            await tx.query(`RELEASE SAVEPOINT after_lock_hook`);
          } catch (err) {
            await tx.query(`ROLLBACK TO SAVEPOINT after_lock_hook`);
            options.onAfterLockError?.(err, { gameWindowId });
          }
        }

        return {
          claimed: true,
          submissionsLocked: counts.submissions_locked,
          notificationsQueued: counts.notifications_queued,
        };
      });
    },

    commitBurns(gameWindowId, serverNow) {
      return db.transaction(async (tx): Promise<BurnCommitOutcome> => {
        // 1. Claim locked → final. The burn_records INSERT trigger requires the
        //    window to be 'final' (condition b), so this must come first.
        const [claimed] = await tx.query<{ id: string }>(
          `UPDATE game_windows
              SET status = 'final', final_posted_at = $2::timestamptz
            WHERE id = $1::uuid AND status = 'locked'
        RETURNING id::text AS id`,
          [gameWindowId, serverNow]
        );
        if (!claimed) return { claimed: false };

        // 2. Mark pool entries burned (creates the entry if the season seed missed it;
        //    burn_records has a foreign key to pool_entries).
        await tx.query(
          `INSERT INTO pool_entries (user_id, player_id, season, burned, burned_at)
           SELECT DISTINCT s.user_id, s.player_id, s.season, true, $2::timestamptz
             FROM season_submissions s
            WHERE ${ELIGIBLE_FOR_BURN}
           ON CONFLICT (user_id, player_id, season)
           DO UPDATE SET burned = true, burned_at = COALESCE(pool_entries.burned_at, EXCLUDED.burned_at)`,
          [gameWindowId, serverNow]
        );

        // 3. Write-once burn records + one BURN notification per user (PRD-001 §8.2). ON CONFLICT DO NOTHING keeps
        //    burns one-per-player-per-season if a player was somehow locked twice.
        const [res] = await tx.query<{ eligible: number; burns_created: number; users_affected: string[] }>(
          `WITH eligible AS (
             SELECT s.id, s.user_id, s.player_id, s.season, s.week, s.game_window_id, s.locked_at
               FROM season_submissions s
              WHERE ${ELIGIBLE_FOR_BURN}
           ), inserted AS (
             INSERT INTO burn_records (user_id, player_id, season, week, game_window_id, submission_id, locked_at, burned_at)
             SELECT user_id, player_id, season, week, game_window_id, id, locked_at, $2::timestamptz
               FROM eligible
             ON CONFLICT (user_id, player_id, season) DO NOTHING
          RETURNING id, user_id, player_id, submission_id, week
           ), queued AS (
             INSERT INTO notification_queue (user_id, kind, game_window_id, payload)
             SELECT user_id, 'BURN', $1::uuid,
                    jsonb_build_object(
                      'gameWindowId', $1::uuid, 'burnedAt', $2::timestamptz, 'week', min(week),
                      'players', jsonb_agg(
                        jsonb_build_object('burnRecordId', id, 'submissionId', submission_id, 'playerId', player_id)
                        ORDER BY player_id))
               FROM inserted
              GROUP BY user_id
          RETURNING 1
           )
           SELECT (SELECT count(*) FROM eligible)::int AS eligible,
                  (SELECT count(*) FROM inserted)::int AS burns_created,
                  (SELECT COALESCE(array_agg(DISTINCT user_id::text), '{}'::text[]) FROM inserted) AS users_affected,
                  (SELECT count(*) FROM queued)::int AS notifications_queued`,
          [gameWindowId, serverNow]
        );

        return {
          claimed: true,
          burnsCreated: res.burns_created,
          usersAffected: res.users_affected,
          duplicatesSkipped: res.eligible - res.burns_created,
        };
      });
    },

    commitCancellation({ gameWindowId, adminUserId, authorizationReference, serverNow }) {
      return db.transaction(async (tx): Promise<CancellationOutcome> => {
        // 1. Claim pending|locked → canceled. A final window has committed burns; refuse.
        const [claimed] = await tx.query<{ id: string }>(
          `UPDATE game_windows SET status = 'canceled'
            WHERE id = $1::uuid AND status IN ('pending', 'locked')
        RETURNING id::text AS id`,
          [gameWindowId]
        );
        if (!claimed) {
          const [cur] = await tx.query<{ status: string }>(`SELECT status FROM game_windows WHERE id = $1::uuid`, [gameWindowId]);
          return { applied: false, reason: cur ? `window is ${cur.status}; only pending or locked windows can be canceled` : 'unknown game window' };
        }

        // 2–5. Void locks, restore pool availability, audit, notify. One statement.
        const [res] = await tx.query<{ slots_reopened: number; audit_ids: string[] }>(
          `WITH target AS (
             SELECT s.id, s.locked_at
               FROM season_submissions s
              WHERE ${ELIGIBLE_FOR_BURN}
                FOR UPDATE
           ), voided AS (
             UPDATE season_submissions s
                SET locked_at = NULL, void_reason = 'GAME_CANCELED'
               FROM target t
              WHERE s.id = t.id
          RETURNING s.id, s.user_id, s.player_id, s.slot_key, s.season, s.week, t.locked_at AS previous_locked_at
           ), pool AS (
             INSERT INTO pool_entries (user_id, player_id, season, burned, burned_at)
             SELECT DISTINCT user_id, player_id, season, false, NULL::timestamptz FROM voided
             ON CONFLICT (user_id, player_id, season) DO UPDATE
                SET burned = false, burned_at = NULL
              WHERE pool_entries.burned
                AND NOT EXISTS (
                  SELECT 1 FROM burn_records b
                   WHERE b.user_id = pool_entries.user_id AND b.player_id = pool_entries.player_id
                     AND b.season = pool_entries.season)
          RETURNING 1
           ), audit AS (
             INSERT INTO security_audit_log
               (event_type, game_id, user_id, slot_key, authorization_reference, performed_by, performed_at, metadata)
             SELECT 'SLOT_REOPENED', $1::uuid, user_id, slot_key, $2::text, $3::uuid, $4::timestamptz,
                    jsonb_build_object(
                      'reason', 'GAME_CANCELED', 'submissionId', id, 'playerId', player_id,
                      'week', week, 'previousLockedAt', previous_locked_at)
               FROM voided
          RETURNING id
           ), queued AS (
             INSERT INTO notification_queue (user_id, kind, game_window_id, payload)
             SELECT user_id, 'SLOT_REOPENED', $1::uuid,
                    jsonb_build_object(
                      'submissionId', id, 'playerId', player_id, 'slotKey', slot_key, 'week', week,
                      'gameWindowId', $1::uuid, 'reason', 'GAME_CANCELED')
               FROM voided
          RETURNING 1
           )
           SELECT (SELECT count(*) FROM voided)::int AS slots_reopened,
                  (SELECT count(*) FROM pool)::int AS pool_restored,
                  (SELECT count(*) FROM queued)::int AS notifications_queued,
                  (SELECT COALESCE(array_agg(id::text ORDER BY id), '{}'::text[]) FROM audit) AS audit_ids`,
          [gameWindowId, authorizationReference, adminUserId, serverNow]
        );

        return { applied: true, slotsReopened: res.slots_reopened, auditLogIds: res.audit_ids };
      });
    },
  };
}
