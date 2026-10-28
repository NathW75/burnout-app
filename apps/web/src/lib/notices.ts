/**
 * Inbox notices in plain words (PRD-007 §6.6), with the screen each one is
 * about. Players appear as text only: name, position, team (§5.1).
 */
import type { Notification, NoticePlayer } from '../api/types';
import { SLOT_LABEL } from './slots';

export interface NoticeContext {
  /** Names for the players the notices mention, from GET /me/notifications. */
  players: Record<string, NoticePlayer>;
  /** The week This Week shows; notices about it link there, older ones to that week's lineup. */
  currentWeek: number | null;
  /** The viewer's handle, for links to their own past lineups. */
  myHandle: string | null;
}

export interface NoticeView {
  /** A short text tag, so color is never the only signal. */
  tag: string;
  tone: string;
  text: string;
  /** The week it concerns, when the notice says. */
  week: number | null;
  /** Where tapping it goes; null when there's nowhere more useful than the inbox. */
  to: string | null;
}

type Payload = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** "Wes Kay", "Wes Kay and Ray Dent", "Wes Kay, Ray Dent and Quinn Kay", "Wes Kay, Ray Dent and 3 more". */
export function nameList(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

function playerIds(p: Payload): string[] {
  const out: string[] = [];
  if (Array.isArray(p.players)) {
    for (const x of p.players) {
      const id = typeof x === 'object' && x !== null ? str((x as Payload).playerId) : null;
      if (id) out.push(id);
    }
  }
  return out;
}

function slotLabel(v: unknown): string | null {
  return typeof v === 'string' && v in SLOT_LABEL ? SLOT_LABEL[v as keyof typeof SLOT_LABEL] : null;
}

export function noticeView(n: Notification, ctx: NoticeContext): NoticeView {
  const p = n.payload as Payload;
  const week = typeof p.week === 'number' ? p.week : null;
  const current = week === null || week === ctx.currentWeek;
  // An older week's notice opens that week's lineup as it locked.
  const pastLineup = !current && ctx.myHandle ? `/board/${encodeURIComponent(ctx.myHandle)}?week=${week}` : null;
  const ids = playerIds(p);
  const named = ids.map((id) => ctx.players[id]?.name).filter((x): x is string => !!x);
  const who = named.length === ids.length && named.length > 0 ? nameList(named) : null;
  const count = ids.length === 1 ? '1 player' : `${ids.length} players`;
  const onePlayer = (str(p.playerId) && ctx.players[str(p.playerId)!]?.name) || str(p.playerName);
  const slot = slotLabel(p.slot);

  switch (n.kind) {
    case 'BURN':
      return {
        tag: 'BURNED', tone: 'text-pencil', week,
        text: who ? `${who} ${ids.length === 1 ? 'is' : 'are'} burned: ${ids.length === 1 ? 'his game' : 'their games'} went Final.` : `${count} burned: their games went Final.`,
        to: '/burned',
      };
    case 'LOCK': {
      const label = str(p.windowLabel) ?? 'A window';
      return {
        tag: 'LOCKED', tone: 'text-live', week,
        text: who ? `${label} locked with ${who}.` : `${label} locked with ${count} of yours.`,
        to: current ? '/' : pastLineup,
      };
    }
    case 'SUBMISSION_VOIDED': {
      const why =
        p.reason === 'PLAYER_INACTIVE' ? `: listed ${str(p.injuryStatus) ?? 'Out'} before his lock`
        : p.reason === 'PLAYER_NO_GAME' ? ': no game this week'
        : p.reason === 'PLAYER_MERGED' ? ': he was listed twice and is already in your lineup'
        : '';
      return {
        tag: 'VOIDED', tone: 'text-live', week,
        text: `${onePlayer ?? 'Your pick'} was voided${why}. Not burned.${slot ? ` ${slot} is open.` : ''}`,
        to: current ? '/lineup' : pastLineup,
      };
    }
    case 'SUBMISSION_REPOINTED':
      return {
        tag: 'MOVED', tone: 'text-live', week,
        text: `${onePlayer ?? 'Your pick'} changed teams. ${slot ?? 'His slot'} now locks with ${str(p.newWindowLabel) ?? 'his new game'}.`,
        to: current ? '/' : pastLineup,
      };
    case 'SLOT_REOPENED':
      return {
        tag: 'REOPENED', tone: 'text-live', week,
        text: `${slot ?? 'A slot'}${onePlayer ? ` (${onePlayer})` : ''} reopened: the game was canceled. Not burned.`,
        to: current ? '/lineup' : pastLineup,
      };
    case 'LINEUP_RECEIPT':
      return {
        tag: 'CONFIRMED', tone: 'text-accent', week,
        text: week !== null ? `Week ${week} lineup confirmed.` : 'Lineup confirmed.',
        to: str(p.receiptId) ? `/receipts/${str(p.receiptId)}` : null,
      };
    case 'SCORE_CORRECTION':
      return {
        tag: 'SCORE', tone: 'text-muted', week,
        text: week !== null ? `A stat correction changed your Week ${week} points.` : 'A stat correction changed your points.',
        to: '/board',
      };
    default:
      return { tag: n.kind.replace(/_/g, ' '), tone: 'text-muted', week, text: 'New notice.', to: null };
  }
}
