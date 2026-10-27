/**
 * PRD-004 AC1 (prize tables) and AC10 (tie splits) — pure math, no database.
 */
import { assertValidTable, bandEnds, computePrizeTable, defaultRakeBps, prizeForPlace, type PrizeBand } from '../prize-table';
import { computeAwards, StandingsInconsistentError, type StandingRow } from '../awards';

const $ = (d: number) => Math.round(d * 100);
const table = (capacity: number, buyIn: number) =>
  computePrizeTable({ capacity, buyInCents: buyIn, rakeBps: defaultRakeBps(buyIn) });
const flat = (bands: PrizeBand[]) => bands.map((b) => [b.fromPlace, b.toPlace, b.prizeCents]);

describe('AC1: prize table fixtures (PRD-004 §5.3)', () => {
  it('$25 × 1,000', () => {
    const t = table(1000, 2500);
    expect(t.prizePoolCents).toBe($(21250));
    expect(t.minCashCents).toBe($(38));
    expect(t.paidPlaces).toBe(200);
    expect(flat(t.bands)).toEqual([
      [1, 1, $(3676)], [2, 2, $(1577)], [3, 3, $(984)], [4, 4, $(708)], [5, 5, $(550)],
      [6, 6, $(449)], [7, 7, $(380)], [8, 8, $(329)], [9, 9, $(291)], [10, 10, $(261)],
      [11, 15, $(203)], [16, 20, $(149)], [21, 25, $(120)], [26, 30, $(103)], [31, 40, $(87)],
      [41, 50, $(74)], [51, 60, $(66)], [61, 75, $(60)], [76, 100, $(54)], [101, 150, $(48)], [151, 200, $(45)],
    ]);
  });

  it('$50 × 500', () => {
    const t = table(500, 5000);
    expect(t.prizePoolCents).toBe($(22000));
    expect(t.paidPlaces).toBe(100);
    expect(flat(t.bands)).toEqual([
      [1, 1, $(4154)], [2, 2, $(1826)], [3, 3, $(1151)], [4, 4, $(837)], [5, 5, $(658)],
      [6, 6, $(543)], [7, 7, $(464)], [8, 8, $(406)], [9, 9, $(363)], [10, 10, $(328)],
      [11, 15, $(263)], [16, 20, $(201)], [21, 25, $(168)], [26, 30, $(149)], [31, 40, $(131)],
      [41, 50, $(116)], [51, 60, $(107)], [61, 75, $(100)], [76, 100, $(93)],
    ]);
  });

  it('$100 × 250', () => {
    const t = table(250, 10000);
    expect(t.prizePoolCents).toBe($(22500));
    expect(t.minCashCents).toBe($(150));
    expect(t.paidPlaces).toBe(50);
    expect(flat(t.bands)).toEqual([
      [1, 1, $(4705)], [2, 2, $(2122)], [3, 3, $(1362)], [4, 4, $(1008)], [5, 5, $(806)],
      [6, 6, $(677)], [7, 7, $(588)], [8, 8, $(523)], [9, 9, $(474)], [10, 10, $(435)],
      [11, 15, $(362)], [16, 20, $(292)], [21, 25, $(255)], [26, 30, $(233)], [31, 40, $(213)], [41, 50, $(196)],
    ]);
  });

  it('small pools: $25 × 50 and $25 × 10', () => {
    const t50 = table(50, 2500);
    expect(t50.paidPlaces).toBe(10);
    expect(prizeForPlace(t50.bands, 1)).toBe($(318.5));
    expect(prizeForPlace(t50.bands, 2)).toBe($(158));
    expect(prizeForPlace(t50.bands, 10)).toBe($(55));
    const t10 = table(10, 2500);
    expect(flat(t10.bands)).toEqual([[1, 1, $(133.5)], [2, 2, $(79)]]);
  });

  it('band ends follow the published sequence', () => {
    expect(bandEnds(7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(bandEnds(12)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12]);
    expect(bandEnds(2000).slice(10)).toEqual([15, 20, 25, 30, 40, 50, 60, 75, 100, 150, 200, 250, 300, 400, 500, 600, 750, 1000, 1500, 2000]);
  });
});

describe('AC1: prize table guarantees across a sweep', () => {
  const capacities = [1, 2, 3, 4, 5, 6, 9, 10, 11, 49, 50, 51, 99, 100, 101, 250, 333, 500, 999, 1000, 1001, 2500, 7777, 10000, 54321, 100000];
  const buyIns = [2500, 5000, 10000];
  const rakes = [0, 500, 1000, 1200, 1500, 2500, 9999];

  it.each(buyIns)('buy-in %i: sums to P, never increases, ≥ min cash, K = min(⌊C/5⌋, ⌊P/M⌋) ≥ 1', (buyIn) => {
    for (const capacity of capacities) {
      for (const rakeBps of rakes) {
        const t = computePrizeTable({ capacity, buyInCents: buyIn, rakeBps });
        assertValidTable(t); // sum, monotone, ≥ min cash, contiguous (throws on violation)
        const gross = capacity * buyIn;
        const P = gross - Math.floor((gross * rakeBps) / 10000);
        expect(t.prizePoolCents).toBe(P);
        const M = Math.ceil((buyIn * 1.5) / 100) * 100;
        if (P >= M) {
          expect(t.minCashCents).toBe(M);
          expect(t.paidPlaces).toBe(Math.max(1, Math.min(Math.floor(capacity / 5), Math.floor(P / M))));
          expect(t.minCashCents).toBeGreaterThanOrEqual(buyIn * 1.5);
        } else {
          expect(t.paidPlaces).toBe(1); // winner takes all
        }
        for (const b of t.bands.slice(1)) expect(b.prizeCents % 100).toBe(0); // whole dollars except 1st
      }
    }
  });

  it('rejects malformed inputs', () => {
    expect(() => computePrizeTable({ capacity: 0, buyInCents: 2500, rakeBps: 1500 })).toThrow(RangeError);
    expect(() => computePrizeTable({ capacity: 10, buyInCents: 2550, rakeBps: 1500 })).toThrow(RangeError);
    expect(() => computePrizeTable({ capacity: 10, buyInCents: 2500, rakeBps: 10000 })).toThrow(RangeError);
  });
});

// ── AC10 ────────────────────────────────────────────────────────────────────

/** Deterministic PRNG so failures reproduce. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0) / 2 ** 32);
}

function standings(points: number[]): StandingRow[] {
  const rows = points.map((p, i) => ({ entryId: `e-${String(i).padStart(6, '0')}`, userId: `u-${i}`, pointsX100: p, rank: 0 }));
  for (const r of rows) r.rank = 1 + rows.filter((o) => o.pointsX100 > r.pointsX100).length;
  return rows;
}

describe('AC10: tie splits', () => {
  const t = table(1000, 2500);

  it('the §9.3 example: three tied across the cash line (199–201 of 200) split 199 + 200 → $30.00 each', () => {
    const points = Array.from({ length: 1000 }, (_, i) => 1_000_000 - i * 10);
    points[199] = points[198]; // places 199, 200, 201 share rank 199
    points[200] = points[198];
    const awards = computeAwards(t.bands, standings(points));
    const tied = awards.filter((a) => a.rank === 199);
    expect(tied.map((a) => a.amountCents)).toEqual([$(30), $(30), $(30)]);
    expect(tied.every((a) => a.tieSize === 3)).toBe(true);
    expect(awards.reduce((s, a) => s + a.amountCents, 0)).toBe(t.prizePoolCents);
  });

  it('two tied for 2nd share 2nd + 3rd; the next entry is 4th and gets 4th place money', () => {
    const awards = computeAwards(t.bands, standings([900, 800, 800, 700, ...Array(996).fill(1)]));
    const by = (rank: number) => awards.filter((a) => a.rank === rank).map((a) => a.amountCents);
    expect(by(2)).toEqual([($(1577) + $(984)) / 2, ($(1577) + $(984)) / 2]);
    expect(by(4)).toEqual([$(708)]);
  });

  it('leftover cents go one each in ascending entry_id order', () => {
    // 3 tied for 1st on $25 × 10 (prizes 133.50 + 79.00 = 212.50 = 21250¢ → 7083¢ × 3 + 1¢)
    const t10 = table(10, 2500);
    const rows = standings([5, 5, 5, 1, 1, 1, 1, 1, 1, 1]).reverse(); // input order must not matter
    const awards = computeAwards(t10.bands, rows).filter((a) => a.rank === 1);
    expect(awards.map((a) => [a.entryId, a.amountCents])).toEqual([['e-000000', 7084], ['e-000001', 7083], ['e-000002', 7083]]);
  });

  it('property: Σ awards = P for random tie patterns, including ties at and across the cash line', () => {
    const next = rng(20261026);
    for (let trial = 0; trial < 400; trial++) {
      const capacity = 5 + Math.floor(next() * 600);
      const buyIn = [2500, 5000, 10000][Math.floor(next() * 3)];
      const tt = table(capacity, buyIn);
      const field = tt.paidPlaces + Math.floor(next() * (capacity - tt.paidPlaces + 1)); // K ≤ field ≤ C
      const distinct = 1 + Math.floor(next() * Math.max(1, field / (1 + next() * 8))); // few values → many ties
      const points = Array.from({ length: field }, () => Math.floor(next() * distinct) * 25);
      const awards = computeAwards(tt.bands, standings(points));
      expect(awards).toHaveLength(field);
      expect(awards.reduce((s, a) => s + a.amountCents, 0)).toBe(tt.prizePoolCents);
      for (const a of awards) expect(Number.isInteger(a.amountCents) && a.amountCents >= 0).toBe(true);
      // tied entries never differ by more than 1¢
      const byRank = new Map<number, number[]>();
      for (const a of awards) byRank.set(a.rank, [...(byRank.get(a.rank) ?? []), a.amountCents]);
      for (const amounts of byRank.values()) expect(Math.max(...amounts) - Math.min(...amounts)).toBeLessThanOrEqual(1);
    }
  });

  it('refuses standings whose ranks do not match their own points', () => {
    const rows = standings([30, 20, 10]);
    rows[2].rank = 2;
    expect(() => computeAwards(t.bands, rows)).toThrow(StandingsInconsistentError);
  });
});
