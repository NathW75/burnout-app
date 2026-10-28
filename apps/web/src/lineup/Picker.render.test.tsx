/** The picker as rendered (PRD-007 §6.3.1–§6.3.2, patch c). */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Lineup, PlayerCard, SlotKey, StatBlock } from '../api/types';
import { LineupContext, type LineupCtx } from './context';
import { PickerPage } from './Picker';

const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
const blk = (pts: number, rushYds: number, recTgt: number, o: Partial<StatBlock> = {}): StatBlock => ({
  gamesPlayed: 7, pts: pts / 7, ptsTotal: pts,
  rush: { att: rushYds / 5, yds: rushYds, ypc: 5, tds: 0 }, rec: { tgt: recTgt, rec: 0, yds: 0, ypr: null, tds: 0 }, pass: { att: 0, cmp: 0, yds: 0, ypa: null, tds: 0, int: 0 }, k: null, ...o,
});
const card = (playerId: string, name: string, position: string, o: Partial<PlayerCard> = {}): PlayerCard => ({
  playerId, name, team: 'KC', position, opponent: 'DEN', homeAway: 'away', scheduledEt: future, bye: false, windowOpen: true, injuryStatus: 'Active',
  burnState: 'available', selectable: true, unavailableReason: null, stats: null, ...o,
});
const POOL: PlayerCard[] = [
  card('r1', 'Rex Mia', 'RB', { stats: { season: blk(80, 60, 2), last3: blk(30, 90, 1) } }),
  card('r2', 'Ray Dent', 'RB', { stats: { season: blk(120, 40, 5), last3: blk(20, 20, 6) } }),
  card('f1', 'Fred Sfo', 'FB', { stats: { season: blk(10, 5, 1), last3: blk(5, 5, 1) } }),
  card('w1', 'Wes Kay', 'WR', { stats: { season: blk(100, 0, 9), last3: blk(40, 0, 10) } }),
  card('t1', 'Ty Sfo', 'TE', { stats: null }),
  card('r3', 'Ron Chi', 'RB', { unavailableReason: 'BURNED', burnState: 'burned', selectable: false, stats: { season: blk(200, 100, 0), last3: blk(60, 100, 0) } }),
  card('q1', 'Quade Buff', 'QB', { stats: { season: blk(150, 20, 0, { pass: { att: 33, cmp: 22, yds: 260, ypa: 7.9, tds: 2, int: 0 } }), last3: blk(60, 10, 0) } }),
  card('k1', 'Kai Mia', 'K', { stats: { season: blk(70, 0, 0, { rush: null, rec: null, pass: null, k: { fgm: 1.7, fga: 2, fgPct: 85, xpm: 2.3, xpa: 2.4, pts: 10 } }), last3: blk(30, 0, 0, { rush: null, rec: null, pass: null, k: { fgm: 2, fga: 2, fgPct: 100, xpm: 3, xpa: 3, pts: 12 } }) } }),
];

function renderPicker(slot: SlotKey) {
  const lineup: Lineup = { season: 's', week: 8, eligibility: { prizeEligible: false, freePlayThroughWeek: null }, slots: [{ slot, player: null, windowId: null, scheduledEt: null, locked: false, voidReason: null, lockedAt: null } as never] };
  const c: LineupCtx = {
    season: 's', week: 8, lineup, windows: [{ id: 'w', label: 'early', scheduledEt: future, status: 'pending', games: [] } as never], draft: {}, effective: {} as LineupCtx['effective'], changes: 0,
    setSlot: vi.fn(), discardDraft: vi.fn(), review: null, setReview: vi.fn(), acknowledged: false, setAcknowledged: vi.fn(), confirmed: null, setConfirmed: vi.fn(),
    flash: null, setFlash: vi.fn(), endConfirmation: vi.fn(),
  };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ season: 's', week: 8, players: POOL }), { status: 200 })));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <LineupContext.Provider value={c}>
        <MemoryRouter initialEntries={[`/lineup/pick/${slot}`]}>
          <Routes><Route path="/lineup/pick/:slot" element={<PickerPage />} /><Route path="/lineup" element={<p>builder</p>} /></Routes>
        </MemoryRouter>
      </LineupContext.Provider>
    </QueryClientProvider>
  );
  return c;
}
afterEach(() => vi.unstubAllGlobals());

const names = (table: HTMLElement) =>
  within(table).getAllByRole('rowheader').map((r) => r.querySelector('span.font-mono')!.textContent!.replace(/^Select /, ''));

