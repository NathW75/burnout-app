/**
 * Unit tests: burn evaluator gating (PRD-001 §5). Database behavior is
 * covered by acceptance.test.ts against real Postgres.
 */
import { evaluateAndCommitBurns, type BurnEvaluatorDependencies } from '../burn-evaluator';
import type { GameWindow, GameWindowStatus } from '../types';

const NOW = new Date('2026-11-01T21:15:00.000Z');

function win(status: GameWindowStatus, msfGameIds = ['g1', 'g2']): GameWindow {
  return { id: 'w1', week: 9, season: '2026-2027-regular', label: 'Sunday Early', scheduledEt: new Date('2026-11-01T18:00:00Z'), status, msfGameIds };
}

function deps(window: GameWindow | null) {
  const commitBurns = jest.fn(async () => ({ claimed: true as const, burnsCreated: 4, usersAffected: ['u1', 'u2'], duplicatesSkipped: 0 }));
  const d: BurnEvaluatorDependencies = {
    getServerTime: () => NOW,
    getGameWindow: async () => window,
    commitBurns,
    log: () => {},
  };
  return { d, commitBurns };
}

describe('burn evaluator (unit)', () => {
  it('burns when the window is locked and every game in it is Final', async () => {
    const { d, commitBurns } = deps(win('locked'));
    const res = await evaluateAndCommitBurns({ gameWindowId: 'w1', finalMsfGameIds: ['g2', 'g1'] }, d);
    expect(res).toMatchObject({ outcome: 'burned', burnsCreated: 4, usersAffected: ['u1', 'u2'] });
    expect(commitBurns).toHaveBeenCalledWith('w1', NOW);
  });

  it('does not burn while any game in the window is not Final (first game Final must not burn the whole window)', async () => {
    const { d, commitBurns } = deps(win('locked'));
    const res = await evaluateAndCommitBurns({ gameWindowId: 'w1', finalMsfGameIds: ['g1'] }, d);
    expect(res).toMatchObject({ outcome: 'awaiting_final', burnsCreated: 0, pendingMsfGameIds: ['g2'] });
    expect(commitBurns).not.toHaveBeenCalled();
  });

  it.each<GameWindowStatus>(['pending', 'canceled', 'postponed'])(
    'refuses to burn a %s window (no lock, no burn)',
    async (status) => {
      const { d, commitBurns } = deps(win(status));
      const res = await evaluateAndCommitBurns({ gameWindowId: 'w1', finalMsfGameIds: ['g1', 'g2'] }, d);
      expect(res.outcome).toBe('rejected');
      expect(commitBurns).not.toHaveBeenCalled();
    }
  );

  it('is idempotent once the window is final', async () => {
    const { d, commitBurns } = deps(win('final'));
    const res = await evaluateAndCommitBurns({ gameWindowId: 'w1', finalMsfGameIds: ['g1', 'g2'] }, d);
    expect(res.outcome).toBe('already_final');
    expect(commitBurns).not.toHaveBeenCalled();
  });

  it('refuses a window with no MSF games mapped (cannot prove Final)', async () => {
    const { d, commitBurns } = deps(win('locked', []));
    const res = await evaluateAndCommitBurns({ gameWindowId: 'w1', finalMsfGameIds: [] }, d);
    expect(res.outcome).toBe('rejected');
    expect(commitBurns).not.toHaveBeenCalled();
  });

  it('refuses an unknown window', async () => {
    const { d } = deps(null);
    const res = await evaluateAndCommitBurns({ gameWindowId: 'nope', finalMsfGameIds: ['g1'] }, d);
    expect(res.outcome).toBe('rejected');
  });

  it('reports already_final when another worker claimed the window first', async () => {
    const { d } = deps(win('locked'));
    d.commitBurns = async () => ({ claimed: false });
    const res = await evaluateAndCommitBurns({ gameWindowId: 'w1', finalMsfGameIds: ['g1', 'g2'] }, d);
    expect(res.outcome).toBe('already_final');
  });
});
