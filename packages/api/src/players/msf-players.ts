/**
 * MSF v2.1 `players` feed parser — PRD-006 §7.1
 *
 * NIL: only id, name, position, team, roster status and injury designation
 * are stored. The birth date is read too, but only to tell whether two MSF
 * records are the same person (PRD-006 §7.5); it is never stored. Everything
 * else in the feed (officialImageSrc, social handles, …) is dropped here and
 * never reaches the database.
 *
 * Verified against real feeds (2026-10-27):
 *   players.json  → { lastUpdatedOn, players: [{ player: {…}, teamAsOfDate }], references }
 *                   ~10k players including free agents (currentTeam null).
 *   injuries.json → { lastUpdatedOn, players: [ {…player fields…} ] } — flat, injured only.
 * Player fields used: id, firstName, lastName, primaryPosition, currentTeam
 * { abbreviation } | null, currentRosterStatus (ROSTER | INJURY_LIST | UFA |
 * UNDRAFTED | ASSIGNED_TO_OTHER), currentInjury { playingProbability: OUT |
 * QUESTIONABLE | … } | null.
 * The seasonal player stats feed (`{season}/player_stats_totals.json`,
 * array `playerStatsTotals`) carries the same player object plus `team`, so
 * it works as a fallback when the subscription doesn't include `players`.
 */

export const PLAYER_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'FB']);
/** Positions selectable in a season lineup (FB at RB/FLEX, decision 2026-10-27). */
export const SELECTABLE_POSITIONS = ['QB', 'RB', 'FB', 'WR', 'TE', 'K'] as const;
/** Out and IR players are greyed out: not selectable, not burned (decision 2026-10-27). */
export const INACTIVE_STATUSES: ReadonlySet<string> = new Set(['Out', 'IR']);

export type InjuryStatus = 'Active' | 'Questionable' | 'Doubtful' | 'Out' | 'IR' | 'PUP';

export interface ParsedPlayer {
  msfPlayerId: string;
  firstName: string;
  lastName: string;
  position: string;
  team: string | null;
  rosterStatus: string | null;
  injuryStatus: InjuryStatus;
  /** YYYY-MM-DD. In memory only, for duplicate detection (§7.5); never written to the database. */
  birthDate?: string | null;
}

export class MsfPlayersFeedError extends Error {
  constructor(message: string) {
    super(`MSF players feed: ${message}`);
    this.name = 'MsfPlayersFeedError';
  }
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export function injuryFrom(rosterStatus: string | null, playingProbability: string | null): InjuryStatus {
  const roster = (rosterStatus ?? '').toUpperCase();
  if (roster === 'INJURY_LIST' || roster.includes('INJURED_RESERVE') || roster === 'IR') return 'IR';
  if (roster.includes('PUP') || roster.includes('PHYSICALLY_UNABLE')) return 'PUP';
  switch ((playingProbability ?? '').toUpperCase()) {
    case 'OUT': return 'Out';
    case 'DOUBTFUL': return 'Doubtful';
    case 'QUESTIONABLE': return 'Questionable';
    default: return 'Active';
  }
}

export function parsePlayers(feed: unknown): { lastUpdatedOn: Date | null; players: ParsedPlayer[] } {
  const list = isObj(feed) ? (Array.isArray(feed.players) ? feed.players : Array.isArray(feed.playerStatsTotals) ? feed.playerStatsTotals : null) : null;
  if (!isObj(feed) || !list) throw new MsfPlayersFeedError('feed.players is not an array');
  const players: ParsedPlayer[] = [];
  list.forEach((entry, i) => {
    // players.json wraps each player ({ player, teamAsOfDate }); injuries.json lists player objects directly.
    if (!isObj(entry)) throw new MsfPlayersFeedError(`players[${i}] is not an object`);
    const p = isObj(entry.player) ? entry.player : 'primaryPosition' in entry || 'firstName' in entry ? entry : null;
    if (!p) throw new MsfPlayersFeedError(`players[${i}].player is not an object`);
    const position = String(p.primaryPosition ?? p.position ?? '');
    if (!PLAYER_POSITIONS.has(position)) return; // only fantasy-relevant positions
    if (p.id === undefined || p.id === null) throw new MsfPlayersFeedError(`players[${i}] has no id`);
    const entryTeam = isObj(entry.team) && typeof entry.team.abbreviation === 'string' ? entry.team.abbreviation : null;
    const team = isObj(p.currentTeam) && typeof p.currentTeam.abbreviation === 'string' ? p.currentTeam.abbreviation : 'currentTeam' in p ? null : entryTeam;
    const rosterStatus = typeof p.currentRosterStatus === 'string' ? p.currentRosterStatus : null;
    const prob = isObj(p.currentInjury) && typeof p.currentInjury.playingProbability === 'string' ? p.currentInjury.playingProbability : null;
    players.push({
      msfPlayerId: String(p.id),
      firstName: String(p.firstName ?? '').slice(0, 60),
      lastName: String(p.lastName ?? '').slice(0, 60),
      position,
      team,
      rosterStatus,
      injuryStatus: injuryFrom(rosterStatus, prob),
      birthDate: typeof p.birthDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.birthDate) ? p.birthDate : null,
    });
  });
  const updated = typeof feed.lastUpdatedOn === 'string' ? new Date(feed.lastUpdatedOn) : null;
  return { lastUpdatedOn: updated && !Number.isNaN(updated.getTime()) ? updated : null, players };
}
