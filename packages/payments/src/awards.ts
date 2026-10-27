/**
 * Tie splits and cent rounding — PRD-004 §9.3, PRD-002 §9
 *
 * Input: the final standings (one row per entry, competition-ranked).
 * Output: one award per entry. Σ awards = Σ prizes for places 1..K whenever
 * the field has at least K entries (always true for a pool that runs, §5.1).
 */
import { prizeForPlace, type PrizeBand } from './prize-table';

export interface StandingRow {
  entryId: string;
  userId: string;
  rank: number;
  pointsX100: number;
}

export interface Award {
  entryId: string;
  userId: string;
  rank: number;
  tieSize: number;
  amountCents: number;
}

export class StandingsInconsistentError extends Error {
  constructor(message: string) {
    super(`STANDINGS_INCONSISTENT: ${message}`);
    this.name = 'StandingsInconsistentError';
  }
}

/**
 * Checks the standings are a valid competition ranking of their own points:
 * rank = 1 + (number of entries with strictly more points). Settlement
 * refuses anything else rather than guess.
 */
export function assertCompetitionRanking(rows: ReadonlyArray<StandingRow>): void {
  const sorted = [...rows].sort((a, b) => b.pointsX100 - a.pointsX100);
  let better = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i].pointsX100 < sorted[i - 1].pointsX100) better = i;
    if (sorted[i].rank !== better + 1) {
      throw new StandingsInconsistentError(`entry ${sorted[i].entryId} has rank ${sorted[i].rank}, expected ${better + 1}`);
    }
  }
}

export function computeAwards(bands: ReadonlyArray<PrizeBand>, rows: ReadonlyArray<StandingRow>): Award[] {
  assertCompetitionRanking(rows);
  const paidPlaces = bands.length ? bands[bands.length - 1].toPlace : 0;

  const groups = new Map<number, StandingRow[]>();
  for (const r of rows) {
    const g = groups.get(r.rank);
    if (g) g.push(r);
    else groups.set(r.rank, [r]);
  }

  const awards: Award[] = [];
  for (const [rank, members] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const n = members.length;
    let total = 0;
    for (let place = rank; place <= Math.min(rank + n - 1, paidPlaces); place++) total += prizeForPlace(bands, place);
    const share = Math.floor(total / n);
    let leftover = total - share * n; // < n cents
    // Leftover cents go one each in ascending entry_id order: a ≤1¢ coin flip, no competitive meaning.
    const ordered = [...members].sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0));
    for (const m of ordered) {
      const extra = leftover > 0 ? 1 : 0;
      leftover -= extra;
      awards.push({ entryId: m.entryId, userId: m.userId, rank, tieSize: n, amountCents: share + extra });
    }
  }
  return awards;
}
