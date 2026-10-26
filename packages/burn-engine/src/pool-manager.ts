/**
 * Pool Manager
 * Implements PRD-001 §5.1, §10
 *
 * Read-layer for user's available player pool and player display cards.
 * Ownership percentage is served from Redis cache (max 5-min staleness).
 * No writes — pool mutations happen inside burn-evaluator and disruption-handler.
 */

import type { PlayerCard, PlayerBurnState, NFLPosition, InjuryStatus } from './types';

export interface PoolManagerDependencies {
  /**
   * Returns all pool_entries for a user in this season
   * with burned status
   */
  getUserPoolEntries: (userId: string, season: string) => Promise<Array<{
    playerId: string;
    burned: boolean;
    burnedAt?: Date;
  }>>;

  /**
   * Returns current week/season ownership % from Redis
   * { weekOwnershipPct, seasonOwnershipPct }
   * Staleness: max 5 minutes acceptable
   */
  getOwnershipPercentages: (playerIds: string[], week: number, season: string) => Promise<Map<string, {
    weekOwnershipPct: number;
    seasonOwnershipPct: number;
  }>>;

  /**
   * Returns MSF player data for display (name, team, position, opponent, etc.)
   * Served from Redis cache synced daily + on roster moves
   */
  getPlayerData: (playerIds: string[]) => Promise<Map<string, {
    name: string;
    team: string;
    position: NFLPosition;
    opponent: string;
    homeAway: 'home' | 'away';
    scheduledEt: Date;
    injuryStatus: InjuryStatus;
    projectedPoints: number;
  }>>;
}

/**
 * Returns the display pool for a user's lineup builder.
 * Includes burn state relative to this user.
 * Players are returned for ALL burn states so UI can show burned players as
 * grayed-out (they display but cannot be selected).
 */
export async function getUserPlayerPool(
  userId: string,
  week: number,
  season: string,
  deps: PoolManagerDependencies
): Promise<PlayerCard[]> {
  const poolEntries = await deps.getUserPoolEntries(userId, season);
  const playerIds = poolEntries.map((e) => e.playerId);

  const [playerDataMap, ownershipMap] = await Promise.all([
    deps.getPlayerData(playerIds),
    deps.getOwnershipPercentages(playerIds, week, season),
  ]);

  const cards: PlayerCard[] = [];

  for (const entry of poolEntries) {
    const data = playerDataMap.get(entry.playerId);
    const ownership = ownershipMap.get(entry.playerId);

    if (!data) continue; // player no longer in MSF data (traded, released)

    let burnState: PlayerBurnState = 'available';
    if (entry.burned) {
      burnState = 'burned';
    }
    // NOTE: 'locked' state is set per-week on the submission record,
    // not on the pool entry. The pool-level state is only available/burned.
    // Locked display state comes from season_submissions.locked_at for this week.

    cards.push({
      playerId: entry.playerId,
      name: data.name,           // text only — NIL compliance, no headshots
      team: data.team,
      position: data.position,
      opponent: data.opponent,
      homeAway: data.homeAway,
      scheduledEt: data.scheduledEt,
      injuryStatus: data.injuryStatus,
      projectedPoints: data.projectedPoints,
      weekOwnershipPct: ownership?.weekOwnershipPct ?? 0,
      seasonOwnershipPct: ownership?.seasonOwnershipPct ?? 0,
      burnState,
    });
  }

  return cards;
}
