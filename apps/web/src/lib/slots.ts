/**
 * The nine slots and who may fill them (PRD-001 §3; FB counts at RB and
 * FLEX, decision 2026-10-27). The server validates everything again; this
 * only keeps the picker honest.
 */
import type { GameWindow, Lineup, LineupSlot, SlotKey, VoidReason } from '../api/types';

export const SLOT_ORDER: SlotKey[] = ['qb', 'rb1', 'rb2', 'wr1', 'wr2', 'wr3', 'te', 'flex', 'k'];

export const SLOT_LABEL: Record<SlotKey, string> = {
  qb: 'QB', rb1: 'RB1', rb2: 'RB2', wr1: 'WR1', wr2: 'WR2', wr3: 'WR3', te: 'TE', flex: 'FLEX', k: 'K',
};

export const SLOT_POSITIONS: Record<SlotKey, readonly string[]> = {
  qb: ['QB'],
  rb1: ['RB', 'FB'],
  rb2: ['RB', 'FB'],
  wr1: ['WR'],
  wr2: ['WR'],
  wr3: ['WR'],
  te: ['TE'],
  flex: ['RB', 'FB', 'WR', 'TE'],
  k: ['K'],
};

export const isSlotKey = (s: string | undefined): s is SlotKey => !!s && (SLOT_ORDER as string[]).includes(s);

export function slotAccepts(slot: SlotKey, position: string): boolean {
  return SLOT_POSITIONS[slot].includes(position);
}

/** "RB or FB", "RB, FB, WR or TE" */
export function positionsText(slot: SlotKey): string {
  const p = SLOT_POSITIONS[slot];
  return p.length === 1 ? p[0] : `${p.slice(0, -1).join(', ')} or ${p.at(-1)}`;
}

export const VOID_TEXT: Record<VoidReason, string> = {
  PLAYER_INACTIVE: 'Out before his lock. Not burned.',
  PLAYER_NO_GAME: 'No game this week. Not burned.',
  GAME_CANCELED: 'Game canceled. Not burned.',
  ADMIN_VOID: 'Voided by Burnout League. Not burned.',
  PLAYER_MERGED: 'Same player as another of your picks this week. Not burned.',
};

/** How a slot shows (PRD-007 §6.3). */
export type SlotState = 'EMPTY' | 'PICKED' | 'LOCKED' | 'BURNED' | 'VOIDED';

export function slotState(s: LineupSlot, windows: GameWindow[]): SlotState {
  if (!s.playerId) return 'EMPTY';
  if (s.voidReason) return 'VOIDED';
  if (s.locked) {
    const w = windowFor(s.scheduledEt, windows);
    return s.lockedAt && w?.status === 'final' ? 'BURNED' : 'LOCKED';
  }
  return 'PICKED';
}

/** One window per exact kickoff (PRD-006 §11.6), so the kickoff time identifies it. */
export function windowFor(scheduledEt: string | null, windows: GameWindow[]): GameWindow | undefined {
  if (!scheduledEt) return undefined;
  const t = Date.parse(scheduledEt);
  return windows.find((w) => Date.parse(w.scheduledEt) === t);
}

/** True while some window this week can still be changed. */
export function anyWindowOpen(windows: GameWindow[], now: number): boolean {
  return windows.some((w) => w.status === 'pending' && Date.parse(w.scheduledEt) > now);
}

/** Slots the user may still change: not frozen by a lock (voided slots reopen). */
export function editable(s: LineupSlot): boolean {
  return !s.locked || s.voidReason !== null;
}

export function lineupMap(l: Lineup): Map<SlotKey, LineupSlot> {
  return new Map(l.slots.map((s) => [s.slot, s]));
}
