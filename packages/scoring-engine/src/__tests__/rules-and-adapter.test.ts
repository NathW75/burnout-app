/**
 * PRD-002 AC1 (rule parity) and AC2 (exact arithmetic), plus the MSF adapter
 * against real 2026-27 Week 7 feed data. Expected values are hand-computed
 * from the §3 rule table, not produced by the code under test.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyStatLine, formatPoints, scoreStatLine, type StatLine, YAHOO_HALF_PPR_V1 } from '../rules';
import { MsfFeedError, parseGamelogs, parseGames } from '../msf';

const line = (over: Partial<StatLine>): StatLine => ({ ...emptyStatLine(), ...over });
const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));

describe('AC1: Yahoo half-PPR rules (PRD-002 §11 worked examples)', () => {
  it.each<[string, Partial<StatLine>, number]>([
    ['QB: 287 pass yds, 2 TD, 1 INT, 18 rush yds, 1 fumble lost', { passYds: 287, passTd: 2, passInt: 1, rushYds: 18, fumblesLost: 1 }, 1828],
    ['RB: -3 rush yds, 5 rec, 41 rec yds, 1 rec TD', { rushYds: -3, receptions: 5, recYds: 41, recTd: 1 }, 1230],
    ['K: FGs of 38, 44, 52, 1 miss, 3 XP', { fgMade0to39: 1, fgMade40to49: 1, fgMade50Plus: 1, fgMissed: 1, xpMade: 3 }, 1500],
    ['WR active, no stats', {}, 0],
    ['return TD (synthetic: none in Week 7)', { returnTd: 1 }, 600],
    ['offensive fumble recovery TD (synthetic)', { fumbleRecTd: 1 }, 600],
    ['missed XP scores 0', { xpMissed: 2 }, 0],
  ])('%s', (_label, stats, expected) => {
    expect(scoreStatLine(line(stats))).toBe(expected);
  });

  it('is fractional, not floored, and negative yardage is negative points', () => {
    expect(formatPoints(scoreStatLine(line({ passYds: 287 })))).toBe('11.48');
    expect(formatPoints(scoreStatLine(line({ rushYds: -3 })))).toBe('-0.30');
    expect(formatPoints(scoreStatLine(line({ passYds: 1 })))).toBe('0.04');
  });

  it('ruleset is the locked Yahoo default and is frozen', () => {
    expect(YAHOO_HALF_PPR_V1.version).toBe('yahoo-half-ppr-v1');
    expect(Object.isFrozen(YAHOO_HALF_PPR_V1.centipointsPer)).toBe(true);
  });
});

describe('AC2: exact integer arithmetic', () => {
  it('rejects fractional stats instead of producing fractional centipoints', () => {
    expect(() => scoreStatLine(line({ recYds: 10.5 }))).toThrow(TypeError);
  });

  it('a week of 0.04-point increments sums exactly (no float drift)', () => {
    const slots = Array.from({ length: 9 }, (_, i) => scoreStatLine(line({ passYds: 1 + i * 7 })));
    const total = slots.reduce((a, b) => a + b, 0);
    expect(Number.isInteger(total)).toBe(true);
    expect(total).toBe(slots.map(formatPoints).reduce((a, s) => a + Math.round(parseFloat(s) * 100), 0));
  });
});

describe('MSF adapter: real 2026-27 Week 7 feeds', () => {
  const parsed = parseGamelogs(fixture('msf-2026-w7-gamelogs.sample.json'));
  const byId = new Map(parsed.lines.map((l) => [l.playerId, l]));
  const pts = (id: string) => formatPoints(scoreStatLine(byId.get(id)!.stats));

  // Hand-computed from the real stat lines. Spot-check these against Yahoo's
  // Week 7 default-scoring totals (PRD-002 AC1 parity check).
  it.each([
    ['19276', 'Geno Smith QB NYJ: 287 pass yds, 3 TD, 1 INT, 2-pt pass', '24.48'],
    ['79740', 'C.J. Stroud QB HOU: 153 pass yds, 2 TD, 4 rush yds, 2-pt pass', '16.52'],
    ['166711', 'Mason Taylor TE NYJ: 5 rec, 62 yds, 2 TD, 2-pt catch', '22.70'],
    ['133958', 'Cade Stover TE HOU: 1 rec, -1 yd, 2-pt catch', '2.40'],
    ['207994', 'Kaelon Black RB SF: 63 rush yds, TD, 1 rec -4 yds, fumble lost', '10.40'],
    ['39438', 'Brock Purdy QB SF: 288 pass yds, 1 TD, 2 INT, 5 rush yds', '14.02'],
    ['134039', 'Will Reichard K MIN: FG 20-29, 40-49, 50+, 1 miss, 1 XP', '13.00'],
    ['12796', 'Harrison Butker K KC: one 50+, two misses', '5.00'],
    ['16099', 'Andrew Beck FB NYJ: -1 rush yd', '-0.10'],
    ['112073', 'Nate Adkins TE DEN: active, no stats', '0.00'],
  ])('player %s — %s = %s', (id, _label, expected) => {
    expect(pts(id)).toBe(expected);
  });

  it('credits two-point conversions to both passer and receiver', () => {
    expect(byId.get('19276')!.stats.twoPt).toBe(1); // Smith threw it
    expect(byId.get('166711')!.stats.twoPt).toBe(1); // Taylor caught it
  });

  it('maps MSF field goal buckets onto Yahoo tiers and derives misses', () => {
    expect(byId.get('134039')!.stats).toMatchObject({ fgMade0to39: 1, fgMade40to49: 1, fgMade50Plus: 1, fgMissed: 1, xpMade: 1, xpMissed: 0 });
  });

  it('keeps only scored positions and carries game and week', () => {
    expect(parsed.lines.every((l) => l.week === 7)).toBe(true);
    expect(byId.get('19276')!.msfGameId).toBe('163648');
  });

  it('passes no image, logo or biographical data through (NIL)', () => {
    const out = JSON.stringify(parsed);
    for (const banned of ['Image', 'Logo', 'birth', 'firstName', 'lastName']) expect(out).not.toContain(banned);
  });

  it('rejects a feed whose two-point parts disagree with the total', () => {
    const bad = fixture('msf-2026-w7-gamelogs.sample.json');
    const smith = bad.gamelogs.find((g: { player: { id: number } }) => g.player.id === 19276);
    smith.stats.twoPointAttempts.twoPtMade = 2;
    expect(() => parseGamelogs(bad)).toThrow(MsfFeedError);
  });

  it('rejects non-integer stat values', () => {
    const bad = fixture('msf-2026-w7-gamelogs.sample.json');
    bad.gamelogs[0].stats.passing = { ...(bad.gamelogs[0].stats.passing ?? {}), passYards: 12.5 };
    bad.gamelogs[0].player.position = 'QB';
    expect(() => parseGamelogs(bad)).toThrow(MsfFeedError);
  });

  it('maps return TDs and OFFENSIVE fumble TDs; the defensive fumTD is ignored', () => {
    const f = fixture('msf-2026-w7-gamelogs.sample.json');
    const adkins = f.gamelogs.find((g: { player: { id: number } }) => g.player.id === 112073);
    adkins.stats.kickoffReturns = { krTD: 1 };
    adkins.stats.puntReturns = { prTD: 1 };
    adkins.stats.fumbles = { fumTD: 1, offFumTD: 0 };
    let stats = parseGamelogs(f).lines.find((l) => l.playerId === '112073')!.stats;
    expect(stats).toMatchObject({ returnTd: 2, fumbleRecTd: 0 });
    adkins.stats.fumbles = { fumTD: 0, offFumTD: 1 };
    stats = parseGamelogs(f).lines.find((l) => l.playerId === '112073')!.stats;
    expect(stats.fumbleRecTd).toBe(1);
  });

  it('parses the schedule: 13 games Final, MNF not yet played', () => {
    const { games } = parseGames(fixture('msf-2026-w7-games.json'));
    expect(games).toHaveLength(14);
    expect(games.filter((g) => g.isFinal)).toHaveLength(13);
    const mnf = games.find((g) => g.msfGameId === '163654')!;
    expect(mnf).toMatchObject({ playedStatus: 'UNPLAYED', isFinal: false });
    expect(mnf.scheduledStart.toISOString()).toBe('2026-10-27T00:15:00.000Z'); // Mon 8:15 PM ET
  });

  it('treats an unknown playedStatus as not Final', () => {
    const f = fixture('msf-2026-w7-games.json');
    f.games[0].schedule.playedStatus = 'SOMETHING_NEW';
    expect(parseGames(f).games[0].isFinal).toBe(false);
  });
});
