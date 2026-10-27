/**
 * Scoring rules — PRD-002 §3 (LOCKED 2026-10-26)
 *
 * Yahoo Fantasy default scoring, half-PPR, fractional yardage, negative points.
 * Every value is a whole number of centipoints (points × 100), so scoring is
 * exact integer arithmetic. Points are never handled as floating point.
 */

/** One player's normalized stats for one game. Field names are ours, not MSF's. */
export interface StatLine {
  passYds: number;
  passTd: number;
  passInt: number;
  rushYds: number;
  rushTd: number;
  receptions: number;
  recYds: number;
  recTd: number;
  returnTd: number;
  fumbleRecTd: number;
  fumblesLost: number;
  twoPt: number;
  fgMade0to39: number;
  fgMade40to49: number;
  fgMade50Plus: number;
  fgMissed: number;
  xpMade: number;
  xpMissed: number;
}

export const STAT_FIELDS: ReadonlyArray<keyof StatLine> = [
  'passYds', 'passTd', 'passInt', 'rushYds', 'rushTd', 'receptions', 'recYds', 'recTd',
  'returnTd', 'fumbleRecTd', 'fumblesLost', 'twoPt',
  'fgMade0to39', 'fgMade40to49', 'fgMade50Plus', 'fgMissed', 'xpMade', 'xpMissed',
];

export interface ScoringRules {
  version: string;
  /** Centipoints per unit of each stat. */
  centipointsPer: Readonly<Record<keyof StatLine, number>>;
}

export const YAHOO_HALF_PPR_V1: ScoringRules = Object.freeze({
  version: 'yahoo-half-ppr-v1',
  centipointsPer: Object.freeze({
    passYds: 4, // 1 point per 25 yards
    passTd: 400,
    passInt: -100,
    rushYds: 10, // 1 point per 10 yards
    rushTd: 600,
    receptions: 50, // half-PPR
    recYds: 10,
    recTd: 600,
    returnTd: 600,
    fumbleRecTd: 600,
    fumblesLost: -200,
    twoPt: 200,
    fgMade0to39: 300,
    fgMade40to49: 400,
    fgMade50Plus: 500,
    fgMissed: 0,
    xpMade: 100,
    xpMissed: 0,
  }),
});

/** The ruleset for the 2026-27 season. Fixed once the Week 1 lock fires (§3.4). */
export const CURRENT_RULES = YAHOO_HALF_PPR_V1;

export const emptyStatLine = (): StatLine =>
  Object.fromEntries(STAT_FIELDS.map((f) => [f, 0])) as unknown as StatLine;

/**
 * Pure: same stat line + same rules → same centipoints. No I/O. PRD-002 §5.1.
 * Throws on non-integer stats rather than silently producing fractional centipoints.
 */
export function scoreStatLine(line: StatLine, rules: ScoringRules = CURRENT_RULES): number {
  let total = 0;
  for (const field of STAT_FIELDS) {
    const value = line[field];
    if (!Number.isInteger(value)) {
      throw new TypeError(`Stat ${field} must be an integer, got ${String(value)}`);
    }
    total += value * rules.centipointsPer[field];
  }
  if (!Number.isSafeInteger(total)) throw new RangeError('Score out of safe integer range');
  return total;
}

/** Display form: 1248 → "12.48", -30 → "-0.30". */
export function formatPoints(centipoints: number): string {
  const sign = centipoints < 0 ? '-' : '';
  const abs = Math.abs(centipoints);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
