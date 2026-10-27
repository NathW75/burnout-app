/**
 * MySportsFeeds v2.1 adapter — PRD-002 §4.1
 *
 * The ONLY code that knows MSF field names. Turns the weekly `games` and
 * `player_gamelogs` feeds into our types. Field mapping verified against the
 * live 2026-27 Week 7 feeds on 2026-10-26 (fixtures in __tests__/fixtures).
 *
 * Feed URL pattern: https://api.mysportsfeeds.com/v2.1/pull/nfl/{season}/week/{week}/{feed}.json
 * Auth: HTTP Basic, username = API key, password = "MYSPORTSFEEDS".
 *
 * NIL: nothing from MSF's player/team reference data (headshot URLs, logo
 * URLs, biographical fields) is read or passed through. Only stats, IDs and
 * schedule fields leave this module.
 */

import { emptyStatLine, type StatLine } from './rules';

/** Positions whose stat lines are scored (FB scores like any offensive player). */
export const SCORED_POSITIONS: ReadonlySet<string> = new Set(['QB', 'RB', 'FB', 'WR', 'TE', 'K']);

export class MsfFeedError extends Error {
  readonly code = 'MSF_FEED_INVALID';
  constructor(message: string) {
    super(`MSF feed rejected: ${message}`);
    this.name = 'MsfFeedError';
  }
}

export interface PlayerGameStatLine {
  msfGameId: string;
  playerId: string;
  week: number;
  stats: StatLine;
}

export interface ParsedGamelogs {
  lastUpdatedOn: Date;
  lines: PlayerGameStatLine[];
}

export interface GameStatus {
  msfGameId: string;
  week: number;
  scheduledStart: Date;
  playedStatus: string;
  scheduleStatus: string;
  /** Game is over per MSF. Drives score status `final` (PRD-002 §6). */
  isFinal: boolean;
}

export interface ParsedGames {
  lastUpdatedOn: Date;
  games: GameStatus[];
}

/**
 * MSF playedStatus values treated as Final. COMPLETED_PENDING_REVIEW means the
 * game is over but MSF is still reviewing stats; stat changes after that are
 * handled as corrections (§7). Any value not listed here is treated as NOT
 * final, so an unexpected status can never trigger finalization.
 */
export const MSF_FINAL_STATUSES: ReadonlySet<string> = new Set(['COMPLETED', 'COMPLETED_PENDING_REVIEW']);

type Json = Record<string, unknown>;

const obj = (v: unknown, where: string): Json => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new MsfFeedError(`${where} is not an object`);
  return v as Json;
};

const date = (v: unknown, where: string): Date => {
  const d = new Date(String(v));
  if (typeof v !== 'string' || Number.isNaN(d.getTime())) throw new MsfFeedError(`${where} is not a timestamp`);
  return d;
};

/** Reads a stat; absent group or field = 0. Present values must be integers. */
function stat(stats: Json, group: string, field: string, where: string): number {
  const g = stats[group];
  if (g === undefined || g === null) return 0;
  const v = obj(g, `${where}.${group}`)[field];
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new MsfFeedError(`${where}.${group}.${field} is not an integer (${String(v)})`);
  }
  return v;
}

