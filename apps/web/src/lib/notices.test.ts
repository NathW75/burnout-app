import { describe, expect, it } from 'vitest';
import type { Notification } from '../api/types';
import { nameList, noticeView, type NoticeContext } from './notices';

const ctx: NoticeContext = {
  players: { wrKC: { name: 'Wes Kay', position: 'WR', team: 'KC' }, rbDEN: { name: 'Ray Dent', position: 'RB', team: 'DEN' } },
  currentWeek: 8,
  myHandle: 'nath',
};
const n = (kind: string, payload: Record<string, unknown>): Notification => ({ id: 'x', kind, payload, createdAt: '2026-10-30T00:16:00Z', read: false });

describe('inbox notices (PRD-007 §6.6)', () => {
  it('names the players a lock or burn is about, and links each to its screen', () => {
    const burn = noticeView(n('BURN', { week: 8, players: [{ playerId: 'wrKC' }, { playerId: 'rbDEN' }] }), ctx);
    expect(burn).toMatchObject({ tag: 'BURNED', text: 'Wes Kay and Ray Dent are burned: their games went Final.', to: '/burned', week: 8 });
    const one = noticeView(n('BURN', { week: 8, players: [{ playerId: 'wrKC' }] }), ctx);
    expect(one.text).toBe('Wes Kay is burned: his game went Final.');
    const lock = noticeView(n('LOCK', { week: 8, windowLabel: 'Thursday Night · 8:15 PM', players: [{ playerId: 'wrKC' }] }), ctx);
    expect(lock).toMatchObject({ tag: 'LOCKED', text: 'Thursday Night · 8:15 PM locked with Wes Kay.', to: '/' });
  });

  it('falls back to a count when a name is missing, never a raw id', () => {
    const v = noticeView(n('BURN', { week: 8, players: [{ playerId: 'wrKC' }, { playerId: 'zzz' }] }), ctx);
    expect(v.text).toBe('2 players burned: their games went Final.');
    expect(v.text).not.toContain('zzz');
  });

  it('a notice about an older week opens that week’s lineup; this week’s goes to This Week or the builder', () => {
    expect(noticeView(n('LOCK', { week: 7, players: [] }), ctx).to).toBe('/board/nath?week=7');
    expect(noticeView(n('SUBMISSION_VOIDED', { week: 8, slot: 'rb1', playerId: 'rbDEN', reason: 'PLAYER_INACTIVE', injuryStatus: 'Out' }), ctx)).toMatchObject({
      text: 'Ray Dent was voided: listed Out before his lock. Not burned. RB1 is open.',
      to: '/lineup',
    });
    expect(noticeView(n('SUBMISSION_VOIDED', { week: 6, slot: 'qb', playerName: 'Quinn Kay', reason: 'PLAYER_NO_GAME' }), ctx).to).toBe('/board/nath?week=6');
    expect(noticeView(n('LOCK', { week: 7, players: [] }), { ...ctx, myHandle: null }).to).toBeNull();
  });

  it('receipts link to the receipt; unknown kinds still read sensibly', () => {
    expect(noticeView(n('LINEUP_RECEIPT', { week: 8, receiptId: 'r1' }), ctx)).toMatchObject({ text: 'Week 8 lineup confirmed.', to: '/receipts/r1' });
    expect(noticeView(n('SOMETHING_NEW', {}), ctx)).toMatchObject({ tag: 'SOMETHING NEW', text: 'New notice.', to: null });
    expect(noticeView(n('SCORE_CORRECTION', { week: 5 }), ctx).text).toBe('A stat correction changed your Week 5 points.');
  });

  it('lists names in plain English', () => {
    expect(nameList(['A'])).toBe('A');
    expect(nameList(['A', 'B', 'C'])).toBe('A, B and C');
    expect(nameList(['A', 'B', 'C', 'D', 'E'])).toBe('A, B and 3 more');
  });
});
