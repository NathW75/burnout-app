/** Response shapes from the PRD-006 API (v1.6). */

export type SlotKey = 'qb' | 'rb1' | 'rb2' | 'wr1' | 'wr2' | 'wr3' | 'te' | 'flex' | 'k';
export type Slots = Record<SlotKey, string | null>;

export interface Me {
  id: string;
  email: string;
  handle: string | null;
  /** recruiter: an invite helper, who makes sign-up codes and nothing else admin. */
  role: 'user' | 'admin' | 'recruiter';
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
  /** Season and last-3 stats (PRD-007 §8.7); null until the stats job has run, or for a player with no games. */
  stats?: PlayerStats | null;
}

/** One period: counts are totals, yards and points per game. Rates are null when their denominator is 0. */
export interface StatBlock {
  gamesPlayed: number;
  pts: number;
  ptsTotal?: number;
  rush: { att: number; yds: number; ypc: number | null; tds: number } | null;
  rec: { tgt: number; rec: number; yds: number; ypr: number | null; tds: number } | null;
  pass: { att: number; cmp: number; yds: number; ypa: number | null; tds: number; int: number } | null;
  k: { fgm: number; fga: number; fgPct: number | null; xpm: number; xpa: number; pts: number } | null;
}

export interface PlayerStats {
  season: StatBlock;
  last3: StatBlock;
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

/** One page of the season field board (PRD-007 §8.1). */
export interface FieldBoard {
  season: string;
  /** The week "this week's points" refers to: the latest week with a locked window. */
  week: number;
  version: string;
  fieldSize: number;
  offset: number;
  rows: FieldRow[];
  me: FieldRow | null;
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
  /** The ruleset that scored him (the rules page shows it). */
  rulesVersion?: string | null;
  /** Each stat he recorded with the points it earned; the lines add up to pointsX100. Null until the stats feed has his game. */
  breakdown?: Array<{ stat: string; label: string; value: number; pointsX100: number }> | null;
}

export interface ScoringRules {
  version: string;
  stats: Array<{ stat: string; label: string; group: 'Passing' | 'Rushing' | 'Receiving' | 'Kicking' | 'Other'; centipoints: number }>;
  correctionsWindowHours: number;
}

export interface Notification {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
  read: boolean;
}

/** Text-only player details for the players a notice names (NIL: no images). */
export interface NoticePlayer {
  name: string;
  position: string;
  team: string | null;
}

export interface Notifications {
  unread: number;
  items: Notification[];
  /** Keyed by player id, for every player the returned notices name. */
  players: Record<string, NoticePlayer>;
  /** Opaque cursor for the next (older) page. */
  nextBefore: string | null;
}

/** Another manager's lineup for one week: locked picks only (PRD-007 §8.1, PRD-003 §6). */
export type RevealSlot =
  | { slotKey: SlotKey; state: 'HIDDEN' | 'EMPTY' }
  | { slotKey: SlotKey; state: 'LOCKED'; player: RevealPlayer; windowLabel: string | null; pointsX100: number; burned: boolean }
  | { slotKey: SlotKey; state: 'SUBMITTED'; player: RevealPlayer; windowLabel: string | null }
  | { slotKey: SlotKey; state: 'VOIDED'; player: RevealPlayer };

export interface RevealPlayer {
  playerId: string;
  name: string | null;
  team: string | null;
  position: string | null;
}

export interface Reveal {
  handle: string;
  week: number;
  slots: RevealSlot[];
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
