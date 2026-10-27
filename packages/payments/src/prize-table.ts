/**
 * Prize table algorithm `banded-top20-v1` — PRD-004 §5.2
 *
 * Runs once when a pool is published; the stored bands are authoritative
 * from then on. Pure integer arithmetic (BigInt for the weights), so the
 * same inputs give the same table on every machine.
 */

export const PRIZE_TABLE_ALGORITHM = 'banded-top20-v1';

export interface PrizeBand {
  fromPlace: number;
  toPlace: number;
  /** Prize for each place in the band, in cents. */
  prizeCents: number;
}

export interface PrizeTable {
  algorithm: string;
  prizePoolCents: number;
  minCashCents: number;
  paidPlaces: number;
  bands: PrizeBand[];
}

export interface PrizeTableInput {
  capacity: number;
  buyInCents: number;
  rakeBps: number;
}

/** Rake schedule, PRD-004 §4.2. Other buy-ins default to 10%. */
export function defaultRakeBps(buyInCents: number): number {
  switch (buyInCents) {
    case 2500: return 1500;
    case 5000: return 1200;
    default: return 1000;
  }
}

export function rakeCents(buyInCents: number, rakeBps: number): number {
  return Math.floor((buyInCents * rakeBps) / 10000);
}

/** Buy-in minus rake: the part of each entry fee that belongs to the prize pool. */
export function prizeContributionCents(buyInCents: number, rakeBps: number): number {
  return buyInCents - rakeCents(buyInCents, rakeBps);
}

// ── weights: w(i) = i^-1.2, scaled by 10^12, integer only ───────────────────

const SCALE = 10n ** 12n;

/** floor(x^(1/n)) for a non-negative BigInt, by binary search. */
function iroot(x: bigint, n: bigint): bigint {
  let lo = 0n;
  let hi = 1n;
  while (hi ** n <= x) hi *= 2n;
  while (lo < hi - 1n) {
    const mid = (lo + hi) / 2n;
    if (mid ** n <= x) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** w(i) · 10^12 = 10^18 / (i · i^0.2 · 10^6), with i^0.2 · 10^6 = floor((i · 10^30)^(1/5)). */
const weightCache: bigint[] = [];
function weight(i: number): bigint {
  let w = weightCache[i];
  if (w === undefined) {
    const root = iroot(BigInt(i) * 10n ** 30n, 5n);
    w = weightCache[i] = (SCALE * 10n ** 6n) / (BigInt(i) * root);
  }
  return w;
}

// ── bands ───────────────────────────────────────────────────────────────────

const DECADE = [15n, 20n, 25n, 30n, 40n, 50n, 60n, 75n, 100n]; // ×10^(k-1) for k ≥ 1

/** Band end places: 1..10, then 15, 20, 25, 30, 40, 50, 60, 75, 100, 150, …; the last band ends at K. */
export function bandEnds(paidPlaces: number): number[] {
  const ends: number[] = [];
  for (let i = 1; i <= Math.min(10, paidPlaces); i++) ends.push(i);
  if (paidPlaces <= 10) return ends;
  for (let mult = 1n; ; mult *= 10n) {
    for (const d of DECADE) {
      const e = Number(d * mult);
      if (e >= paidPlaces) {
        ends.push(paidPlaces);
        return ends;
      }
      ends.push(e);
    }
  }
}

// ── table ───────────────────────────────────────────────────────────────────

export function computePrizeTable(input: PrizeTableInput): PrizeTable {
  const { capacity: C, buyInCents: B, rakeBps: R } = input;
  if (!Number.isSafeInteger(C) || C < 1) throw new RangeError('capacity must be a positive integer');
  if (!Number.isSafeInteger(B) || B < 100 || B % 100 !== 0) throw new RangeError('buy-in must be a whole number of dollars');
  if (!Number.isInteger(R) || R < 0 || R >= 10000) throw new RangeError('rake_bps must be in [0, 10000)');

  const gross = BigInt(C) * BigInt(B);
  const P = gross - (gross * BigInt(R)) / 10000n;
  const M = BigInt(Math.ceil((B * 3) / 2 / 100) * 100); // 1.5 × buy-in, rounded up to a whole dollar

  let K = Math.max(1, Math.floor(C / 5));
  if (BigInt(K) * M > P) K = Number(P / M);
  if (K === 0) {
    // The pool can't cover one min cash: winner takes all.
    return { algorithm: PRIZE_TABLE_ALGORITHM, prizePoolCents: Number(P), minCashCents: Number(P), paidPlaces: 1, bands: [{ fromPlace: 1, toPlace: 1, prizeCents: Number(P) }] };
  }

  const w: bigint[] = [];
  let W = 0n;
  for (let i = 1; i <= K; i++) {
    const wi = weight(i);
    w.push(wi);
    W += wi;
  }
  const remainder = P - BigInt(K) * M;

  const bands: PrizeBand[] = [];
  let from = 1;
  for (const end of bandEnds(K)) {
    let bandW = 0n;
    for (let i = from; i <= end; i++) bandW += w[i - 1];
    const size = BigInt(end - from + 1);
    // extra per place = remainder × mean band weight / W, floored to a whole dollar
    const extra = ((remainder * bandW) / (size * W) / 100n) * 100n;
    bands.push({ fromPlace: from, toPlace: end, prizeCents: Number(M + extra) });
    from = end + 1;
  }

  const paid = bands.reduce((s, b) => s + BigInt(b.prizeCents) * BigInt(b.toPlace - b.fromPlace + 1), 0n);
  bands[0].prizeCents += Number(P - paid); // leftover (< K dollars) to 1st

  const table: PrizeTable = { algorithm: PRIZE_TABLE_ALGORITHM, prizePoolCents: Number(P), minCashCents: Number(M), paidPlaces: K, bands };
  assertValidTable(table);
  return table;
}

/** The §5.2 guarantees. Thrown errors here are bugs, not user errors. */
export function assertValidTable(t: PrizeTable): void {
  let expectFrom = 1;
  let sum = 0;
  let prev = Infinity;
  for (const b of t.bands) {
    if (b.fromPlace !== expectFrom || b.toPlace < b.fromPlace) throw new Error(`bands not contiguous at place ${expectFrom}`);
    if (b.prizeCents > prev) throw new Error(`prize increases at place ${b.fromPlace}`);
    if (b.prizeCents < t.minCashCents) throw new Error(`prize below min cash at place ${b.fromPlace}`);
    sum += b.prizeCents * (b.toPlace - b.fromPlace + 1);
    prev = b.prizeCents;
    expectFrom = b.toPlace + 1;
  }
  if (expectFrom - 1 !== t.paidPlaces) throw new Error('bands do not end at the last paid place');
  if (sum !== t.prizePoolCents) throw new Error(`bands sum to ${sum}, prize pool is ${t.prizePoolCents}`);
}

/** Prize for one finishing place; 0 beyond the last paid place. */
export function prizeForPlace(bands: ReadonlyArray<PrizeBand>, place: number): number {
  for (const b of bands) if (place >= b.fromPlace && place <= b.toPlace) return b.prizeCents;
  return 0;
}
