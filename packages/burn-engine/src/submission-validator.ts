/**
 * Submission Validator
 * Implements PRD-001 §9, §3
 *
 * Validates a lineup draft before the three-gate confirmation flow.
 * Does NOT write to the database — that happens in the API layer
 * after Gate 3 completes.
 */

import { SLOT_ELIGIBLE_POSITIONS } from './types';
import type { SlotKey, NFLPosition, LineupDraft } from './types';

export interface ValidationError {
  code: string;
  message: string;
  slot?: SlotKey;
  playerId?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface SubmissionValidatorDependencies {
  /**
   * Returns the set of player IDs available to this user for this season
   * (pool_entries where burned = false)
   */
  getUserAvailablePool: (userId: string, season: string) => Promise<Set<string>>;

  /**
   * Returns the position for a player ID (from MSF data, cached in Redis)
   */
  getPlayerPosition: (playerId: string) => Promise<NFLPosition | null>;

  /**
   * Returns the game_window_id for a player's scheduled game this week
   * Returns null if player has no game this week (bye week)
   */
  getPlayerGameWindowId: (playerId: string, week: number, season: string) => Promise<string | null>;

  /**
   * Returns game_windows.status for a window ID
   * If 'locked', 'final', or 'canceled', this player cannot be submitted
   */
  getGameWindowStatus: (gameWindowId: string) => Promise<string | null>;

  /**
   * Optional: the player's injury designation. Out and IR players are not
   * selectable (greyed out, not burned) — decision 2026-10-27.
   */
  getPlayerInjuryStatus?: (playerId: string) => Promise<string | null>;
}

/** Designations that make a player unselectable (decision 2026-10-27). */
export const INACTIVE_INJURY_STATUSES: ReadonlySet<string> = new Set(['Out', 'IR']);

export interface ValidateOptions {
  /**
   * Slots that cannot change (already locked, or left empty after every
   * window has passed). They are neither required nor validated, but their
   * players still count for the duplicate check. Used for re-saves after
   * part of the week has locked (PRD-006 §9.1).
   */
  fixedSlots?: Partial<Record<SlotKey, string | null>>;
  /**
   * Allow open slots to stay empty (Nath, 2026-10-29: the manager decides; an
   * empty slot scores 0 and burns nothing). Default false keeps the original
   * "all nine filled" rule for other callers.
   */
  allowEmpty?: boolean;
}

/**
 * Validates a complete 9-slot lineup draft before submission.
 * Must pass before the three-gate confirmation flow begins.
 */
export async function validateLineupDraft(
  draft: LineupDraft,
  deps: SubmissionValidatorDependencies,
  options: ValidateOptions = {}
): Promise<ValidationResult> {
  const errors: ValidationError[] = [];
  const fixed = options.fixedSlots ?? {};
  const isFixed = (slot: SlotKey) => Object.prototype.hasOwnProperty.call(fixed, slot);
  const slots = (Object.keys(draft.slots) as SlotKey[]).filter((slot) => !isFixed(slot));

  // 1. All 9 slots must be filled
  const requiredSlots: SlotKey[] = (['qb', 'rb1', 'rb2', 'wr1', 'wr2', 'wr3', 'te', 'flex', 'k'] as SlotKey[]).filter((slot) => !isFixed(slot));
  for (const slot of options.allowEmpty ? [] : requiredSlots) {
    if (!draft.slots[slot]) {
      errors.push({
        code: 'SLOT_EMPTY',
        message: `Slot ${slot} is not filled`,
        slot,
      });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // 2. Load user's available pool
  const availablePool = await deps.getUserAvailablePool(draft.userId, draft.season);

  // 3. Validate each slot
  const duplicateCheck = new Set<string>(Object.values(fixed).filter((p): p is string => !!p));

  for (const slot of slots) {
    const playerId = draft.slots[slot]!;

    // No duplicate players across slots
    if (duplicateCheck.has(playerId)) {
      errors.push({
        code: 'DUPLICATE_PLAYER',
        message: `Player ${playerId} appears in multiple slots`,
        slot,
        playerId,
      });
      continue;
    }
    duplicateCheck.add(playerId);

    // Player must be in user's available pool (not burned)
    if (!availablePool.has(playerId)) {
      errors.push({
        code: 'PLAYER_BURNED_OR_UNAVAILABLE',
        message: `Player ${playerId} is not in your available pool`,
        slot,
        playerId,
      });
      continue;
    }

    // Position eligibility
    const position = await deps.getPlayerPosition(playerId);
    if (!position) {
      errors.push({
        code: 'PLAYER_NOT_FOUND',
        message: `Player ${playerId} not found in player data`,
        slot,
        playerId,
      });
      continue;
    }

    if (deps.getPlayerInjuryStatus) {
      const injury = await deps.getPlayerInjuryStatus(playerId);
      if (injury && INACTIVE_INJURY_STATUSES.has(injury)) {
        errors.push({
          code: 'PLAYER_INACTIVE',
          message: `Player ${playerId} is listed ${injury} and can't be selected`,
          slot,
          playerId,
        });
        continue;
      }
    }

    const eligiblePositions = SLOT_ELIGIBLE_POSITIONS[slot];
    if (!eligiblePositions.includes(position)) {
      errors.push({
        code: 'POSITION_INELIGIBLE',
        message: `${position} player is not eligible for slot ${slot}`,
        slot,
        playerId,
      });
    }

    // Game window must not be locked, final, or canceled
    const gameWindowId = await deps.getPlayerGameWindowId(playerId, draft.week, draft.season);
    if (!gameWindowId) {
      errors.push({
        code: 'PLAYER_ON_BYE',
        message: `Player ${playerId} has no game this week (bye)`,
        slot,
        playerId,
      });
      continue;
    }

    const windowStatus = await deps.getGameWindowStatus(gameWindowId);
    if (!windowStatus || windowStatus !== 'pending') {
      errors.push({
        code: 'GAME_WINDOW_LOCKED',
        message: `The game window for player ${playerId} is no longer open for changes`,
        slot,
        playerId,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// NOTE: One-per-franchise rule is enforced ONLY for weekly contests,
// not season-long submission. That validation lives in the weekly
// contest submission path, not here.
