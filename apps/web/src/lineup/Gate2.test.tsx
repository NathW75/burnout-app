import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Lineup } from '../api/types';
import { LineupContext, type LineupCtx } from './context';
import { Gate2Page } from './Gates';

function ctx(over: Partial<LineupCtx> = {}): LineupCtx {
  const lineup: Lineup = { season: 's', week: 8, eligibility: { prizeEligible: false, freePlayThroughWeek: null }, slots: [] };
  return {
    season: 's', week: 8, lineup, windows: [], draft: {}, effective: {} as LineupCtx['effective'], changes: 1,
    setSlot: vi.fn(), discardDraft: vi.fn(),
    review: { confirmationId: 'c1', gate1At: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(), slots: [] },
    setReview: vi.fn(), acknowledged: false, setAcknowledged: vi.fn(), confirmed: null, setConfirmed: vi.fn(),
    flash: null, setFlash: vi.fn(), endConfirmation: vi.fn(), ...over,
  };
}

function renderGate2(c: LineupCtx) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ confirmationId: 'c1', gate2At: 'x' }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <LineupContext.Provider value={c}>
        <MemoryRouter initialEntries={['/lineup/acknowledge']}>
          <Routes>
            <Route path="/lineup/acknowledge" element={<Gate2Page />} />
            <Route path="/lineup/confirm" element={<p>gate three</p>} />
          </Routes>
        </MemoryRouter>
      </LineupContext.Provider>
    </QueryClientProvider>
  );
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('Gate 2 acknowledge (PRD-007 §7, approved behavior)', () => {
  it('nothing is pre-checked; CONTINUE stays lime and untappable until all three are ticked, then turns red with white text', async () => {
    const user = userEvent.setup();
    const c = ctx();
    const fetchMock = renderGate2(c);
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(3);
    boxes.forEach((b) => expect(b).not.toBeChecked());
    const cont = () => screen.getByRole('button', { name: 'CONTINUE' });
    expect(cont()).toBeDisabled();
    expect(cont()).not.toHaveClass('bg-commit');
    expect(screen.getByText('Tick 3 more to continue')).toBeInTheDocument();

    await user.click(boxes[0]);
    await user.click(boxes[1]);
    expect(cont()).toBeDisabled();
    expect(screen.getByText('Tick 1 more to continue')).toBeInTheDocument();
    await user.click(cont());
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(boxes[2]);
    expect(cont()).toBeEnabled();
    expect(cont()).toHaveClass('bg-commit', 'text-white');
    expect(screen.queryByText(/more to continue/)).toBeNull();

    // Unticking one goes back to lime and untappable.
    await user.click(boxes[1]);
    expect(cont()).toBeDisabled();
    await user.click(boxes[1]);

    await user.click(cont());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/v1\/lineup-confirmations\/c1\/acknowledge$/);
    expect(JSON.parse(init.body as string)).toEqual({ burnRules: true, permanent: true, noRefund: true });
    expect(await screen.findByText('gate three')).toBeInTheDocument();
    expect(c.setAcknowledged).toHaveBeenCalledWith(true);
  });

  it('an expired confirmation sends the user back to the builder with the reason', async () => {
    const user = userEvent.setup();
    const c = ctx();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'CONFIRMATION_EXPIRED', message: 'Review the lineup again' }), { status: 409 })));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <LineupContext.Provider value={c}>
          <MemoryRouter initialEntries={['/lineup/acknowledge']}>
            <Routes>
              <Route path="/lineup/acknowledge" element={<Gate2Page />} />
              <Route path="/lineup" element={<p>builder</p>} />
            </Routes>
          </MemoryRouter>
        </LineupContext.Provider>
      </QueryClientProvider>
    );
    for (const b of screen.getAllByRole('checkbox')) await user.click(b);
    await user.click(screen.getByRole('button', { name: 'CONTINUE' }));
    expect(await screen.findByText('builder')).toBeInTheDocument();
    expect(c.endConfirmation).toHaveBeenCalled();
    expect(c.setFlash).toHaveBeenCalledWith('Your review expired. Review your lineup again.');
  });
});
