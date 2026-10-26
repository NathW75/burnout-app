/**
 * Lock Engine
 * Implements PRD-001 §4
 *
 * Evaluates game windows whose scheduled_et has passed and fires lock events.
 * Called by the cron worker every minute.
 *
 * CRITICAL: Lock fires at scheduled_et. Actual kickoff time is irrelevant and
 * is never consulted here. The server clock (NTP-synced) is the sole authority.
 */

import type { LockEventResult, GameWindow } from './types';

/**
 * Result of trying to commit a lock for one window.
 * claimed=false means the window was no longer lockable when the transaction
 * ran: another worker locked it first, it was canceled, or its scheduled_et
 * was moved later (§6.4). Nothing was written.
 */
export type LockCommitOutcome =
  | { claimed: false }
  | { claimed: true; submissionsLocked: number; notificationsQueued: number };

export interface LockEngineDependencies {
  /**
   * Returns game windows with status = 'pending' AND scheduled_et <= serverNow,
   * ordered by scheduled_et.
   */
  getPendingWindowsToLock: (serverNow: Date) => Promise<GameWindow[]>;

  /**
   * In ONE transaction (PRD-001 §4.4):
   * 1. Claim the window: status 'pending' → 'locked', only if still pending and
   *    scheduled_et <= serverNow. If the claim fails, write nothing.
   * 2. Set season_submissions.locked_at = serverNow for every unlocked,
   *    non-voided submission in the window.
   * 3. Queue one LOCK notification per locked submission (outbox; delivered
   *    only after commit).
   * 4. Insert the lock_events row.
   * weekly_submissions are not touched (§3.3 burn isolation).
   */
  commitLock: (gameWindowId: string, serverNow: Date) => Promise<LockCommitOutcome>;

  /**
   * Server clock — never Date.now() in callers, never client time.
   * Sourced from the NTP-synced server clock.
   */
  getServerTime: () => Date;

  log: (level: 'info' | 'warn' | 'error', message: string, meta?: object) => void;
}

/**
 * Evaluates and fires all due lock events.
 * Idempotent and safe to run on several workers at once: each window is
 * claimed by a conditional update, so exactly one worker locks it.
 */
export async function evaluateAndFireLocks(deps: LockEngineDependencies): Promise<LockEventResult[]> {
  // One authoritative instant per cron tick. Every lock in this tick uses it.
  const serverNow = deps.getServerTime();
  const windowsToLock = await deps.getPendingWindowsToLock(serverNow);

  const results: LockEventResult[] = [];

  for (const window of windowsToLock) {
    // Defense in depth: never lock a window before its scheduled_et, whatever the query returned.
    if (window.scheduledEt.getTime() > serverNow.getTime()) {
      deps.log('warn', 'Lock engine: window returned but scheduledEt is in the future; skipped', {
        gameWindowId: window.id,
        scheduledEt: window.scheduledEt.toISOString(),
        serverNow: serverNow.toISOString(),
      });
      continue;
    }

    try {
      const outcome = await deps.commitLock(window.id, serverNow);

      if (!outcome.claimed) {
        deps.log('info', 'Lock engine: window no longer lockable (already locked, canceled, or rescheduled)', {
          gameWindowId: window.id,
        });
        continue;
      }

      results.push({
        gameWindowId: window.id,
        firedAt: serverNow,
        submissionsLocked: outcome.submissionsLocked,
        notificationsQueued: outcome.notificationsQueued,
      });

      deps.log('info', 'Lock fired', {
        gameWindowId: window.id,
        week: window.week,
        label: window.label,
        scheduledEt: window.scheduledEt.toISOString(),
        serverNow: serverNow.toISOString(),
        submissionsLocked: outcome.submissionsLocked,
        notificationsQueued: outcome.notificationsQueued,
      });
    } catch (err) {
      // The transaction rolled back. A failed lock on one window must not block
      // the others; the next tick retries this one.
      deps.log('error', 'Lock engine: commitLock failed; will retry next tick', {
        gameWindowId: window.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
