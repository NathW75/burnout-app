/** Invite-only sign-up in the app (PRD-006 §6.10): the code field and the admin page. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignUpPage } from '../auth/pages';
import { InvitesPage } from './Invites';

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
function renderAt(path: string, el: React.ReactNode) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route path={path.split('?')[0]} element={el} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
afterEach(() => vi.unstubAllGlobals());

const me = (role = 'admin', fresh = true) => ({ id: 'u', email: 'n@x.com', handle: 'nath', role, emailVerified: true, mfaEnrolled: true, stepUpUntil: fresh ? new Date(Date.now() + 300_000).toISOString() : null });

describe('sign-up with an invite', () => {
  it('when invite-only, asks for the code, fills it from the link, and sends it', async () => {
    const calls = mockApi({ 'GET /auth/signup-config': { body: { inviteOnly: true } }, 'POST /auth/signup': { status: 202, body: { status: 'verification_sent' } } });
    renderAt('/signup?invite=7KX2M-QW9TD', <SignUpPage />);
    const user = userEvent.setup();
    const code = await screen.findByLabelText('INVITE CODE');
    expect(code).toHaveValue('7KX2M-QW9TD');
    await user.type(screen.getByLabelText('EMAIL'), 'bro@example.com');
    await user.type(screen.getByLabelText('PASSWORD'), 'correct horse battery');
    await user.type(screen.getByLabelText('HANDLE'), 'bro');
    await user.clear(code);
    await user.type(code, '7KX2M');
    expect(screen.getByRole('button', { name: 'CREATE ACCOUNT' })).toBeDisabled();
    await user.type(code, '-QW9TD');
    await user.click(screen.getByRole('button', { name: 'CREATE ACCOUNT' }));
    await screen.findByRole('heading', { name: 'Check your email' });
    expect(calls.find((c) => c.path === '/auth/signup')?.body).toMatchObject({ email: 'bro@example.com', handle: 'bro', inviteCode: '7KX2M-QW9TD' });
  });

  it('when sign-up is open, there is no code field and none is sent', async () => {
    const calls = mockApi({ 'GET /auth/signup-config': { body: { inviteOnly: false } }, 'POST /auth/signup': { status: 202, body: {} } });
    renderAt('/signup', <SignUpPage />);
    const user = userEvent.setup();
    await waitFor(() => expect(calls.some((c) => c.path === '/auth/signup-config')).toBe(true));
    expect(screen.queryByLabelText('INVITE CODE')).toBeNull();
    await user.type(screen.getByLabelText('EMAIL'), 'a@example.com');
    await user.type(screen.getByLabelText('PASSWORD'), 'correct horse battery');
    await user.type(screen.getByLabelText('HANDLE'), 'abc');
    await user.click(screen.getByRole('button', { name: 'CREATE ACCOUNT' }));
    await screen.findByRole('heading', { name: 'Check your email' });
    expect(calls.find((c) => c.path === '/auth/signup')?.body).not.toHaveProperty('inviteCode');
  });
});

describe('admin invites', () => {
  it('makes a code (shown once, with the sign-up link), lists invites, and revokes an active one', async () => {
    let invites: Array<Record<string, unknown>> = [{ id: 'i1', email: null, note: 'old', createdAt: '2026-10-27T12:00:00Z', expiresAt: null, usedAt: '2026-10-28T13:53:00Z', usedBy: 'Watty18', status: 'used' }];
    const calls = mockApi({
      'GET /me': { body: me() },
      'GET /admin/helpers': { body: { helpers: [] } },
      'GET /admin/invites': () => ({ body: { inviteOnly: true, invites } }),
      'POST /admin/invites': (init) => {
        const b = JSON.parse(String(init!.body));
        invites = [{ id: 'i2', email: b.email, note: b.note, createdAt: new Date().toISOString(), expiresAt: null, usedAt: null, usedBy: null, status: 'active' }, ...invites];
        return { status: 201, body: { id: 'i2', code: 'ABCDE-FGH12', link: 'https://app.example/signup?invite=ABCDE-FGH12', email: b.email, expiresAt: null } };
      },
      'POST /admin/invites/i2/revoke': () => ((invites = invites.map((i) => (i.id === 'i2' ? { ...i, status: 'revoked' } : i))), { body: { revoked: true } }),
    });
    renderAt('/admin/invites', <InvitesPage />);
    const user = userEvent.setup();
    expect(await screen.findByText(/Sign-up is invite-only here/)).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Invites' })).getByText('USED · Watty18')).toBeInTheDocument();
    await user.type(screen.getByLabelText('THEIR EMAIL (OPTIONAL)'), 'cousin@example.com');
    await user.type(screen.getByLabelText('NOTE (OPTIONAL)'), 'cousin');
    await user.click(screen.getByRole('checkbox', { name: 'Email the invite to them' })); // just the code this time
    await user.click(screen.getByRole('button', { name: 'MAKE CODE' }));
    expect(await screen.findByText('ABCDE-FGH12')).toBeInTheDocument();
    expect(screen.getByText('https://app.example/signup?invite=ABCDE-FGH12')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST' && c.path === '/admin/invites')?.body).toEqual({ email: 'cousin@example.com', note: 'cousin', expiresInDays: 14 });
    await user.click(await screen.findByRole('button', { name: 'Revoke invite for cousin@example.com, cousin' }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Invites' })).getByText('REVOKED')).toBeInTheDocument());
  });

  it('with an email, sends the invite by default and says so; a failed send keeps the code on screen to pass on', async () => {
    let emailed = true;
    const calls = mockApi({
      'GET /me': { body: me() },
      'GET /admin/helpers': { body: { helpers: [] } },
      'GET /admin/invites': { body: { inviteOnly: true, invites: [] } },
      'POST /admin/invites': (init) => {
        const b = JSON.parse(String(init!.body));
        return { status: 201, body: { id: 'i3', code: 'KQ7MX-2PRT9', link: 'https://app.example/signup?invite=KQ7MX-2PRT9', email: b.email, expiresAt: null, ...(b.send ? { emailed } : {}) } };
      },
    });
    renderAt('/admin/invites', <InvitesPage />);
    const user = userEvent.setup();
    await screen.findByText(/Sign-up is invite-only here/);
    expect(screen.queryByRole('checkbox', { name: 'Email the invite to them' })).toBeNull(); // no email yet: nothing to send to
    expect(screen.getByRole('button', { name: 'MAKE CODE' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('THEIR EMAIL (OPTIONAL)'), 'sam@example.com');
    expect(screen.getByRole('checkbox', { name: 'Email the invite to them' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'SEND INVITE' }));
    expect(await screen.findByText('SENT · INVITE EMAILED TO SAM@EXAMPLE.COM')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST' && c.path === '/admin/invites')?.body).toMatchObject({ email: 'sam@example.com', send: true });

    emailed = false;
    await user.type(screen.getByLabelText('THEIR EMAIL (OPTIONAL)'), 'pat@example.com');
    await user.click(screen.getByRole('button', { name: 'SEND INVITE' }));
    expect(await screen.findByText(/Couldn’t send the email. The code still works/)).toBeInTheDocument();
    expect(screen.getByText('KQ7MX-2PRT9')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'COPY SIGN-UP LINK' })).toBeInTheDocument();
  });

  it('asks for a fresh code first, and a non-admin is told no', async () => {
    mockApi({ 'GET /me': { body: me('admin', false) } });
    renderAt('/admin/invites', <InvitesPage />);
    expect(await screen.findByText('CONFIRM IT’S YOU')).toBeInTheDocument();
    vi.unstubAllGlobals();
    mockApi({ 'GET /me': { body: me('user') } });
    renderAt('/admin/invites', <InvitesPage />);
    expect(await screen.findByText('Only an admin or an invite helper can make sign-up codes.')).toBeInTheDocument();
  });

  it('an invite helper (Nath, 2026-10-30) makes codes and sees their own; no helpers section, nothing else admin', async () => {
    const calls = mockApi({
      'GET /me': { body: me('recruiter') },
      'GET /admin/invites': { body: { inviteOnly: true, invites: [{ id: 'm1', email: 'pal@example.com', note: 'league', createdAt: '2026-10-30T19:00:00Z', expiresAt: null, usedAt: null, usedBy: null, status: 'active', madeBy: null }] } },
    });
    renderAt('/admin/invites', <InvitesPage />);
    expect(await screen.findByText(/You see the codes you made\./)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /YOUR INVITES/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'MAKE CODE' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Invite helpers' })).toBeNull();
    expect(screen.queryByText(/INVITE HELPERS/)).toBeNull();
    expect(calls.some((c) => c.path === '/admin/helpers')).toBe(false);
  });

  it('the admin chooses invite helpers (signed-up accounts only), removes them, and sees who made each code', async () => {
    let helpers: Array<{ id: string; email: string; handle: string | null }> = [];
    const calls = mockApi({
      'GET /me': { body: me() },
      'GET /admin/invites': { body: { inviteOnly: true, invites: [{ id: 'm1', email: null, note: null, createdAt: '2026-10-30T19:00:00Z', expiresAt: null, usedAt: null, usedBy: null, status: 'active', madeBy: 'michael' }] } },
      'GET /admin/helpers': () => ({ body: { helpers } }),
      'POST /admin/helpers': (init) => {
        const b = JSON.parse(String(init!.body));
        if (b.email !== 'michael@example.com') return { status: 404, body: { error: 'NO_ACCOUNT', message: 'x' } };
        helpers = [{ id: 'h1', email: b.email, handle: 'michael' }];
        return { status: 201, body: helpers[0] };
      },
      'POST /admin/helpers/h1/remove': () => ((helpers = []), { body: { removed: true } }),
    });
    renderAt('/admin/invites', <InvitesPage />);
    const user = userEvent.setup();
    expect(await screen.findByText(/by michael/)).toBeInTheDocument();
    const section = screen.getByRole('region', { name: 'Invite helpers' });
    await user.type(within(section).getByLabelText('THEIR ACCOUNT EMAIL'), 'nobody@example.com');
    await user.click(within(section).getByRole('button', { name: 'ADD HELPER' }));
    expect(await within(section).findByText(/No account with that email yet/)).toBeInTheDocument();
    await user.clear(within(section).getByLabelText('THEIR ACCOUNT EMAIL'));
    await user.type(within(section).getByLabelText('THEIR ACCOUNT EMAIL'), 'michael@example.com');
    await user.click(within(section).getByRole('button', { name: 'ADD HELPER' }));
    const list = await within(section).findByRole('list', { name: 'Current invite helpers' });
    expect(within(list).getByText('michael')).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Remove michael as an invite helper' }));
    await waitFor(() => expect(within(section).queryByRole('list', { name: 'Current invite helpers' })).toBeNull());
    expect(calls.filter((c) => c.method === 'POST' && c.path.startsWith('/admin/helpers')).map((c) => c.path)).toEqual(['/admin/helpers', '/admin/helpers', '/admin/helpers/h1/remove']);
  });
});
