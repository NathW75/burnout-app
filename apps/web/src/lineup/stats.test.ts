/** Picker pills and stat columns (PRD-007 §6.3.1–§6.3.2, patch c). */
import { describe, expect, it } from 'vitest';
import type { PlayerCard, StatBlock } from '../api/types';
import { cell, defaultGroups, fmt, KICKER_COLUMNS, matchesPill, nextSort, pillsFor, sortPlayers, visibleColumns } from './stats';

const blk = (o: Partial<StatBlock> = {}): StatBlock => ({
  gamesPlayed: 3, pts: 10, ptsTotal: 30,
  rush: { att: 10, yds: 50, ypc: 5, tds: 0 }, rec: { tgt: 4, rec: 3, yds: 20, ypr: 6.7, tds: 0 }, pass: { att: 0, cmp: 0, yds: 0, ypa: null, tds: 0, int: 0 }, k: null, ...o,
});
const card = (name: string, position: string, season?: Partial<StatBlock>, last3?: Partial<StatBlock>): PlayerCard => ({
  playerId: name, name, team: 'KC', position, opponent: 'DEN', homeAway: 'home', scheduledEt: null, bye: false, windowOpen: true, injuryStatus: 'Active',
  burnState: 'available', selectable: true, unavailableReason: null, stats: season ? { season: blk(season), last3: blk(last3 ?? season) } : null,
});

describe('position pills', () => {
  it('ALL plus the slot’s positions; FB folds into RB; FLEX shows RB, WR and TE', () => {
    expect(pillsFor('qb')).toEqual(['ALL', 'QB']);
    expect(pillsFor('rb1')).toEqual(['ALL', 'RB']);
    expect(pillsFor('flex')).toEqual(['ALL', 'RB', 'WR', 'TE']);
    expect(pillsFor('k')).toEqual(['ALL', 'K']);
    expect(matchesPill('RB', 'FB')).toBe(true);
    expect(matchesPill('WR', 'TE')).toBe(false);
    expect(matchesPill('ALL', 'TE')).toBe(true);
  });
});

describe('stat columns', () => {
  it('default groups by slot (§6.3.2 table); kickers get the kicking columns only', () => {
    expect(defaultGroups('qb')).toEqual(['pass', 'rush']);
    expect(defaultGroups('rb2')).toEqual(['rush', 'rec']);
    expect(defaultGroups('wr3')).toEqual(['rec', 'rush']);
    expect(defaultGroups('te')).toEqual(['rec', 'rush']);
    expect(defaultGroups('flex')).toEqual(['rec', 'rush']);
    expect(defaultGroups('k')).toEqual([]); // no group toggles for kickers
    expect(visibleColumns('k', ['rush', 'rec', 'pass'])).toBe(KICKER_COLUMNS);
    expect(KICKER_COLUMNS.map((c) => c.label)).toEqual(['FGM/FGA', 'FG%', 'XPM/XPA', 'PTS']);
  });

  it('visible columns: points per game, then groups in a fixed order (rush, rec, pass) whatever order they were turned on', () => {
    const labels = visibleColumns('qb', ['pass', 'rush']).map((c) => `${c.group}:${c.label}`);
    expect(labels).toEqual(['pts:PTS', 'rush:ATT', 'rush:YDS', 'rush:Y/C', 'rush:TD', 'pass:ATT', 'pass:CMP', 'pass:YDS', 'pass:Y/A', 'pass:TD', 'pass:INT']);
    expect(visibleColumns('wr1', []).map((c) => c.id)).toEqual(['pts']);
  });

  it('zero and missing read "—"; one decimal unless whole; kicking pairs as made/att', () => {
    expect(fmt(0)).toBe('—');
    expect(fmt(null)).toBe('—');
    expect(fmt(4)).toBe('4');
    expect(fmt(4.25)).toBe('4.3');
    const ypa = visibleColumns('qb', ['pass']).find((c) => c.id === 'pass.ypa')!;
    expect(cell(ypa, blk())).toBe('—'); // null rate
    expect(cell(ypa, null)).toBe('—');
    const k = blk({ rush: null, rec: null, pass: null, k: { fgm: 1.5, fga: 2, fgPct: 75, xpm: 0, xpa: 0, pts: 6.5 } });
    expect(cell(KICKER_COLUMNS[0], k)).toBe('1.5/2');
    expect(cell(KICKER_COLUMNS[2], k)).toBe('—');
  });

  it('a header tap sorts descending, then ascending, then back to default', () => {
    expect(nextSort(null, 'rush.yds')).toEqual({ col: 'rush.yds', dir: 'desc' });
    expect(nextSort({ col: 'rush.yds', dir: 'desc' }, 'rush.yds')).toEqual({ col: 'rush.yds', dir: 'asc' });
    expect(nextSort({ col: 'rush.yds', dir: 'asc' }, 'rush.yds')).toBeNull();
    expect(nextSort({ col: 'rush.yds', dir: 'asc' }, 'rec.tgt')).toEqual({ col: 'rec.tgt', dir: 'desc' });
  });

  it('default order is season fantasy points, highest first (no stats last); a column sorts by the chosen period; missing values go last both ways', () => {
    const list = [card('Low', 'RB', { ptsTotal: 10 }, { rush: { att: 30, yds: 200, ypc: 6.7, tds: 2 } }), card('High', 'RB', { ptsTotal: 90 }), card('None', 'RB'), card('Mid', 'RB', { ptsTotal: 50, rush: { att: 5, yds: 80, ypc: 16, tds: 0 } })];
    const cols = visibleColumns('rb1', ['rush']);
    expect(sortPlayers(list, null, 'season', cols).map((p) => p.name)).toEqual(['High', 'Mid', 'Low', 'None']);
    expect(sortPlayers(list, { col: 'rush.yds', dir: 'desc' }, 'season', cols).map((p) => p.name)).toEqual(['Mid', 'High', 'Low', 'None']);
    expect(sortPlayers(list, { col: 'rush.yds', dir: 'desc' }, 'last3', cols).map((p) => p.name)[0]).toBe('Low'); // last-3 numbers
    expect(sortPlayers(list, { col: 'rush.yds', dir: 'asc' }, 'season', cols).map((p) => p.name)).toEqual(['High', 'Low', 'Mid', 'None']);
  });
});
