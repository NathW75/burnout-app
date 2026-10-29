/** This Week's lineup tiles (PRD-007 §6.2) and the live refresh on new notices. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRefreshOnNewNotices } from '../api/hooks';
import type { GameWindow, LineupSlot } from '../api/types';
import { SlotTile } from './ThisWeek';

afterEach(() => vi.unstubAllGlobals());

const KICK = '2026-10-30T00:15:00.000Z';
const slot = (o: Partial<LineupSlot>): LineupSlot => ({
  slot: 'wr1', playerId: 'wrKC', name: 'Wes Kay', team: 'KC', position: 'WR', opponent: 'DEN', scheduledEt: KICK, locked: true, voidReason: null, lockedAt: KICK, ...o,
} as LineupSlot);
const win = (status: GameWindow['status']): GameWindow[] => [{ id: 'w', label: 'Thursday', scheduledEt: KICK, status, games: [] }];

describe('lineup tiles', () => {
  it('a burned player is red-tinted with a red border, struck through, and says BURNED in words (Nath, 2026-10-29)', () => {
    render(<ul><SlotTile s={slot({})} windows={win('final')} burnPts={1230} /></ul>);
    const tile = screen.getByRole('listitem');
    expect(tile.className).toMatch(/border-pencil/);
    expect(tile.className).toMatch(/bg-pencil\/14/);
    expect(screen.getByText('WR1 · BURNED')).toHaveClass('text-burnt');
    expect(screen.getByText('W. Kay', { exact: false })).toHaveClass('line-through');
    expect(screen.getByText('12.3 pts')).toBeInTheDocument();
  });

  it('a locked, not yet Final player keeps the amber treatment', () => {
    render(<ul><SlotTile s={slot({})} windows={win('locked')} /></ul>);
    const tile = screen.getByRole('listitem');
    expect(tile.className).toMatch(/border-live/);
    expect(tile.className).toMatch(/bg-bulb\/14/);
    expect(screen.getByText('WR1 · LIVE')).toBeInTheDocument();
  });
});

describe('live refresh', () => {
  it('a new notice (e.g. a burn) refreshes the lineup, windows, burns and boards; the first load and an unchanged poll don’t', async () => {
    let newest = 'n1';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ unread: 1, items: [{ id: newest }], players: {}, nextBefore: null }), { status: 200 })));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    renderHook(() => useRefreshOnNewNotices(), { wrapper });
    await waitFor(() => expect(qc.getQueryData(['notifications'])).toBeTruthy());
    expect(spy).not.toHaveBeenCalled(); // first load: nothing new yet

    await qc.refetchQueries({ queryKey: ['notifications'] });
    expect(spy).not.toHaveBeenCalled(); // same newest notice

    newest = 'n2'; // a burn notice arrives
    await qc.refetchQueries({ queryKey: ['notifications'] });
    await waitFor(() => expect(spy.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0])).toEqual(['lineup', 'windows', 'pool', 'burns', 'fieldMe', 'fieldBoard', 'reveal']));
  });
});
