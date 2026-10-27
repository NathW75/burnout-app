/**
 * PRD-006 pure units: TOTP (RFC 6238 vectors, AC4), crypto, players parser (AC11), schedule (§11).
 */
import { createHash, randomBytes } from 'node:crypto';
import { base32Decode, base32Encode, SecretBox } from '../auth/crypto';
import { hotp, newTotpSecret, otpauthUrl, totp, verifyTotp } from '../auth/totp';
import { dueJobs } from '../jobs';
import { injuryFrom, parsePlayers } from '../players/msf-players';
import { lineupChecksum } from '../lineups/service';

describe('AC4: TOTP matches RFC 6238 Appendix B (SHA-1)', () => {
  const key = Buffer.from('12345678901234567890', 'ascii');
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('T=%i → %s', (t, expected) => {
    expect(hotp(key, BigInt(Math.floor(t / 30)), 8)).toBe(expected);
  });

  it('RFC 4226 Appendix D HOTP values', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => hotp(key, BigInt(c), 6))).toEqual([
      '755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489',
    ]);
  });

  it('verifies within ±1 step, returns the matched step, rejects outside the window and malformed codes', () => {
    const secret = newTotpSecret();
    const at = new Date('2026-10-28T12:00:10Z');
    const code = totp(secret, at);
    const step = BigInt(Math.floor(at.getTime() / 30_000));
    expect(verifyTotp(secret, code, at)).toBe(step);
    expect(verifyTotp(secret, code, new Date(at.getTime() + 30_000))).toBe(step);
    expect(verifyTotp(secret, code, new Date(at.getTime() - 30_000))).toBe(step);
    expect(verifyTotp(secret, code, new Date(at.getTime() + 90_000))).toBeNull();
    expect(verifyTotp(secret, '12345', at)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', at)).toBeNull();
  });

  it('otpauth URL carries issuer, algorithm, digits and period', () => {
    const url = otpauthUrl('JBSWY3DPEHPK3PXP', 'nath@example.com');
    expect(url).toMatch(/^otpauth:\/\/totp\/Burnout%20League%3Anath%40example\.com\?/);
    expect(url).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(url).toContain('algorithm=SHA1');
    expect(url).toContain('period=30');
  });
});

