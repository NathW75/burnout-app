/**
 * Disruption Handler
 * Implements PRD-001 §6.1 (game canceled before any plays are run)
 *
 * All disruption events are sysadmin-initiated via admin tooling, never direct
 * SQL and never the user-facing API. Every slot reopen is recorded in
 * security_audit_log.
 *
 * §6.2 (suspended, resumed later) needs no code: the two-part criterion waits
 * for Final. §6.3 (moved to a different week) is a cancellation for the
 * original week. §6.4 (moved within the week) is an update to
 * game_windows.scheduled_et; the lock engine re-checks scheduled_et inside its
 * claim, so the window locks at the new time.
 */

import type { SlotReopenResult } from './types';

export type CancellationOutcome =
  | { applied: false; reason: string }
  | { applied: true; slotsReopened: number; auditLogIds: string[] };

export interface DisruptionHandlerDependencies {
  /**
   * In ONE transaction:
   * 1. Claim the window: status 'pending' | 'locked' → 'canceled'. A window
   *    that is already 'final' (burns committed) or 'canceled' is refused.
   * 2. For each locked, unburned, non-voided season_submissions row in the
   *    window: set locked_at = NULL, void_reason = 'GAME_CANCELED'. The voided
   *    row is the reopened slot; the user reassigns it through the lineup API.
   * 3. Make sure each affected player is available in the user's pool.
   * 4. Insert one security_audit_log SLOT_REOPENED row per reopened slot.
   * 5. Queue one SLOT_REOPENED notification per reopened slot (outbox).
   */
  commitCancellation: (params: {
    gameWindowId: string;
    adminUserId: string;
    authorizationReference: string;
    serverNow: Date;
  }) => Promise<CancellationOutcome>;

  getServerTime: () => Date;

  log: (level: 'info' | 'warn' | 'error', message: string, meta?: object) => void;
}

/**
 * Handles a game cancellation before any plays are run (§6.1): marks the
 * window canceled, un-locks affected players, and reopens their slots.
 *
 * The only authorized write path to void a locked submission. Call only from
 * admin tooling.
 *
 * MNF edge case: if every other window this week has already locked, the slot
 * reopens with no eligible reassignment candidates and scores 0 this week. The
 * player is not burned and is available next week. No special code path; the
 * UI and T&C must state it.
 */
export async function handleGameCancellation(
  gameWindowId: string,
  adminUserId: string,
  authorizationReference: string,
  deps: DisruptionHandlerDependencies
): Promise<SlotReopenResult> {
  const reference = authorizationReference.trim();
  if (!reference) {
    deps.log('warn', 'Disruption handler: rejected: authorization reference is required', { gameWindowId, adminUserId });
    return { gameWindowId, outcome: 'rejected', slotsReopened: 0, auditLogIds: [], reason: 'authorization reference is required' };
  }

  const serverNow = deps.getServerTime();
  const outcome = await deps.commitCancellation({
    gameWindowId,
    adminUserId,
    authorizationReference: reference,
    serverNow,
  });

  if (!outcome.applied) {
    deps.log('warn', `Disruption handler: rejected: ${outcome.reason}`, { gameWindowId, adminUserId });
    return { gameWindowId, outcome: 'rejected', slotsReopened: 0, auditLogIds: [], reason: outcome.reason };
  }

  deps.log('info', 'Game cancellation processed', {
    gameWindowId,
    slotsReopened: outcome.slotsReopened,
    adminUserId,
    authorizationReference: reference,
  });

  return {
    gameWindowId,
    outcome: 'reopened',
    slotsReopened: outcome.slotsReopened,
    auditLogIds: outcome.auditLogIds,
  };
}
