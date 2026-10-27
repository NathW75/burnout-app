import type { GameWindow, PlayerCard } from '../api/types';
import { windowFor } from '../lib/slots';

/** "BUF @ MIA" for a team's game in its window, from the windows list. */
export function matchup(team: string | null, scheduledEt: string | null, windows: GameWindow[]): string | null {
  if (!team) return null;
  const w = windowFor(scheduledEt, windows);
  const g = w?.games.find((x) => x.away === team || x.home === team);
  return g?.away && g.home ? `${g.away} @ ${g.home}` : null;
}

/** "BUF @ MIA" from a pool card. */
export function cardMatchup(c: Pick<PlayerCard, 'team' | 'opponent' | 'homeAway'>): string | null {
  if (!c.opponent || !c.homeAway) return null;
  return c.homeAway === 'home' ? `${c.opponent} @ ${c.team}` : `${c.team} @ ${c.opponent}`;
}

/** The next window still to lock, by the official clock. */
export function nextLock(windows: GameWindow[], now: number): GameWindow | undefined {
  return windows
    .filter((w) => w.status === 'pending' && Date.parse(w.scheduledEt) > now)
    .sort((a, b) => Date.parse(a.scheduledEt) - Date.parse(b.scheduledEt))[0];
}

/** Injury tags worth flagging on a card. Out/IR cards are greyed instead. */
export const CAUTION_STATUSES = new Set(['Questionable', 'Doubtful', 'PUP']);
