/** Admin → Feedback (PRD-007 §10): read, filter and review tester feedback. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeedbackAdminPage } from './Feedback';

type Reply = { status?: number; body: unknown } | ((url: URL, init?: RequestInit) => { status?: number; body: unknown });
function mockApi(routes: Record<string, Reply>) {
  const calls: Array<{ method: string; path: string; search: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v1/, '');
    const method = init?.method ?? 'GET';
    calls.push({ method, path, search: url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const r = routes[`${method} ${path}`] ?? Object.entries(routes).find(([k]) => k.endsWith('*') && `${method} ${path}`.startsWith(k.slice(0, -1)))?.[1];
    if (!r) return new Response(JSON.stringify({ error: 'NOT_FOUND', message: path }), { status: 404 });
    const out = typeof r === 'function' ? r(url, init) : r;
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200 });
  }));
  return calls;
}
function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/admin/feedback']}>
        <Routes><Route path="/admin/feedback" element={<FeedbackAdminPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
afterEach(() => vi.unstubAllGlobals());

const me = (role = 'admin', fresh = true) => ({ id: 'u', email: 'n@x.com', handle: 'nath', role, emailVerified: true, mfaEnrolled: true, stepUpUntil: fresh ? new Date(Date.now() + 300_000).toISOString() : null });
const item = (over: object = {}) => ({
  id: 'f1', submittedAt: '2026-10-29T17:30:00Z', handle: 'Watty18', displayName: 'Watty', screen: 'lineup_builder',
  body: 'The FLEX picker\nwon’t scroll', tags: { category: 'bug', severity: 'high', summary: 'FLEX picker doesn’t scroll.', screen_relevant: true }, reviewed: false, ...over,
});

describe('admin feedback', () => {
  it('lists unreviewed feedback with the tags, the full text and who sent it; mark reviewed; filters go to the API', async () => {
    let reviewed = false;
    const calls = mockApi({
      'GET /me': { body: me() },
      'GET /admin/feedback': (url) => ({
        body: {
          items: [
            item({ reviewed }),
            item({ id: 'f2', handle: null, displayName: 'New Tester', screen: 'this_week', body: 'love it', tags: null }),
          ].filter((i) => url.searchParams.get('reviewed') !== 'false' || !i.reviewed),
          nextBefore: null,
        },
      }),
      'POST /admin/feedback/f1/review': () => { reviewed = true; return { body: { reviewed: true } }; },
    });
    renderPage();
    const user = userEvent.setup();
    const list = await screen.findByRole('list', { name: 'Feedback' });
    expect(calls.find((c) => c.path === '/admin/feedback')?.search).toContain('reviewed=false');
    const [first, second] = within(list).getAllByRole('listitem');
    expect(first).toHaveTextContent('BUG');
    expect(first).toHaveTextContent('HIGH');
    expect(first).toHaveTextContent('FLEX picker doesn’t scroll.');
    expect(first).toHaveTextContent('Watty18 · lineup_builder');
    expect(within(first).getByText(/The FLEX picker/)).toHaveTextContent('The FLEX picker won’t scroll');
    expect(second).toHaveTextContent('NOT TAGGED');
    expect(second).toHaveTextContent('New Tester · this_week');

    await user.click(within(first).getByRole('button', { name: 'MARK REVIEWED' }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Feedback' })).getAllByRole('listitem')).toHaveLength(1));
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ path: '/admin/feedback/f1/review', body: { reviewed: true } });

    await user.click(screen.getByRole('button', { name: 'ALL' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Category' }), 'bug');
    await waitFor(() => expect(calls.at(-1)?.search).toContain('category=bug'));
    expect(calls.at(-1)?.search).not.toContain('reviewed=');
  });

  it('asks for a fresh code first, and loads nothing until then', async () => {
    const calls = mockApi({ 'GET /me': { body: me('admin', false) } });
    renderPage();
    expect(await screen.findByText(/^Reading feedback needs a fresh code\./)).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/admin/feedback')).toBe(false);
  });

  it('non-admins are told no', async () => {
    mockApi({ 'GET /me': { body: me('user') } });
    renderPage();
    expect(await screen.findByText('Only an admin can read feedback.')).toBeInTheDocument();
  });

  it('nothing waiting says so', async () => {
    mockApi({ 'GET /me': { body: me() }, 'GET /admin/feedback': { body: { items: [], nextBefore: null } } });
    renderPage();
    expect(await screen.findByText('Nothing waiting. Every piece of feedback has been reviewed.')).toBeInTheDocument();
  });
});
