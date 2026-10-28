/** The tabs stay on screen while a signed-in screen's code is still loading (PRD-007 §6.2.1, patch c). */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { lazy, Suspense } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from './layout';

afterEach(() => vi.unstubAllGlobals());

describe('app shell', () => {
  it('a screen whose code is still loading shows the loading state with the tabs, not a bare spinner', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [], unread: 0, players: {}, nextBefore: null }), { status: 200 })));
    const NeverLoads = lazy(() => new Promise<{ default: () => null }>(() => {}));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/account/connector']}>
          <Suspense fallback={<p>outside the shell</p>}>
            <AppShell>
              <NeverLoads />
            </AppShell>
          </Suspense>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('navigation', { name: 'Main' })).toBeTruthy();
    expect(screen.queryByText('outside the shell')).toBeNull();
    expect(screen.getByRole('link', { name: /ACCOUNT/ }).className).toMatch(/text-accent/);
  });
});
