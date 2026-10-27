/**
 * Burn Engine — Core Types
 * Implements PRD-001 §2, §3
 */

export type SlotKey = 'qb' | 'rb1' | 'rb2' | 'wr1' | 'wr2' | 'wr3' | 'te' | 'flex' | 'k';

export type GameWindowStatus = 'pending' | 'locked' | 'final' | 'canceled' | 'postponed';

export type PlayerBurnState = 'available' | 'locked' | 'burned';

export type NFLPosition = 'QB' | 'RB' | 'FB' | 'WR' | 'TE' | 'K';

export type InjuryStatus = 'Active' | 'Questionable' | 'Doubtful' | 'Out' | 'IR' | 'PUP';

export interface GameWindow {
  id: string;
  week: number;
  season: string;
  label: string;
  scheduledEt: Date;   // authoritative lock time — actual kickoff is irrelevant
  status: GameWindowStatus;
  msfGameIds: string[];
  finalPostedAt?: Date;
}

export interface SeasonSubmission {
  id: string;
  userId: string;
  week: number;
  season: string;
  slotKey: SlotKey;
  playerId: string;         // MSF player ID
  gameWindowId: string;
  submittedAt: Date;
  lockedAt?: Date;          // set when game_window fires lock; null = not yet locked
  voidReason?: 'GAME_CANCELED' | 'ADMIN_VOID';
}

export interface BurnRecord {
  id: string;
  userId: string;
  playerId: string;
  season: string;
  week: number;
  gameWindowId: string;
  submissionId: string;
  lockedAt: Date;
  burnedAt: Date;
}

export interface PoolEntry {
  id: string;
  userId: string;
  playerId: string;
  season: string;
  burned: boolean;
  burnedAt?: Date;
}

export interface LockEventResult {
  gameWindowId: string;
  firedAt: Date;
  submissionsLocked: number;
  notificationsQueued: number;
}

/**
 * Outcome of evaluating a game window for burns (PRD-001 §5).
 * - burned:          window was locked and every game in it Final; burns committed
 * - awaiting_final:  window is locked but at least one game is not Final yet; nothing burned
 * - already_final:   burns for this window were already committed (idempotent re-report)
 * - rejected:        two-part criterion cannot apply (window never locked, canceled,
 *                    postponed, unknown, or has no MSF games mapped); nothing burned
 */
export type BurnEvaluationOutcome = 'burned' | 'awaiting_final' | 'already_final' | 'rejected';

export interface BurnEvaluationResult {
  gameWindowId: string;
  outcome: BurnEvaluationOutcome;
  burnsCreated: number;
  usersAffected: string[];
  /** MSF game IDs in the window not yet reported Final (outcome = awaiting_final). */
  pendingMsfGameIds?: string[];
  reason?: string;
}

export type SlotReopenOutcome = 'reopened' | 'rejected';

export interface SlotReopenResult {
  gameWindowId: string;
  outcome: SlotReopenOutcome;
  /** Locked submissions voided and returned to editable state (PRD-001 §6.1). */
  slotsReopened: number;
  /** One security_audit_log SLOT_REOPENED row per reopened slot. */
  auditLogIds: string[];
  reason?: string;
}

/**
 * Lineup draft — not yet submitted; no burn implications
 * Stored in Redis until user completes three-gate confirmation
 */
export interface LineupDraft {
  userId: string;
  week: number;
  season: string;
  slots: Partial<Record<SlotKey, string>>;  // slotKey → playerId
  savedAt: Date;
  expiresAt: Date;
}

/**
 * Three-gate confirmation record (PRD-001 §9)
 * Written to submission_receipts after Gate 3 completes.
 * Immutable after creation. Used for dispute resolution.
 */
export interface SubmissionReceipt {
  id: string;
  userId: string;
  week: number;
  season: string;
  lineupSnapshot: Record<SlotKey, string>;   // complete 9-slot snapshot at time of submission
  gate1At: Date;   // review screen displayed
  gate2At: Date;   // all three checkboxes checked
  gate3At: Date;   // slide/press-and-hold completed; submission committed
  ipAddress: string;
  userAgent: string;
  submissionId: string;
}

/**
 * Player display card — data required for selection UI (PRD-001 §10)
 * NIL compliance: no image URLs, no headshots, text only
 */
export interface PlayerCard {
  playerId: string;
  name: string;         // text only — no headshots per NIL compliance
  team: string;         // abbreviation
  position: NFLPosition;
  opponent: string;
  homeAway: 'home' | 'away';
  scheduledEt: Date;
  injuryStatus: InjuryStatus;
  projectedPoints: number;
  weekOwnershipPct: number;    // from Redis; max 5-min staleness
  seasonOwnershipPct: number;  // how many users have burned this player this season
  burnState: PlayerBurnState;  // relative to the requesting user
}

export const SLOT_ELIGIBLE_POSITIONS: Record<SlotKey, NFLPosition[]> = {
  qb:   ['QB'],
  rb1:  ['RB', 'FB'],   // FB eligible at RB and FLEX (decision 2026-10-27)
  rb2:  ['RB', 'FB'],
  wr1:  ['WR'],
  wr2:  ['WR'],
  wr3:  ['WR'],
  te:   ['TE'],
  flex: ['RB', 'FB', 'WR', 'TE'],
  k:    ['K'],
};
