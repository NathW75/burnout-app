import { describe, expect, it } from 'vitest';
import { bestOffset, offsetFrom, ServerClock } from './clock';

describe('official clock (PRD-007 §5.3)', () => {
  it('measures the offset against the midpoint of the request', () => {
    expect(offsetFrom({ sentAt: 1_000, receivedAt: 1_400, serverTime: 5_200 })).toBe(4_000);
  });

  it('keeps the tightest round trip of several samples', () => {
    expect(bestOffset([
      { sentAt: 0, receivedAt: 2_000, serverTime: 10_000 },
      { sentAt: 100, receivedAt: 300, serverTime: 10_200 },
    ])).toBe(10_000);
    expect(bestOffset([])).toBeNull();
  });

  it('AC: tracks server time within 1 second even with the device clock wrong by an hour', async () => {
    let device = Date.parse('2026-11-01T17:00:00Z') - 3600_000; // an hour slow
    const clock = new ServerClock(() => device);
    const server = () => device + 3600_000;
    await clock.sync(async () => {
      device += 150; // 300 ms round trip, server answers halfway
      const t = new Date(server()).toISOString();
      device += 150;
      return t;
    });
    expect(clock.isSynced).toBe(true);
    expect(Math.abs(clock.now() - server())).toBeLessThan(1000);
    device += 60_000;
    expect(Math.abs(clock.now() - server())).toBeLessThan(1000);
  });

  it('a failed sync keeps the last offset and notifies only on success', async () => {
    const clock = new ServerClock(() => 0);
    let calls = 0;
    clock.subscribe(() => calls++);
    await clock.sync(async () => { throw new Error('offline'); });
    expect(clock.isSynced).toBe(false);
    expect(calls).toBe(0);
    await clock.sync(async () => new Date(5_000).toISOString(), 1);
    expect(clock.offset).toBe(5_000);
    expect(calls).toBe(1);
  });
});
