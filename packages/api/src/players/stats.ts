/**
 * Player stats for the picker (PRD-007 §6.3.2, §8.7): per-game season
 * averages and the average of the last three games played, from the
 * MySportsFeeds weekly game logs.
 *
 * Only the worker holds the MSF key (Railway: worker only), so the worker
 * fetches the logs and keeps the result in Redis; the API attaches it to the
 * pool. No new Postgres tables. Stats are informational: if Redis has none,
 * the pool still works and every stat shows as "—".
 */
import { parseGamelogs, scoreStatLine } from '@burnout/scoring-engine';
import type { Redis } from 'ioredis';
import { SELECTABLE_POSITIONS } from './msf-players';

export interface GameLine {
  playerId: string;
  gameId: string;
  week: number;
  start: string;
  rush: { att: number; yds: number; tds: number };
  rec: { tgt: number; rec: number; yds: number; tds: number };
  pass: { att: number; cmp: number; yds: number; tds: number; int: number };
  k: { fgm: number; fga: number; xpm: number; xpa: number };
  /** Fantasy points for the game (current scoring rules), ×100. */
  ptsX100: number;
}

/** Counts are totals over the period; yards and points are per game (see block()). */
export interface StatBlock {
  gamesPlayed: number;
  /** Fantasy points per game; season blocks also carry the season total for sorting. */
  pts: number;
  ptsTotal?: number;
  rush: { att: number; yds: number; ypc: number | null; tds: number } | null;
  rec: { tgt: number; rec: number; yds: number; ypr: number | null; tds: number } | null;
  pass: { att: number; cmp: number; yds: number; ypa: number | null; tds: number; int: number } | null;
  k: { fgm: number; fga: number; fgPct: number | null; xpm: number; xpa: number; pts: number } | null;
}

export interface PlayerStats {
  season: StatBlock;
  last3: StatBlock;
}

export interface StatsBlob {
  season: string;
  asOf: string;
  weeks: number[];
  players: Record<string, PlayerStats>;
}

const SELECTABLE: ReadonlySet<string> = new Set(SELECTABLE_POSITIONS);
type J = Record<string, unknown>;
const num = (stats: J, group: string, field: string): number => {
  const g = stats[group];
  const v = g && typeof g === 'object' ? (g as J)[field] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
};

/**
 * Every selectable-position player's line from one week's game-log feed.
 * Points come from the scoring engine's own parser and rules, so they match
 * the app's scoring exactly.
 */
