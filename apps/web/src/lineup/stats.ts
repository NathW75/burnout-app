/**
 * The picker's position pills and stat columns (PRD-007 §6.3.1–§6.3.2,
 * patch c). Pure functions, so the rules are tested without rendering.
 */
import type { PlayerCard, SlotKey, StatBlock } from '../api/types';
import { SLOT_POSITIONS } from '../lib/slots';

export type Pill = 'ALL' | 'QB' | 'RB' | 'WR' | 'TE' | 'K';
export type Group = 'rush' | 'rec' | 'pass';
export type Period = 'season' | 'last3';

/**
 * The pills for a slot: ALL plus each eligible position. FB is folded into
 * RB (an FB is eligible wherever an RB is, and there are only a handful), so
 * the row reads [ALL] [RB] for RB slots and [ALL] [RB] [WR] [TE] for FLEX.
 */
export function pillsFor(slot: SlotKey): Pill[] {
  const out: Pill[] = ['ALL'];
  for (const p of SLOT_POSITIONS[slot]) if (p !== 'FB' && !out.includes(p as Pill)) out.push(p as Pill);
  return out;
}

export function matchesPill(pill: Pill, position: string): boolean {
  return pill === 'ALL' || position === pill || (pill === 'RB' && position === 'FB');
}

/** Default groups when the picker opens for a slot (§6.3.2). Kickers use their own columns. */
export function defaultGroups(slot: SlotKey): Group[] {
  if (slot === 'qb') return ['pass', 'rush'];
  if (slot === 'rb1' || slot === 'rb2') return ['rush', 'rec'];
  if (slot === 'k') return [];
  return ['rec', 'rush']; // WR, TE, FLEX
}

export const isKickerSlot = (slot: SlotKey) => slot === 'k';

export interface Column {
  id: string;
  label: string;
  /** Full name for screen readers and the header's title. */
  name: string;
  group: Group | 'k' | 'pts';
  get: (b: StatBlock) => number | null;
  /** Shown as "made/att" (kicking), sorted by made. */
  pair?: (b: StatBlock) => [number, number] | null;
}

export const PTS: Column = { id: 'pts', label: 'PTS', name: 'Fantasy points per game', group: 'pts', get: (b) => b.pts };

export const GROUP_COLUMNS: Record<Group, Column[]> = {
  rush: [
    { id: 'rush.att', label: 'ATT', name: 'Rush attempts', group: 'rush', get: (b) => b.rush?.att ?? null },
    { id: 'rush.yds', label: 'YDS', name: 'Rush yards', group: 'rush', get: (b) => b.rush?.yds ?? null },
    { id: 'rush.ypc', label: 'Y/C', name: 'Yards per carry', group: 'rush', get: (b) => b.rush?.ypc ?? null },
    { id: 'rush.tds', label: 'TD', name: 'Rush touchdowns', group: 'rush', get: (b) => b.rush?.tds ?? null },
  ],
  rec: [
    { id: 'rec.tgt', label: 'TGT', name: 'Targets', group: 'rec', get: (b) => b.rec?.tgt ?? null },
    { id: 'rec.rec', label: 'REC', name: 'Receptions', group: 'rec', get: (b) => b.rec?.rec ?? null },
    { id: 'rec.yds', label: 'YDS', name: 'Receiving yards', group: 'rec', get: (b) => b.rec?.yds ?? null },
    { id: 'rec.ypr', label: 'Y/R', name: 'Yards per reception', group: 'rec', get: (b) => b.rec?.ypr ?? null },
    { id: 'rec.tds', label: 'TD', name: 'Receiving touchdowns', group: 'rec', get: (b) => b.rec?.tds ?? null },
  ],
  pass: [
    { id: 'pass.att', label: 'ATT', name: 'Pass attempts', group: 'pass', get: (b) => b.pass?.att ?? null },
    { id: 'pass.cmp', label: 'CMP', name: 'Completions', group: 'pass', get: (b) => b.pass?.cmp ?? null },
    { id: 'pass.yds', label: 'YDS', name: 'Passing yards', group: 'pass', get: (b) => b.pass?.yds ?? null },
    { id: 'pass.ypa', label: 'Y/A', name: 'Yards per attempt', group: 'pass', get: (b) => b.pass?.ypa ?? null },
    { id: 'pass.tds', label: 'TD', name: 'Passing touchdowns', group: 'pass', get: (b) => b.pass?.tds ?? null },
    { id: 'pass.int', label: 'INT', name: 'Interceptions', group: 'pass', get: (b) => b.pass?.int ?? null },
  ],
};

