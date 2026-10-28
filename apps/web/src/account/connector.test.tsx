/** Account → AI connector (PRD-011 §5.2): make, copy, list and revoke personal tokens. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorPage, MCP_URL } from './Connector';

type Reply = { status?: number; body: unknown } | ((init?: RequestInit) => { status?: number; body: unknown });
function mockApi(routes: Record<string, Reply>) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v1/, '');
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const r = routes[`${method} ${path}`];
    if (!r) return new Response(JSON.stringify({ error: 'NOT_FOUND', message: path }), { status: 404 });
    const out = typeof r === 'function' ? r(init) : r;
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200 });
  }));
  return calls;
}
function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/account/connector']}>
        <Routes><Route path="/account/connector" element={<ConnectorPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
afterEach(() => vi.unstubAllGlobals());

const me = (fresh = true) => ({ id: 'u', email: 'n@x.com', handle: 'nath', role: 'user', emailVerified: true, mfaEnrolled: true, stepUpUntil: fresh ? new Date(Date.now() + 300_000).toISOString() : null });
const TOKEN = `bl_mcp_${'a'.repeat(64)}`;
const row = (over: object = {}) => ({ id: 't1', label: 'Claude Code', createdAt: '2026-10-28T19:00:00Z', expiresAt: '2027-01-26T19:00:00Z', lastUsedAt: null, ...over });

describe('AI connector', () => {
  it('shows the server address; makes a token with a name, shows it once with copy; lists and revokes', async () => {
    let tokens = [] as ReturnType<typeof row>[];
    const calls = mockApi({
      'GET /me': { body: me() },
      'GET /me/mcp': () => ({ body: { tokens, maxTokens: 5 } }),
      'POST /me/mcp/tokens': () => { tokens = [row()]; return { status: 201, body: { token: TOKEN, credential: row() } }; },
      'DELETE /me/mcp/tokens/t1': () => { tokens = []; return { body: { revoked: true } }; },
    });
    renderPage();
    const user = userEvent.setup();
    expect(screen.getByText(MCP_URL)).toBeInTheDocument();
    expect(MCP_URL).toMatch(/\/mcp$/);
    expect(await screen.findByText('No tokens yet.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('NAME (OPTIONAL)'), 'Claude Code');
    await user.click(screen.getByRole('button', { name: 'MAKE TOKEN' }));
    expect(await screen.findByText(TOKEN)).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ label: 'Claude Code' });
    await user.click(screen.getByRole('button', { name: 'COPY TOKEN' }));
    expect(await navigator.clipboard.readText()).toBe(TOKEN);
    expect(screen.getByRole('button', { name: 'COPIED' })).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Tokens' });
    expect(within(list).getByText('Claude Code')).toBeInTheDocument();
    expect(within(list).getByText(/Not used yet/)).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Revoke Claude Code' }));
    await waitFor(() => expect(screen.getByText('No tokens yet.')).toBeInTheDocument());
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/me/mcp/tokens/t1')).toBe(true);
  });

  it('without a fresh code, asks for one instead of the form; the list still shows', async () => {
    mockApi({ 'GET /me': { body: me(false) }, 'GET /me/mcp': { body: { tokens: [row({ lastUsedAt: '2026-10-28T20:00:00Z' })], maxTokens: 5 } } });
    renderPage();
    expect(await screen.findByText(/^Making a token needs a fresh code\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'MAKE TOKEN' })).not.toBeInTheDocument();
    expect(await screen.findByText(/Last used/)).toBeInTheDocument();
  });

  it('at five tokens, says to revoke one first', async () => {
    mockApi({ 'GET /me': { body: me() }, 'GET /me/mcp': { body: { tokens: [1, 2, 3, 4, 5].map((i) => row({ id: `t${i}`, label: `t${i}` })), maxTokens: 5 } } });
    renderPage();
    expect(await screen.findByText(/You have 5 tokens, the most allowed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'MAKE TOKEN' })).not.toBeInTheDocument();
  });
});
