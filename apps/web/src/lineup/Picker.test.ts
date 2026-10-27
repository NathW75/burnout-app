import { describe, expect, it } from 'vitest';
import type { PlayerCard } from '../api/types';
import { unavailable } from './Picker';

const card = (o: Partial<PlayerCard>): PlayerCard => ({
  playerId: 'p', name: 'Rex Mia', team: 'MIA', position: 'RB', opponent: 'BUF', homeAway: 'home', scheduledEt: '2026-11-01T18:00:00Z',
  bye: false, windowOpen: true, injuryStatus: 'Active', burnState: 'available', selectable: true, unavailableReason: null, ...o,
});

describe('picker: greyed with the reason (PRD-007 §6.3)', () => {
  it('Out/IR, bye, locked, burned and already-used players say why', () => {
    expect(unavailable(card({}), undefined)).toBeNull();
    expect(unavailable(card({ unavailableReason: 'INACTIVE', injuryStatus: 'Out' }), undefined)).toEqual({ tag: 'OUT', text: 'Out: not selectable, not burned' });
    expect(unavailable(card({ unavailableReason: 'INACTIVE', injuryStatus: 'IR' }), undefined)?.text).toBe('IR: not selectable, not burned');
    expect(unavailable(card({ unavailableReason: 'BYE', opponent: null }), undefined)).toEqual({ tag: 'BYE WEEK', text: 'No game this week' });
    expect(unavailable(card({ unavailableReason: 'WINDOW_CLOSED' }), undefined)).toEqual({ tag: 'LOCKED', text: 'vs BUF · window has locked' });
    expect(unavailable(card({ unavailableReason: 'BURNED' }), undefined)?.tag).toBe('BURNED');
    expect(unavailable(card({}), 'wr1')).toEqual({ tag: 'WR1', text: 'Already in your lineup at WR1' });
  });
});