describe('crypto', () => {
  it('base32 round-trips and matches the RFC 4648 vector', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    for (let i = 0; i < 50; i++) {
      const b = randomBytes(i);
      expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
    }
  });

  it('SecretBox seals with AES-256-GCM: no plaintext in the output, tampering is detected', () => {
    const box = new SecretBox(randomBytes(32).toString('base64'));
    const sealed = box.seal('JBSWY3DPEHPK3PXP');
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(box.open(sealed)).toBe('JBSWY3DPEHPK3PXP');
    expect(box.seal('x')).not.toBe(box.seal('x')); // random IV
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => box.open(parts.join('.'))).toThrow();
    expect(() => new SecretBox(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('AC11: players parser keeps text only', () => {
  const feed = {
    lastUpdatedOn: '2026-10-28T08:00:00.000Z',
    players: [
      { player: { id: 1, firstName: 'Ann', lastName: 'Arbor', primaryPosition: 'QB', currentTeam: { id: 1, abbreviation: 'KC' }, currentRosterStatus: 'ROSTER',
          currentInjury: null, officialImageSrc: 'https://static.example/headshot.png', socialMediaAccounts: [{ value: '@ann' }], height: "6'2\"" } },
      { player: { id: 2, firstName: 'Bo', lastName: 'Bell', primaryPosition: 'RB', currentTeam: null, currentRosterStatus: 'UNSIGNED', currentInjury: { playingProbability: 'OUT' } } },
      { player: { id: 3, firstName: 'Cy', lastName: 'Cole', primaryPosition: 'LB', currentTeam: { abbreviation: 'KC' } } },
      { player: { id: 4, firstName: 'Di', lastName: 'Dunn', primaryPosition: 'FB', currentTeam: { abbreviation: 'SF' }, currentRosterStatus: 'INJURED_RESERVE' } },
    ],
  };

  it('keeps fantasy positions, drops everything but id/name/position/team/status', () => {
    const { players, lastUpdatedOn } = parsePlayers(feed);
    expect(lastUpdatedOn?.toISOString()).toBe('2026-10-28T08:00:00.000Z');
    expect(players.map((p) => p.msfPlayerId)).toEqual(['1', '2', '4']);
    expect(players[0]).toEqual({ msfPlayerId: '1', firstName: 'Ann', lastName: 'Arbor', position: 'QB', team: 'KC', rosterStatus: 'ROSTER', injuryStatus: 'Active' });
    expect(JSON.stringify(players)).not.toMatch(/http|image|headshot|social|@ann/i);
    expect(players[1]).toMatchObject({ team: null, injuryStatus: 'Out' });
    expect(players[2]).toMatchObject({ injuryStatus: 'IR' });
  });

  it('maps injury designations', () => {
    expect(injuryFrom('ROSTER', 'QUESTIONABLE')).toBe('Questionable');
    expect(injuryFrom('ROSTER', 'DOUBTFUL')).toBe('Doubtful');
    expect(injuryFrom('ROSTER', 'PROBABLE')).toBe('Active');
    expect(injuryFrom('PUP', null)).toBe('PUP');
  });

  it('rejects a malformed feed', () => {
    expect(() => parsePlayers({})).toThrow(/players is not an array/);
    expect(() => parsePlayers({ players: [{ nope: 1 }] })).toThrow(/player is not an object/);
  });
});

describe('§11: job schedule (Eastern Time)', () => {
  it('locks and payments every minute; scoring every 15 min in active weeks, hourly otherwise', () => {
    expect(dueJobs(new Date('2026-11-01T17:07:00Z'), { windowsActive: true })).toEqual(['locks', 'payments']);
    expect(dueJobs(new Date('2026-11-01T17:15:00Z'), { windowsActive: true })).toEqual(['locks', 'payments', 'scoring']);
    expect(dueJobs(new Date('2026-11-04T17:15:00Z'), { windowsActive: false })).toEqual(['locks', 'payments']);
    expect(dueJobs(new Date('2026-11-04T17:00:00Z'), { windowsActive: false })).toEqual(['locks', 'payments', 'scoring']);
  });

  it('roster sync at 3:00 AM ET nightly and Tuesday 11:59 PM ET (DST-aware)', () => {
    expect(dueJobs(new Date('2026-10-28T07:00:00Z'), { windowsActive: false })).toContain('roster'); // 03:00 EDT
    expect(dueJobs(new Date('2026-11-11T08:00:00Z'), { windowsActive: false })).toContain('roster'); // 03:00 EST
    expect(dueJobs(new Date('2026-11-04T04:59:00Z'), { windowsActive: false })).toContain('roster'); // Tue 23:59 EST
    expect(dueJobs(new Date('2026-11-05T04:59:00Z'), { windowsActive: false })).not.toContain('roster'); // Wed 23:59
  });
});

describe('§9.4: lineup checksum', () => {
  it('is SHA-256 over the canonical JSON, independent of input slot order', () => {
    const base = { userId: 'u', season: 's', week: 8, gate3At: new Date('2026-10-28T12:00:00Z') };
    const slots = ['qb', 'rb1', 'rb2', 'wr1', 'wr2', 'wr3', 'te', 'flex', 'k'].map((slot, i) => ({ slot: slot as never, playerId: `p${i}`, gameWindowId: `w${i}`, locked: i === 0 }));
    const a = lineupChecksum({ ...base, slots });
    const b = lineupChecksum({ ...base, slots: [...slots].reverse() });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(lineupChecksum({ ...base, slots: slots.map((s, i) => (i === 3 ? { ...s, playerId: 'other' } : s)) })).not.toBe(a);
  });

  it('matches the documented canonical form exactly (golden vector, so users can recompute it)', () => {
    const order = ['qb', 'rb1', 'rb2', 'wr1', 'wr2', 'wr3', 'te', 'flex', 'k'];
    const slots = order.map((slot, i) => ({ slot: slot as never, playerId: i === 8 ? null : `p${i}`, gameWindowId: i === 8 ? null : `w${i}`, locked: i < 2 }));
    const canonical =
      '{"userId":"u-1","season":"2026-2027-regular","week":8,"gate3At":"2026-10-28T12:00:00.000Z","slots":[' +
      order.map((slot, i) => `{"slot":"${slot}","playerId":${i === 8 ? 'null' : `"p${i}"`},"gameWindowId":${i === 8 ? 'null' : `"w${i}"`},"locked":${i < 2}}`).join(',') +
      ']}';
    const expected = createHash('sha256').update(canonical).digest('hex');
    expect(lineupChecksum({ userId: 'u-1', season: '2026-2027-regular', week: 8, gate3At: new Date('2026-10-28T12:00:00Z'), slots })).toBe(expected);
  });
});
