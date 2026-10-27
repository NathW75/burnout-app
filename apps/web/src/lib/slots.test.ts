import { describe, expect, it } from 'vitest';
import type { GameWindow, LineupSlot } from '../api/types';
import { editable, positionsText, slotAccepts, slotState, SLOT_ORDER } from './slots';

const win = (id: string, at: string, status: GameWindow['status']): GameWindow => ({ id, label: id, scheduledEt: at, status, games: [] });
const slot = (o: Partial<LineupSlot>): LineupSlot => ({
  slot: 'rb1', playerId: 'p1', name: 'Ray Dent', team: 'DEN', position: 'RB', opponent: 'KC', scheduledEt: '2026-10-30T00:15:00.000Z',
  locked: false, voidReason: null, lockedAt: null, ...o,
});

describe('slot eligibility (PRD-001 §3; FB at RB and FLEX)', () => {
  it('FB plays RB1, RB2 and FLEX only', () => {
    const fbSlots = SLOT_ORDER.filter((s) => slotAccepts(s, 'FB'));
    expect(fbSlots).toEqual(['rb1', 'rb2', 'flex']);
    expect(slotAccepts('flex', 'K')).toBe(false);
    expect(slotAccepts('flex', 'QB')).toBe(false);
    expect(SLOT_ORDER.filter((s) => slotAccepts(s, 'WR'))).toEqual(['wr1', 'wr2', 'wr3', 'flex']);
    expect(positionsText('flex')).toBe('RB, FB, WR or TE');
    expect(positionsText('rb1')).toBe('RB or FB');
  });
});

describe('slot states (PRD-007 §6.3)', () => {
  const windows = [win('w1', '2026-10-30T00:15:00.000Z', 'final'), win('w2', '2026-11-01T18:00:00.000Z', 'locked')];
  it('maps the server lineup to the five states', () => {
    expect(slotState(slot({ playerId: null }), windows)).toBe('EMPTY');
    expect(slotState(slot({}), windows)).toBe('PICKED');
    expect(slotState(slot({ locked: true, lockedAt: '2026-10-30T00:15:20Z' }), windows)).toBe('BURNED');
    expect(slotState(slot({ locked: true, lockedAt: '2026-11-01T18:00:20Z', scheduledEt: '2026-11-01T18:00:00.000Z' }), windows)).toBe('LOCKED');
    // Frozen by scheduled_et before the lock job ran: locked, not burned.
    expect(slotState(slot({ locked: true, lockedAt: null }), windows)).toBe('LOCKED');
    expect(slotState(slot({ voidReason: 'PLAYER_INACTIVE' }), windows)).toBe('VOIDED');
  });
  it('voided slots are editable again; locked ones are not', () => {
    expect(editable(slot({ locked: true }))).toBe(false);
    expect(editable(slot({ locked: true, voidReason: 'GAME_CANCELED' }))).toBe(true);
    expect(editable(slot({}))).toBe(true);
  });
});
