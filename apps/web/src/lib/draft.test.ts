import { describe, expect, it } from 'vitest';
import type { Lineup, LineupSlot, SlotKey } from '../api/types';
import { changeCount, effectiveSlots, loadDraft, reconcile, saveDraft } from './draft';
import { SLOT_ORDER } from './slots';

function lineup(over: Partial<Record<SlotKey, Partial<LineupSlot>>> = {}): Lineup {
  return {
    season: '2026-2027-regular', week: 8, eligibility: { prizeEligible: false, freePlayThroughWeek: null },
    slots: SLOT_ORDER.map((slot) => ({
      slot, playerId: `${slot}-p`, name: null, team: null, position: null, opponent: null, scheduledEt: null,
      locked: false, voidReason: null, lockedAt: null, ...over[slot],
    })),
  };
}

describe('draft reconciliation (PRD-007 §6.3): the server wins', () => {
  it('drops changes to slots that have since locked', () => {
    const l = lineup({ qb: { locked: true } });
    expect(reconcile({ qb: 'other', rb1: 'new-rb' }, l)).toEqual({ rb1: 'new-rb' });
  });
  it('drops a draft pick the server has since voided, keeps a replacement for a voided slot', () => {
    const l = lineup({ te: { voidReason: 'PLAYER_INACTIVE', locked: true }, k: { voidReason: 'PLAYER_NO_GAME' } });
    expect(reconcile({ te: 'te-p', k: 'k-new' }, l)).toEqual({ k: 'k-new' });
  });
  it('a draft value equal to the server value is no change', () => {
    expect(reconcile({ wr1: 'wr1-p', wr2: null }, lineup())).toEqual({ wr2: null });
  });
  it('the submitted lineup is the server lineup with the draft on top; voided slots count as empty', () => {
    const l = lineup({ te: { voidReason: 'GAME_CANCELED' } });
    const e = effectiveSlots(l, { rb2: 'rb-new' });
    expect(e.rb2).toBe('rb-new');
    expect(e.te).toBeNull();
    expect(e.qb).toBe('qb-p');
    expect(changeCount({ rb2: 'x', te: null })).toBe(2);
  });
  it('persists per user and week, and ignores junk in storage', () => {
    saveDraft('u1', 's', 8, { qb: 'a', rb1: null });
    expect(loadDraft('u1', 's', 8)).toEqual({ qb: 'a', rb1: null });
    expect(loadDraft('u1', 's', 9)).toEqual({});
    expect(loadDraft('u2', 's', 8)).toEqual({});
    window.localStorage.setItem('bl:draft:u1:s:7', '{"qb":42,"nope":"x","rb1":"ok"}');
    expect(loadDraft('u1', 's', 7)).toEqual({ rb1: 'ok' });
    saveDraft('u1', 's', 8, {});
    expect(window.localStorage.getItem('bl:draft:u1:s:8')).toBeNull();
  });
});
