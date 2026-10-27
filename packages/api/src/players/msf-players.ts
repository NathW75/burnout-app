/**
 * MSF v2.1 `players` feed parser — PRD-006 §7.1
 *
 * NIL: only id, name, position, team, roster status and injury designation
 * are read. Everything else in the feed (officialImageSrc, social handles,
 * birth data, …) is dropped here and never reaches the database.
 *
 * Shape per the v2.1 docs: { lastUpdatedOn, players: [{ player: { id,
 * firstName, lastName, primaryPosition, currentTeam: { abbreviation } | null,
 * currentRosterStatus, currentInjury: { playingProbability } | null } }] }.
 * PRD-006 Q5: confirm against a real sample before launch.
 */

export const PLAYER_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'FB']);
/** Positions selectable in a season lineup. FB pending PRD-006 Q2. */
export const SELECTABLE_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K'] as const;

export type InjuryStatus = 'Active' | 'Questionable' | 'Doubtful' | 'Out' | 'IR' | 'PUP';

export interface ParsedPlayer {
  msfPlayerId: string;
  firstName: string;
  lastName: string;
  position: string;
  team: string | null;
  rosterStatus: string | null;
  injuryStatus: InjuryStatus;
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
  if (roster.includes('INJURED_RESERVE') || roster === 'IR') return 'IR';
  if (roster.includes('PUP') || roster.includes('PHYSICALLY_UNABLE')) return 'PUP';
  switch ((playingProbability ?? '').toUpperCase()) {
    case 'OUT': return 'Out';
    case 'DOUBTFUL': return 'Doubtful';
    case 'QUESTIONABLE': return 'Questionable';
    default: return 'Active';
  }
}

export function parsePlayers(feed: unknown): { lastUpdatedOn: Date | null; players: ParsedPlayer[] } {
  if (!isObj(feed) || !Array.isArray(feed.players)) throw new MsfPlayersFeedError('feed.players is not an array');
  const players: ParsedPlayer[] = [];
  feed.players.forEach((entry, i) => {
    if (!isObj(entry) || !isObj(entry.player)) throw new MsfPlayersFeedError(`players[${i}].player is not an object`);
    const p = entry.player;
    const position = String(p.primaryPosition ?? p.position ?? '');
    if (!PLAYER_POSITIONS.has(position)) return; // only fantasy-relevant positions
    if (p.id === undefined || p.id === null) throw new MsfPlayersFeedError(`players[${i}] has no id`);
    const team = isObj(p.currentTeam) && typeof p.currentTeam.abbreviation === 'string' ? p.currentTeam.abbreviation : null;
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
    });
  });
  const updated = typeof feed.lastUpdatedOn === 'string' ? new Date(feed.lastUpdatedOn) : null;
  return { lastUpdatedOn: updated && !Number.isNaN(updated.getTime()) ? updated : null, players };
}
