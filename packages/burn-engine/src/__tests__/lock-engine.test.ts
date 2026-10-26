/**
 * Unit tests: lock engine orchestration (PRD-001 §4). Database behavior is
 * covered by acceptance.test.ts against real Postgres.
 */
import { evaluateAndFireLocks, type LockEngineDependencies } from '../lock-engine';
import type { GameWindow } from '../types';

const T0 = new Date('2026-11-01T18:00:00.000Z'); // Sun 1:00 PM ET

function win(id: string, scheduledEt: Date): GameWindow {
  return { id, week: 9, season: '2026-2027-regular', label: 'Sunday Early', scheduledEt, status: 'pending', msfGameIds: ['g1'] };
}

function deps(over: Partial<LockEngineDependencies> = {}): LockEngineDependencies & { logs: unknown[][] } {
  const logs: unknown[][] = [];
  return {
    logs,
    getServerTime: () => T0,
    getPendingWindowsToLock: async () => [],
    commitLock: async () => ({ claimed: true, submissionsLocked: 0, notificationsQueued: 0 }),
    log: (...a) => logs.push(a),
    ...over,
  };
}

describe('lock engine (unit)', () => {
  it('reads the server clock once and passes that instant to the query and every commit', async () => {
    const getServerTime = jest.fn(() => T0);
    const getPending = jest.fn(async () => [win('a', T0), win('b', new Date(T0.getTime() - 60_000))]);
    const commitLock = jest.fn(async () => ({ claimed: true as const, submissionsLocked: 2, notificationsQueued: 2 }));
    const res = await evaluateAndFireLocks(deps({ getServerTime, getPendingWindowsToLock: getPending, commitLock }));
    expect(getServerTime).toHaveBeenCalledTimes(1);
    expect(getPending).toHaveBeenCalledWith(T0);
    expect(commitLock.mock.calls).toEqual([['a', T0], ['b', T0]]);
    expect(res.map((r) => r.firedAt)).toEqual([T0, T0]);
  });

  it('never locks a window whose scheduled_et is in the future, even if the query returns it', async () => {
    const commitLock = jest.fn();
    const d = deps({
      getPendingWindowsToLock: async () => [win('future', new Date(T0.getTime() + 1))],
      commitLock,
    });
    expect(await evaluateAndFireLocks(d)).toEqual([]);
    expect(commitLock).not.toHaveBeenCalled();
    expect(d.logs.some((l) => l[0] === 'warn')).toBe(true);
  });

  it('locks at exactly scheduled_et (boundary is inclusive)', async () => {
    const commitLock = jest.fn(async () => ({ claimed: true as const, submissionsLocked: 1, notificationsQueued: 1 }));
    const res = await evaluateAndFireLocks(deps({ getPendingWindowsToLock: async () => [win('w', T0)], commitLock }));
    expect(res).toHaveLength(1);
  });

  it('reports nothing for a window another worker already claimed', async () => {
    const res = await evaluateAndFireLocks(
      deps({ getPendingWindowsToLock: async () => [win('w', T0)], commitLock: async () => ({ claimed: false }) })
    );
    expect(res).toEqual([]);
  });

  it('a failed commit on one window does not block the others', async () => {
    const commitLock = jest.fn(async (id: string) => {
      if (id === 'bad') throw new Error('boom');
      return { claimed: true as const, submissionsLocked: 3, notificationsQueued: 3 };
    });
    const d = deps({ getPendingWindowsToLock: async () => [win('bad', T0), win('good', T0)], commitLock });
    const res = await evaluateAndFireLocks(d);
    expect(res.map((r) => r.gameWindowId)).toEqual(['good']);
    expect(d.logs.some((l) => l[0] === 'error')).toBe(true);
  });
});
