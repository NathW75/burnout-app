/**
 * Burn Evaluator
 * Implements PRD-001 §5
 *
 * Evaluates the two-part burn criterion for a game window when MySportsFeeds
 * reports Final status.
 *
 * TWO-PART CRITERION (non-negotiable):
 * A player is burned if and only if:
 *   (a) they were in the user's submitted lineup when their game window locked
 *   (b) the NFL has posted Final status for their game
 * Both must be true. Neither alone is sufficient.
 *
 * Window granularity: season_submissions are keyed to a game window, not an
 * individual game, so the engine cannot tell which game in a multi-game window
 * a player belongs to. Burns for a window therefore commit only when EVERY
 * game in the window is Final. Burning on the first Final in the window would
 * burn players whose games are still being played. Burning slightly late is
 * safe; burning early is not.
 *
 * burn_records is write-once. No application code path may modify a burn_record
 * after creation. The only authorized exception is a sysadmin SLOT_REOPENED event.
 */

import type { BurnEvaluationResult, GameWindow } from './types';

export type BurnCommitOutcome =
  | { claimed: false }
  | { claimed: true; burnsCreated: number; usersAffected: string[]; duplicatesSkipped: number };

export interface BurnEvaluatorDependencies {
  getGameWindow: (gameWindowId: string) => Promise<GameWindow | null>;

  /**
   * In ONE transaction:
   * 1. Claim the window: status 'locked' → 'final', final_posted_at = serverNow.
   *    If the claim fails (another worker finalized it, or it was canceled),
   *    write nothing and return { claimed: false }.
   * 2. For every season_submissions row in the window with locked_at IS NOT NULL,
   *    void_reason IS NULL, and no burn_records row yet:
   *    - insert burn_records (write-once; burned_at = serverNow)
   *    - mark pool_entries burned (burned = true, burned_at = serverNow)
   *    - queue one BURN notification per user listing every player burned
   *      (outbox; delivered after commit)
   * weekly_submissions are never read (§3.3 burn isolation).
   */
  commitBurns: (gameWindowId: string, serverNow: Date) => Promise<BurnCommitOutcome>;

  getServerTime: () => Date;

  log: (level: 'info' | 'warn' | 'error', message: string, meta?: object) => void;
}

export interface BurnEvaluationInput {
  gameWindowId: string;
  /** MSF game IDs that MySportsFeeds currently reports as Final. */
  finalMsfGameIds: Iterable<string>;
}

/**
 * Called by the MSF Final-status poller (§5.2) for a game window.
 * Safe to call repeatedly and from several workers: commits at most once.
 *
 * After a 'burned' outcome the caller should trigger the scoring engine
 * (PRD-002) for this window; this package does not own scoring.
 */
export async function evaluateAndCommitBurns(
  input: BurnEvaluationInput,
  deps: BurnEvaluatorDependencies
): Promise<BurnEvaluationResult> {
  const { gameWindowId } = input;
  const none = { gameWindowId, burnsCreated: 0, usersAffected: [] as string[] };
  const reject = (reason: string, level: 'warn' | 'error' = 'warn'): BurnEvaluationResult => {
    deps.log(level, `Burn evaluator: rejected: ${reason}`, { gameWindowId });
    return { ...none, outcome: 'rejected', reason };
  };

  const window = await deps.getGameWindow(gameWindowId);
  if (!window) return reject('unknown game window', 'error');

  switch (window.status) {
    case 'final':
      return { ...none, outcome: 'already_final' };
    case 'locked':
      break;
    case 'pending':
      // Final reported for a window that never locked: condition (a) cannot hold.
      // Indicates a schedule/clock problem worth paging on.
      return reject('window has not locked; condition (a) cannot be met', 'error');
    case 'canceled':
    case 'postponed':
      return reject(`window is ${window.status}`);
    default:
      return reject(`unexpected window status "${String(window.status)}"`, 'error');
  }

  if (window.msfGameIds.length === 0) {
    return reject('window has no MSF games mapped; Final cannot be established', 'error');
  }

  const finals = new Set(input.finalMsfGameIds);
  const pendingMsfGameIds = window.msfGameIds.filter((g) => !finals.has(g));
  if (pendingMsfGameIds.length > 0) {
    return { ...none, outcome: 'awaiting_final', pendingMsfGameIds };
  }

  const serverNow = deps.getServerTime();
  const outcome = await deps.commitBurns(gameWindowId, serverNow);

  if (!outcome.claimed) {
    // Lost the race to another worker, or the window changed state (e.g. canceled)
    // between the read and the transaction. Either way nothing was written here.
    deps.log('info', 'Burn evaluator: window already finalized or no longer locked', { gameWindowId });
    return { ...none, outcome: 'already_final' };
  }

  if (outcome.duplicatesSkipped > 0) {
    // A player already burned this season was locked again in this window
    // (see open question on cross-week locks). burn_records stays one-per-season.
    deps.log('warn', 'Burn evaluator: skipped burns for players already burned this season', {
      gameWindowId,
      duplicatesSkipped: outcome.duplicatesSkipped,
    });
  }

  deps.log('info', 'Burns committed', {
    gameWindowId,
    week: window.week,
    burnsCreated: outcome.burnsCreated,
    usersAffected: outcome.usersAffected.length,
    serverNow: serverNow.toISOString(),
  });

  return {
    gameWindowId,
    outcome: 'burned',
    burnsCreated: outcome.burnsCreated,
    usersAffected: outcome.usersAffected,
  };
}