export const KICKER_COLUMNS: Column[] = [
  { id: 'k.fg', label: 'FGM/FGA', name: 'Field goals made and attempted', group: 'k', get: (b) => b.k?.fgm ?? null, pair: (b) => (b.k ? [b.k.fgm, b.k.fga] : null) },
  { id: 'k.fgPct', label: 'FG%', name: 'Field goal percentage', group: 'k', get: (b) => b.k?.fgPct ?? null },
  { id: 'k.xp', label: 'XPM/XPA', name: 'Extra points made and attempted', group: 'k', get: (b) => b.k?.xpm ?? null, pair: (b) => (b.k ? [b.k.xpm, b.k.xpa] : null) },
  { id: 'k.pts', label: 'PTS', name: 'Fantasy points per game', group: 'k', get: (b) => b.k?.pts ?? b.pts },
];

export const GROUP_LABEL: Record<Group, string> = { rush: 'RUSH', rec: 'REC', pass: 'PASS' };
export const GROUP_ORDER: Group[] = ['rush', 'rec', 'pass'];

/** The columns on screen: points per game first, then each group that's on, in a fixed order. */
export function visibleColumns(slot: SlotKey, groups: Group[]): Column[] {
  if (isKickerSlot(slot)) return KICKER_COLUMNS;
  return [PTS, ...GROUP_ORDER.filter((g) => groups.includes(g)).flatMap((g) => GROUP_COLUMNS[g])];
}

/** Zero and missing both read "—" (§6.3.2); whole numbers stay whole, the rest get one decimal. */
export function fmt(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v === 0) return '—';
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

export function cell(col: Column, b: StatBlock | undefined | null): string {
  if (!b) return '—';
  if (col.pair) {
    const p = col.pair(b);
    if (!p || (p[0] === 0 && p[1] === 0)) return '—';
    return `${fmt(p[0]) === '—' ? '0' : fmt(p[0])}/${fmt(p[1])}`;
  }
  return fmt(col.get(b));
}

export interface Sort {
  col: string;
  dir: 'desc' | 'asc';
}

/** A header tap: descending, then ascending, then back to the default order (§6.3.2). */
export function nextSort(cur: Sort | null, col: string): Sort | null {
  if (!cur || cur.col !== col) return { col, dir: 'desc' };
  return cur.dir === 'desc' ? { col, dir: 'asc' } : null;
}

const seasonPoints = (p: PlayerCard) => p.stats?.season.ptsTotal ?? -1;

/**
 * Order within the filtered list. Default: this season's fantasy points,
 * highest first. A sorted column orders by its value in the chosen period;
 * players with no value always go last, whichever way.
 */
export function sortPlayers(list: PlayerCard[], sort: Sort | null, period: Period, columns: Column[]): PlayerCard[] {
  const col = sort ? columns.find((c) => c.id === sort.col) : undefined;
  return [...list].sort((a, b) => {
    if (col && sort) {
      const va = a.stats ? col.get(a.stats[period]) : null;
      const vb = b.stats ? col.get(b.stats[period]) : null;
      if (va === null && vb !== null) return 1;
      if (vb === null && va !== null) return -1;
      if (va !== null && vb !== null && va !== vb) return sort.dir === 'desc' ? vb - va : va - vb;
    } else {
      const d = seasonPoints(b) - seasonPoints(a);
      if (d) return d;
    }
    return a.name.localeCompare(b.name);
  });
}
