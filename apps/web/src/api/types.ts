/** Response shapes from the PRD-006 API (v1.6). */

export type SlotKey = 'qb' | 'rb1' | 'rb2' | 'wr1' | 'wr2' | 'wr3' | 'te' | 'flex' | 'k';
export type Slots = Record<SlotKey, string | null>;

export interface Me {
  id: string;
  email: string;
  handle: string | null;
  role: 'user' | 'admin';
  emailVerified: boolean;
  mfaEnrolled: boolean;
  stepUpUntil: string | null;
}

export interface LoginResponse {
  mfaRequired: boolean;
  mfaEnrollmentRequired: boolean;
}

export interface TotpSetup {
  secret: string;
  otpauthUrl: string;
}

export interface Eligibility {
  prizeEligible: boolean;
  freePlayThroughWeek: number | null;
}

export type VoidReason = 'GAME_CANCELED' | 'ADMIN_VOID' | 'PLAYER_NO_GAME' | 'PLAYER_INACTIVE' | 'PLAYER_MERGED';

export interface DescribedSlot {
  slot: SlotKey;
  playerId: string | null;
  name: string | null;
  team: string | null;
  position: string | null;
  opponent: string | null;
  scheduledEt: string | null;
  /** Frozen: locked, or its window's scheduled kickoff has passed. */
  locked: boolean;
}

export interface LineupSlot extends DescribedSlot {
  voidReason: VoidReason | null;
  lockedAt: string | null;
}

export interface Lineup {
  season: string;
  week: number;
  eligibility: Eligibility;
  slots: LineupSlot[];
}

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
  burnState: 'available' | 'locked' | 'burned';
  selectable: boolean;
  unavailableReason: 'BURNED' | 'LOCKED' | 'INACTIVE' | 'BYE' | 'WINDOW_CLOSED' | null;
}

export interface Pool {
  season: string;
  week: number;
  players: PlayerCard[];
}

export type WindowStatus = 'pending' | 'locked' | 'final' | 'canceled';

export interface GameWindow {
  id: string;
  label: string;
  scheduledEt: string;
  status: WindowStatus;
  games: Array<{ away: string | null; home: string | null }>;
}

export interface SeasonCurrent {
  season: string;
  currentWeek: number | null;
  weeks: Array<{ week: number; firstLock: string; lastLock: string; status: 'upcoming' | 'live' | 'complete' }>;
}

export interface FieldRow {
  rank: number;
  handle: string;
  pointsX100: number;
  weekPointsX100: number;
  isMe: boolean;
}

export interface FieldMe {
  season: string;
  week: number;
  fieldSize: number;
  me: FieldRow | null;
}

export interface Burn {
  week: number;
  slot: SlotKey | null;
  playerId: string;
  name: string | null;
  position: string | null;
  team: string | null;
  pointsX100: number;
  burnedAt: string;
  windowLabel: string;
}

export interface Notification {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
  read: boolean;
}

export interface Notifications {
  unread: number;
  items: Notification[];
  nextBefore: string | null;
}

export interface ReviewResponse {
  confirmationId: string;
  gate1At: string;
  expiresAt: string;
  slots: DescribedSlot[];
}

export interface ConfirmResponse {
  receiptId: string;
  gate3At: string;
  sha256: string;
  changedSlots: SlotKey[];
  slots: Array<{ slot: SlotKey; playerId: string | null; gameWindowId: string | null; locked: boolean }>;
}

export interface Receipt {
  id: string;
  season: string;
  week: number;
  slots: Array<{ slot: SlotKey; playerId: string | null; gameWindowId: string | null; locked: boolean }>;
  gate1_at: string;
  gate2_at: string;
  gate3_at: string;
  sha256: string;
  confirmation_id: string;
}

export interface ValidationIssue {
  code: string;
  message: string;
  slot?: SlotKey;
  playerId?: string;
}
