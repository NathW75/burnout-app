/** Standings, reveal, burned roster and inbox against a mocked API (PRD-007 §6.4–§6.6). */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Burn } from '../api/types';
import { BurnedPage, groupByWeek } from './Burned';
import { InboxPage } from './Inbox';
import { ManagerPage } from './Manager';
import { StandingsPage } from './Standings';

const SEASON = '2026-2027-regular';
type Handler = (url: URL, init?: RequestInit) => unknown;

function mockApi(routes: Record<string, Handler>) {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v1/, '');
    calls.push({ path: path + url.search, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(routes).find((k) => new RegExp(`^${k}$`).test(path));
    if (!key) return new Response(JSON.stringify({ error: 'NOT_FOUND', message: path }), { status: 404 });
    return new Response(JSON.stringify(routes[key](url, init)), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

const season = () => ({ season: SEASON, currentWeek: 8, weeks: [{ week: 7, status: 'complete' }, { week: 8, status: 'live' }, { week: 9, status: 'upcoming' }] });
const me = () => ({ id: 'u', email: 'n@x.com', handle: 'nath', role: 'user', emailVerified: true, mfaEnrolled: true, stepUpUntil: null });

function renderAt(path: string, routes: Array<[string, React.ReactNode]>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          {routes.map(([p, el]) => <Route key={p} path={p} element={el} />)}
          <Route path="*" element={<p>elsewhere</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('Standings (§6.5)', () => {
  const row = (rank: number, handle: string, pts: number, isMe = false) => ({ rank, handle, pointsX100: pts, weekPointsX100: pts / 10, isMe });

  it('shows rank, handle, week and season points; ties share a rank; each manager links to the reveal', async () => {
    mockApi({
      '/seasons/current': season, '/me': me,
      '/seasons/.*/weeks/8/windows': () => ({ windows: [] }),
      '/seasons/.*/leaderboard': () => ({ season: SEASON, week: 8, version: 'v', fieldSize: 3, offset: 0, rows: [row(1, 'ace', 4000), row(2, 'bee', 3000), row(2, 'nath', 3000, true)], me: row(2, 'nath', 3000, true) }),
    });
    renderAt('/board', [['/board', <StandingsPage />]]);
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0].textContent)).toEqual(['1', '2', '2']);
    expect(within(rows[2]).getByText('YOU')).toBeInTheDocument();
    expect(within(rows[0]).getByRole('link', { name: 'ace' })).toHaveAttribute('href', '/board/ace');
    expect(screen.getByLabelText('Rank 2 of 3')).toBeInTheDocument();
    expect(screen.queryByText(/prize/i)).toBeNull(); // no money wording while testing (Nath, 2026-10-28)
  });

  it('pins my row under the page when I rank below it, and pages server-side', async () => {
    const calls = mockApi({
      '/seasons/current': season, '/me': me,
      '/seasons/.*/weeks/8/windows': () => ({ windows: [] }),
      '/seasons/.*/leaderboard': (u) => {
        const offset = Number(u.searchParams.get('offset'));
        return { season: SEASON, week: 8, version: 'v', fieldSize: 120, offset, rows: Array.from({ length: 50 }, (_, i) => row(offset + i + 1, `m${offset + i + 1}`, 10000 - i)), me: row(97, 'nath', 10, true) };
      },
    });
    renderAt('/board', [['/board', <StandingsPage />]]);
    const table = await screen.findByRole('table');
    const last = within(table).getAllByRole('row').at(-1)!;
    expect(within(last).getByText('nath')).toBeInTheDocument();
    expect(within(last).getAllByRole('cell')[0].textContent).toBe('97');
    expect(screen.getByText('1–50 of 120')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'NEXT' }));
    await screen.findByText('51–100 of 120');
    expect(calls.some((c) => c.path.includes('/leaderboard?offset=50&limit=50'))).toBe(true);
  });
});