export function parseGamelogs(feed: unknown): ParsedGamelogs {
  const root = obj(feed, 'feed');
  if (!Array.isArray(root.gamelogs)) throw new MsfFeedError('feed.gamelogs is not an array');
  const lastUpdatedOn = date(root.lastUpdatedOn, 'feed.lastUpdatedOn');

  const lines: PlayerGameStatLine[] = [];
  root.gamelogs.forEach((raw, i) => {
    const entry = obj(raw, `gamelogs[${i}]`);
    const player = obj(entry.player, `gamelogs[${i}].player`);
    if (!SCORED_POSITIONS.has(String(player.position))) return;

    const game = obj(entry.game, `gamelogs[${i}].game`);
    const s = obj(entry.stats ?? {}, `gamelogs[${i}].stats`);
    const at = `gamelogs[${i}](player ${String(player.id)})`;
    const get = (group: string, field: string) => stat(s, group, field, at);

    // Two-point conversions: MSF credits passer, receiver and rusher separately.
    const twoPtParts = get('twoPointAttempts', 'twoPtPassMade') + get('twoPointAttempts', 'twoPtPassRec') + get('twoPointAttempts', 'twoPtRushMade');
    if (twoPtParts !== get('twoPointAttempts', 'twoPtMade')) {
      throw new MsfFeedError(`${at}: two-point parts (${twoPtParts}) do not sum to twoPtMade`);
    }

    // Field goals: MSF has five distance buckets; Yahoo tiers are 0-39, 40-49, 50+.
    const fg0to39 = get('fieldGoals', 'fgMade1_19') + get('fieldGoals', 'fgMade20_29') + get('fieldGoals', 'fgMade30_39');
    const fg40to49 = get('fieldGoals', 'fgMade40_49');
    const fg50Plus = get('fieldGoals', 'fgMade50Plus');
    const fgMade = get('fieldGoals', 'fgMade');
    if (fg0to39 + fg40to49 + fg50Plus !== fgMade) {
      throw new MsfFeedError(`${at}: field goal buckets do not sum to fgMade`);
    }
    const fgMissed = get('fieldGoals', 'fgAtt') - fgMade;
    const xpMade = get('extraPointAttempts', 'xpMade');
    const xpMissed = get('extraPointAttempts', 'xpAtt') - xpMade;
    if (fgMissed < 0 || xpMissed < 0) throw new MsfFeedError(`${at}: made exceeds attempts`);

    const stats: StatLine = {
      ...emptyStatLine(),
      passYds: get('passing', 'passYards'),
      passTd: get('passing', 'passTD'),
      passInt: get('passing', 'passInt'),
      rushYds: get('rushing', 'rushYards'),
      rushTd: get('rushing', 'rushTD'),
      receptions: get('receiving', 'receptions'),
      recYds: get('receiving', 'recYards'),
      recTd: get('receiving', 'recTD'),
      returnTd: get('kickoffReturns', 'krTD') + get('puntReturns', 'prTD'),
      // offFumTD = offensive fumble recovery TD. fumTD is the defensive stat ("DefTD") and is excluded.
      fumbleRecTd: get('fumbles', 'offFumTD'),
      fumblesLost: get('fumbles', 'fumLost'),
      twoPt: twoPtParts,
      fgMade0to39: fg0to39,
      fgMade40to49: fg40to49,
      fgMade50Plus: fg50Plus,
      fgMissed,
      xpMade,
      xpMissed,
    };

    const week = Number(game.week);
    if (!Number.isInteger(week)) throw new MsfFeedError(`${at}: game.week missing`);
    lines.push({ msfGameId: String(game.id), playerId: String(player.id), week, stats });
  });

  return { lastUpdatedOn, lines };
}

export function parseGames(feed: unknown): ParsedGames {
  const root = obj(feed, 'feed');
  if (!Array.isArray(root.games)) throw new MsfFeedError('feed.games is not an array');
  const lastUpdatedOn = date(root.lastUpdatedOn, 'feed.lastUpdatedOn');
  const games = root.games.map((raw, i): GameStatus => {
    const s = obj(obj(raw, `games[${i}]`).schedule, `games[${i}].schedule`);
    const playedStatus = String(s.playedStatus);
    return {
      msfGameId: String(s.id),
      week: Number(s.week),
      scheduledStart: date(s.startTime, `games[${i}].schedule.startTime`),
      playedStatus,
      scheduleStatus: String(s.scheduleStatus),
      isFinal: MSF_FINAL_STATUSES.has(playedStatus),
    };
  });
  return { lastUpdatedOn, games };
}