describe('picker (patch c)', () => {
  it('FLEX: pills first (ALL lime), default order is season points, RB includes FB, search works within the pill', async () => {
    renderPicker('flex');
    const user = userEvent.setup();
    const pills = screen.getByRole('group', { name: 'Filter by position' });
    expect(within(pills).getAllByRole('button').map((b) => b.textContent)).toEqual(['ALL', 'RB', 'WR', 'TE']);
    expect(within(pills).getByRole('button', { name: 'ALL' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(pills).getByRole('button', { name: 'ALL' })).toHaveClass('bg-line');
    // The pills come before the search box in the page.
    expect(pills.compareDocumentPosition(screen.getByLabelText(/SEARCH/)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const table = await screen.findByRole('table', { name: 'Players for FLEX' });
    expect(names(table)).toEqual(['Ray Dent', 'Wes Kay', 'Rex Mia', 'Fred Sfo', 'Ty Sfo']); // burned hidden; no-stats last
    await user.click(within(pills).getByRole('button', { name: 'RB' }));
    expect(names(table)).toEqual(['Ray Dent', 'Rex Mia', 'Fred Sfo']);
    await user.type(screen.getByLabelText('SEARCH RBS'), 'kay'); // Wes Kay is a WR: not in the RB list
    expect(within(table).getByText('No players match.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('SEARCH RBS'));
    await user.type(screen.getByLabelText('SEARCH RBS'), 'mia');
    expect(names(table)).toEqual(['Rex Mia']);
  });

  it('columns: FLEX defaults to REC and RUSH; toggling a group shows or hides its columns; zero and missing read "—"', async () => {
    renderPicker('flex');
    const user = userEvent.setup();
    const table = await screen.findByRole('table');
    const heads = () => within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads()).toEqual(['PLAYER', '', 'RUSH', 'REC', 'PTS', 'ATT', 'YDS', 'Y/C', 'TD', 'TGT', 'REC', 'YDS', 'Y/R', 'TD']);
    await user.click(within(screen.getByRole('group', { name: 'Stat groups' })).getByRole('button', { name: 'PASS' }));
    expect(heads()).toContain('PASS');
    await user.click(within(screen.getByRole('group', { name: 'Stat groups' })).getByRole('button', { name: 'RUSH' }));
    expect(heads()).not.toContain('RUSH');
    const ty = within(table).getByRole('rowheader', { name: /Ty Sfo/ }).closest('tr')!;
    expect(within(ty).getAllByRole('cell').every((c) => c.textContent === '—')).toBe(true);
  });

  it('sort: a header tap goes ▼ then ▲ then back to default; SEASON AVG ↔ LAST 3 AVG changes the numbers without refetching', async () => {
    renderPicker('rb1');
    const user = userEvent.setup();
    const table = await screen.findByRole('table');
    const yds = () => within(table).getByRole('button', { name: /Rush yards, sort/ });
    await user.click(yds());
    expect(yds().closest('th')).toHaveAttribute('aria-sort', 'descending');
    expect(yds()).toHaveTextContent('▼');
    expect(names(table)).toEqual(['Rex Mia', 'Ray Dent', 'Fred Sfo']);
    await user.click(yds());
    expect(yds().closest('th')).toHaveAttribute('aria-sort', 'ascending');
    expect(names(table)).toEqual(['Fred Sfo', 'Ray Dent', 'Rex Mia']);
    await user.click(yds());
    expect(yds().closest('th')).toHaveAttribute('aria-sort', 'none');
    expect(names(table)).toEqual(['Ray Dent', 'Rex Mia', 'Fred Sfo']);

    const rex = () => within(table).getByRole('rowheader', { name: /Rex Mia/ }).closest('tr')!;
    expect(within(rex()).getAllByRole('cell')[2]).toHaveTextContent('60');
    const calls = (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await user.click(within(screen.getByRole('group', { name: 'Stat period' })).getByRole('button', { name: 'LAST 3 AVG' }));
    expect(within(rex()).getAllByRole('cell')[2]).toHaveTextContent('90');
    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(calls);
  });

  it('QB: pass and rush on; K: kicking columns only, no group toggles', async () => {
    renderPicker('qb');
    let table = await screen.findByRole('table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent).slice(1, 4)).toEqual(['', 'RUSH', 'PASS']);
    expect(within(within(table).getByRole('rowheader', { name: /Quade Buff/ }).closest('tr')!).getAllByRole('cell').map((c) => c.textContent).slice(-6)).toEqual(['33', '22', '260', '7.9', '2', '—']);
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    renderPicker('k');
    table = await screen.findByRole('table');
    expect(screen.queryByRole('group', { name: 'Stat groups' })).not.toBeInTheDocument();
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['PLAYER', 'KICKING', 'FGM/FGA', 'FG%', 'XPM/XPA', 'PTS']);
    expect(within(within(table).getByRole('rowheader', { name: /Kai Mia/ }).closest('tr')!).getAllByRole('cell').map((c) => c.textContent)).toEqual(['1.7/2', '85', '2.3/2.4', '10']);
  });

  it('show burned: burned players appear muted at the bottom and can’t be selected', async () => {
    renderPicker('rb1');
    const user = userEvent.setup();
    const table = await screen.findByRole('table');
    expect(within(table).queryByText('Ron Chi')).not.toBeInTheDocument();
    await user.click(screen.getByLabelText(/Show players I’ve burned/));
    expect(names(table).at(-1)).toBe('Ron Chi'); // most points, but last: not selectable
    expect(within(table).queryByRole('button', { name: 'Select Ron Chi' })).not.toBeInTheDocument();
    expect(within(table).getByText('Ron Chi')).toHaveClass('line-through');
  });
});
