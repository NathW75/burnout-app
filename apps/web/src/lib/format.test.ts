import { describe, expect, it } from 'vitest';
import { clockET, countdown, dateLineET, dayTimeET, points, shortName, timeET } from './format';

describe('Eastern Time, labeled (PRD-007 §5.2)', () => {
  it('formats in America/New_York whatever the device zone', () => {
    const kickoff = '2026-11-01T18:00:00Z'; // 1:00 PM EST (after the Nov 1 change)
    expect(timeET(kickoff)).toBe('1:00 PM');
    expect(dayTimeET(kickoff)).toBe('Sun 1:00 PM');
    expect(timeET('2026-10-30T00:15:00Z')).toBe('8:15 PM'); // Thursday night, still EDT
    expect(clockET('2026-11-01T16:42:07Z')).toBe('11:42:07 AM ET');
    expect(dateLineET('2026-11-01T16:00:00Z')).toBe('SUN · NOV 1');
  });

  it('countdowns: H:MM:SS under a day, the weekday beyond, never negative', () => {
    const at = '2026-11-02T01:15:00Z';
    expect(countdown(1 * 3600_000 + 17 * 60_000 + 53_000, at)).toBe('1:17:53');
    expect(countdown(5 * 60_000 + 9_000, at)).toBe('5:09');
    expect(countdown(-5_000, at)).toBe('0:00');
    expect(countdown(30 * 3600_000, at)).toBe('SUN');
  });

  it('points and names', () => {
    expect(points(1840)).toBe('18.4');
    expect(points(0)).toBe('0.0');
    expect(shortName('Cole Ellery')).toBe('C. Ellery');
    expect(shortName('Amon-Ra St. Brown')).toBe('A. St. Brown');
    expect(shortName(null)).toBe('');
  });
});