export function parseGameLines(feed: unknown): GameLine[] {
  // The scoring parser is strict (it refuses inconsistent lines); stats are informational, so a refusal only drops points.
  let scored = new Map<string, number>();
  try {
    scored = new Map(parseGamelogs(feed).lines.map((l) => [`${l.msfGameId}:${l.playerId}`, scoreStatLine(l.stats)]));
  } catch {
    /* points stay 0 for this week */
  }
  const logs = (feed as { gamelogs?: unknown[] }).gamelogs ?? [];
  const out: GameLine[] = [];
  for (const raw of logs) {
    const e = raw as { game?: J; player?: J; stats?: J };
    if (!e.player || !e.game || !SELECTABLE.has(String(e.player.position))) continue;
    const s = (e.stats ?? {}) as J;
    const gameId = String(e.game.id);
    const playerId = String(e.player.id);
    out.push({
      playerId,
      gameId,
      week: Number(e.game.week),
      start: String(e.game.startTime ?? ''),
      rush: { att: num(s, 'rushing', 'rushAttempts'), yds: num(s, 'rushing', 'rushYards'), tds: num(s, 'rushing', 'rushTD') },
      rec: { tgt: num(s, 'receiving', 'targets'), rec: num(s, 'receiving', 'receptions'), yds: num(s, 'receiving', 'recYards'), tds: num(s, 'receiving', 'recTD') },
      pass: { att: num(s, 'passing', 'passAttempts'), cmp: num(s, 'passing', 'passCompletions'), yds: num(s, 'passing', 'passYards'), tds: num(s, 'passing', 'passTD'), int: num(s, 'passing', 'passInt') },
      k: { fgm: num(s, 'fieldGoals', 'fgMade'), fga: num(s, 'fieldGoals', 'fgAtt'), xpm: num(s, 'extraPointAttempts', 'xpMade'), xpa: num(s, 'extraPointAttempts', 'xpAtt') },
      ptsX100: scored.get(`${gameId}:${playerId}`) ?? 0,
    });
  }
  return out;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const rate = (n: number, d: number) => (d > 0 ? r1(n / d) : null);

/**
 * One period's numbers (Nath, 2026-10-28): counts (attempts, completions,
 * targets, receptions, TDs, INTs, kicks made and tried) are whole-number
 * totals over the period, since nobody makes 0.3 of an attempt; yards and
 * points are per-game averages; rates (Y/C, Y/R, Y/A, FG%) come from the
 * totals and are null when the denominator is 0.
 */
export function block(games: GameLine[], kicker: boolean, withTotal = false): StatBlock {
  const n = games.length;
  const sum = (f: (g: GameLine) => number) => games.reduce((a, g) => a + f(g), 0);
  const per = (f: (g: GameLine) => number) => (n ? r1(sum(f) / n) : 0);
  const ptsTotal = sum((g) => g.ptsX100) / 100;
  const pts = n ? r1(ptsTotal / n) : 0;
  const base: StatBlock = { gamesPlayed: n, pts, ...(withTotal ? { ptsTotal: Math.round(ptsTotal * 100) / 100 } : {}), rush: null, rec: null, pass: null, k: null };
  if (kicker) {
    const fgm = sum((g) => g.k.fgm);
    const fga = sum((g) => g.k.fga);
    return { ...base, k: { fgm, fga, fgPct: fga > 0 ? Math.round((fgm * 100) / fga) : null, xpm: sum((g) => g.k.xpm), xpa: sum((g) => g.k.xpa), pts } };
  }
  return {
    ...base,
    rush: { att: sum((g) => g.rush.att), yds: per((g) => g.rush.yds), ypc: rate(sum((g) => g.rush.yds), sum((g) => g.rush.att)), tds: sum((g) => g.rush.tds) },
    rec: { tgt: sum((g) => g.rec.tgt), rec: sum((g) => g.rec.rec), yds: per((g) => g.rec.yds), ypr: rate(sum((g) => g.rec.yds), sum((g) => g.rec.rec)), tds: sum((g) => g.rec.tds) },
    pass: { att: sum((g) => g.pass.att), cmp: sum((g) => g.pass.cmp), yds: per((g) => g.pass.yds), ypa: rate(sum((g) => g.pass.yds), sum((g) => g.pass.att)), tds: sum((g) => g.pass.tds), int: sum((g) => g.pass.int) },
  };
}

/**
 * Season and last-3 blocks per person: lines under another MSF ID for the same
 * person count as theirs (PRD-006 §7.5). Last 3 = the last three games he
 * appeared in, not the last three weeks.
 */
export function aggregate(lines: GameLine[], aliases: ReadonlyMap<string, string>, positions: ReadonlyMap<string, string>): Record<string, PlayerStats> {
  const byPerson = new Map<string, Map<string, GameLine>>();
  for (const l of lines) {
    const person = aliases.get(l.playerId) ?? l.playerId;
    const games = byPerson.get(person) ?? new Map<string, GameLine>();
    games.set(l.gameId, l); // one line per game
    byPerson.set(person, games);
  }
  const out: Record<string, PlayerStats> = {};
  for (const [person, games] of byPerson) {
    const all = [...games.values()].sort((a, b) => a.start.localeCompare(b.start) || a.week - b.week);
    const kicker = positions.get(person) === 'K';
    out[person] = { season: block(all, kicker, true), last3: block(all.slice(-3), kicker) };
  }
  return out;
}

// ── Redis ───────────────────────────────────────────────────────────────────

export const statsKey = (ns: string, season: string) => `${ns}stats:${season}`;
export const weekLinesKey = (ns: string, season: string, week: number) => `${ns}statlines:${season}:${week}`;
/** A frozen week's lines never change: keep them a month. An open week's: until the next run refetches. */
export const FROZEN_WEEK_TTL = 30 * 86_400;
export const OPEN_WEEK_TTL = 6 * 3600;
export const STATS_TTL = 7 * 86_400;

const memo = new Map<string, { at: number; blob: StatsBlob | null }>();
/** Parsed blobs are kept in memory this long, so opening the picker doesn't re-parse a large blob each time. */
export const STATS_MEMO_MS = 60_000;

/** The blob the API attaches to the pool, or null (no Redis, nothing yet, or Redis down). */
export async function readStats(redis: Redis | undefined, ns: string, season: string, nowMs = Date.now()): Promise<StatsBlob | null> {
  if (!redis) return null;
  const key = statsKey(ns, season);
  const hit = memo.get(key);
  if (hit && nowMs - hit.at < STATS_MEMO_MS) return hit.blob;
  try {
    const raw = await redis.get(key);
    const blob = raw ? (JSON.parse(raw) as StatsBlob) : null;
    memo.set(key, { at: nowMs, blob });
    return blob;
  } catch {
    return null;
  }
}

/** Tests and the stats job: forget the in-memory copy. */
export function clearStatsMemo(): void {
  memo.clear();
}
