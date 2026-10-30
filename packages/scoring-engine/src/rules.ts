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

/** Every ruleset a stored score can name (player_game_scores.rules_version). */
export const RULES_BY_VERSION: Readonly<Record<string, ScoringRules>> = Object.freeze({ [YAHOO_HALF_PPR_V1.version]: YAHOO_HALF_PPR_V1 });

/** Plain-language names, for the rules page and score breakdowns (transparency: Nath, 2026-10-30). */
export const STAT_LABELS: Readonly<Record<keyof StatLine, string>> = Object.freeze({
  passYds: 'Passing yards', passTd: 'Passing TD', passInt: 'Interception thrown',
  rushYds: 'Rushing yards', rushTd: 'Rushing TD',
  receptions: 'Reception', recYds: 'Receiving yards', recTd: 'Receiving TD',
  returnTd: 'Return TD', fumbleRecTd: 'Fumble recovered for a TD', fumblesLost: 'Fumble lost', twoPt: '2-point conversion',
  fgMade0to39: 'Field goal, 0–39 yards', fgMade40to49: 'Field goal, 40–49 yards', fgMade50Plus: 'Field goal, 50+ yards',
  fgMissed: 'Field goal missed', xpMade: 'Extra point', xpMissed: 'Extra point missed',
});

export type StatGroup = 'Passing' | 'Rushing' | 'Receiving' | 'Kicking' | 'Other';
export const STAT_GROUPS: Readonly<Record<keyof StatLine, StatGroup>> = Object.freeze({
  passYds: 'Passing', passTd: 'Passing', passInt: 'Passing',
  rushYds: 'Rushing', rushTd: 'Rushing',
  receptions: 'Receiving', recYds: 'Receiving', recTd: 'Receiving',
  returnTd: 'Other', fumbleRecTd: 'Other', fumblesLost: 'Other', twoPt: 'Other',
  fgMade0to39: 'Kicking', fgMade40to49: 'Kicking', fgMade50Plus: 'Kicking', fgMissed: 'Kicking', xpMade: 'Kicking', xpMissed: 'Kicking',
});

export interface BreakdownLine {
  stat: keyof StatLine;
  label: string;
  value: number;
  pointsX100: number;
}

/**
 * Where a score comes from: one line per stat the player recorded, with the
 * points it earned under these rules. Lines always add up to scoreStatLine().
 */
export function scoreBreakdown(line: StatLine, rules: ScoringRules = CURRENT_RULES): BreakdownLine[] {
  return STAT_FIELDS.filter((f) => line[f] !== 0).map((f) => ({ stat: f, label: STAT_LABELS[f], value: line[f], pointsX100: line[f] * rules.centipointsPer[f] }));
}

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