describe('Reveal (§6.5): locked picks only', () => {
  it('another manager: locked players with points; everything else hidden, with no player at all', async () => {
    mockApi({
      '/seasons/current': season, '/me': me,
      '/seasons/.*/leaderboard': () => ({ season: SEASON, week: 8, version: 'v', fieldSize: 2, offset: 0, rows: [], me: null }),
      '/seasons/.*/weeks/8/managers/rival/lineup': () => ({
        handle: 'rival', week: 8,
        slots: [
          { slotKey: 'qb', state: 'HIDDEN' }, { slotKey: 'rb1', state: 'HIDDEN' }, { slotKey: 'rb2', state: 'HIDDEN' },
          { slotKey: 'wr1', state: 'LOCKED', player: { playerId: 'wrKC', name: 'Wes Kay', team: 'KC', position: 'WR' }, windowLabel: 'Thursday Night', pointsX100: 1250, burned: false },
          { slotKey: 'wr2', state: 'HIDDEN' }, { slotKey: 'wr3', state: 'HIDDEN' }, { slotKey: 'te', state: 'HIDDEN' }, { slotKey: 'flex', state: 'HIDDEN' }, { slotKey: 'k', state: 'HIDDEN' },
        ],
      }),
    });
    renderAt('/board/rival', [['/board/:handle', <ManagerPage />]]);
    const list = await screen.findByRole('list', { name: 'rival, Week 8' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(9);
    expect(within(list).getByText('Wes Kay')).toBeInTheDocument();
    expect(within(list).getByText('12.5')).toBeInTheDocument();
    expect(within(list).getAllByText('Hidden until its window locks')).toHaveLength(8);
    expect(screen.getByText(/Only players whose window has locked are shown/)).toBeInTheDocument();
  });

  it('the week picker lists weeks with locks and changes the week asked for', async () => {
    const calls = mockApi({
      '/seasons/current': season, '/me': me,
      '/seasons/.*/leaderboard': () => ({ season: SEASON, week: 8, version: 'v', fieldSize: 2, offset: 0, rows: [], me: null }),
      '/seasons/.*/weeks/\\d+/managers/nath/lineup': (u) => ({ handle: 'nath', week: Number(u.pathname.split('/')[5]), slots: [{ slotKey: 'qb', state: 'EMPTY' }] }),
    });
    renderAt('/board/nath', [['/board/:handle', <ManagerPage />]]);
    await screen.findByRole('heading', { name: 'Your lineup' });
    const select = screen.getByRole('combobox');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['7', '8']);
    await userEvent.setup().selectOptions(select, '7');
    await waitFor(() => expect(calls.some((c) => c.path.includes('/weeks/7/managers/nath/lineup'))).toBe(true));
  });
});

describe('Burned roster (§6.4)', () => {
  const burn = (week: number, name: string, at: string, pts: number): Burn => ({ week, slot: 'wr1', playerId: name, name, position: 'WR', team: 'KC', pointsX100: pts, burnedAt: at, windowLabel: 'Sunday Early' });

  it('groups by week, newest week first, burns in order within a week', () => {
    const g = groupByWeek([burn(7, 'b', '2026-10-25T21:00:00Z', 1), burn(8, 'c', '2026-10-30T03:00:00Z', 1), burn(7, 'a', '2026-10-25T20:00:00Z', 1)]);
    expect(g.map((x) => [x.week, x.burns.map((b) => b.name)])).toEqual([[8, ['c']], [7, ['a', 'b']]]);
  });

  it('shows the count, points, and each burned player as text', async () => {
    mockApi({ '/seasons/current': season, '/me/burns': () => ({ season: SEASON, burns: [burn(7, 'Wes Kay', '2026-10-25T20:00:00Z', 1850), burn(8, 'Ray Dent', '2026-10-30T03:00:00Z', 420)] }) });
    renderAt('/burned', [['/burned', <BurnedPage />]]);
    expect(await screen.findByText('Wes Kay')).toHaveClass('line-through');
    expect(screen.getByText('22.70')).toBeInTheDocument(); // 18.50 + 4.20, exact to the hundredth
    expect(screen.getByRole('list', { name: 'Burned in Week 8' })).toBeInTheDocument();
  });

  it('each burned player shows his stat line and how it adds up to his points (transparency, Nath 2026-10-30)', async () => {
    const ray: Burn = { ...burn(8, 'Ray Dent', '2026-10-30T03:00:00Z', 1310), rulesVersion: 'yahoo-half-ppr-v1', breakdown: [
      { stat: 'rushYds', label: 'Rushing yards', value: 54, pointsX100: 540 },
      { stat: 'rushTd', label: 'Rushing TD', value: 1, pointsX100: 600 },
      { stat: 'receptions', label: 'Reception', value: 3, pointsX100: 150 },
      { stat: 'recYds', label: 'Receiving yards', value: 22, pointsX100: 220 },
      { stat: 'fumblesLost', label: 'Fumble lost', value: 1, pointsX100: -200 },
    ] };
    const pending: Burn = { ...burn(8, 'Wes Kay', '2026-10-30T04:00:00Z', 0), breakdown: null };
    mockApi({ '/seasons/current': season, '/me/burns': () => ({ season: SEASON, burns: [ray, pending] }) });
    renderAt('/burned', [['/burned', <BurnedPage />]]);
    const table = await screen.findByRole('table', { name: "How Ray Dent's 13.10 points add up" });
    const rows = within(table).getAllByRole('row').slice(1).map((r) => r.textContent);
    expect(rows).toEqual(['Rushing yards54+5.40', 'Rushing TD1+6.00', 'Reception3+1.50', 'Receiving yards22+2.20', 'Fumble lost1−2.00', 'TOTAL · scoring rules13.10']);
    expect(within(table).getByRole('link', { name: 'scoring rules' })).toHaveAttribute('href', '/help#scoring');
    expect(screen.getByText('Stat line on its way from the stats feed.')).toBeInTheDocument();
  });

  it('says so when nothing has burned yet', async () => {
    mockApi({ '/seasons/current': season, '/me/burns': () => ({ season: SEASON, burns: [] }) });
    renderAt('/burned', [['/burned', <BurnedPage />]]);
    expect(await screen.findByText(/No one burned yet/)).toBeInTheDocument();
  });
});

describe('Inbox (§6.6)', () => {
  const items = [
    { id: '11111111-1111-1111-1111-111111111111', kind: 'BURN', payload: { week: 8, players: [{ playerId: 'wrKC' }] }, createdAt: '2026-10-30T03:10:00Z', read: false },
    { id: '22222222-2222-2222-2222-222222222222', kind: 'LOCK', payload: { week: 8, windowLabel: 'Thursday Night', players: [{ playerId: 'wrKC' }] }, createdAt: '2026-10-30T00:16:00Z', read: true },
  ];

  it('opening a notice marks it read and goes where it points; mark all read clears the rest', async () => {
    const calls = mockApi({
      '/seasons/current': season, '/me': me,
      '/me/notifications': () => ({ unread: 1, items, players: { wrKC: { name: 'Wes Kay', position: 'WR', team: 'KC' } }, nextBefore: null }),
      '/me/notifications/read': () => ({ marked: 1 }),
    });
    renderAt('/inbox', [['/inbox', <InboxPage />], ['/burned', <p>burned roster</p>]]);
    const list = await screen.findByRole('list', { name: 'Notices' });
    const [first, second] = within(list).getAllByRole('listitem');
    expect(within(first).getByText('NEW')).toBeInTheDocument();
    expect(within(second).queryByText('NEW')).toBeNull();
    expect(within(first).getByText('Wes Kay is burned: his game went Final.')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'MARK ALL READ' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/me/notifications/read')?.body).toEqual({ all: true }));

    await user.click(within(first).getByRole('link'));
    await screen.findByText('burned roster');
    expect(calls.filter((c) => c.path === '/me/notifications/read').map((c) => c.body)).toContainEqual({ ids: [items[0].id] });
  });

  it('loads older notices with the cursor', async () => {
    const calls = mockApi({
      '/seasons/current': season, '/me': me,
      '/me/notifications': (u) =>
        u.searchParams.get('before')
          ? { unread: 0, items: [{ ...items[1], id: '33333333-3333-3333-3333-333333333333', kind: 'LINEUP_RECEIPT', payload: { week: 7, receiptId: 'r7' } }], players: {}, nextBefore: null }
          : { unread: 0, items: [items[1]], players: {}, nextBefore: '2026-10-30T00:16:00.000Z|22222222-2222-2222-2222-222222222222' },
    });
    renderAt('/inbox', [['/inbox', <InboxPage />]]);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'OLDER NOTICES' }));
    expect(await screen.findByText('Week 7 lineup confirmed.')).toBeInTheDocument();
    expect(calls.some((c) => c.path.includes('before=2026-10-30T00%3A16%3A00.000Z%7C2222'))).toBe(true);
    expect(screen.queryByRole('button', { name: 'OLDER NOTICES' })).toBeNull();
  });
});

describe('Rules: scoring (§6.8)', () => {
  it('describes each stat in plain words from the engine’s values', async () => {
    const { describeStat } = await import('./Help');
    const r = (label: string, centipoints: number) => ({ stat: 'x', label, group: 'Passing' as const, centipoints });
    expect(describeStat(r('Passing yards', 4))).toBe('1 point per 25 yards');
    expect(describeStat(r('Rushing yards', 10))).toBe('1 point per 10 yards');
    expect(describeStat(r('Reception', 50))).toBe('+0.5 each');
    expect(describeStat(r('Receiving TD', 600))).toBe('+6 each');
    expect(describeStat(r('Fumble lost', -200))).toBe('−2 each');
    expect(describeStat(r('Field goal missed', 0))).toBe('0');
  });
});
