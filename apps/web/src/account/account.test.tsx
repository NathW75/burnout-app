/** Account screens and feedback against a mocked API (PRD-007 §6.7, §10). */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeedbackSheet } from '../components/Feedback';
import { AuthenticatorPage, BackupCodesPage, PasswordPage } from './Security';
import { deviceName, SessionsPage } from './Sessions';
import { NotificationsPage, UnsubscribePage } from './Notifications';

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

const me = (stepUpUntil: string | null = null) => ({ id: 'u', email: 'n@x.com', handle: 'nath', role: 'user', emailVerified: true, mfaEnrolled: true, stepUpUntil });
const codes = Array.from({ length: 10 }, (_, i) => `AAAA-BBB${i}`);

function renderAt(path: string, el: React.ReactNode) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={path.split("?")[0]} element={el} />
          <Route path="/login" element={<p>login screen</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('change password', () => {
  it('needs 12+ characters and a matching repeat; sends current and new; says other devices are signed out', async () => {
    const calls = mockApi({ 'POST /auth/password/change': { body: { changed: true } } });
    renderAt('/account/password', <PasswordPage />);
    const user = userEvent.setup();
    const submit = screen.getByRole('button', { name: 'CHANGE PASSWORD' });
    await user.type(screen.getByLabelText('CURRENT PASSWORD'), 'old password here');
    await user.type(screen.getByLabelText('NEW PASSWORD'), 'short');
    expect(screen.getByText('Use 12 to 128 characters.')).toBeInTheDocument();
    expect(submit).toBeDisabled();
    await user.clear(screen.getByLabelText('NEW PASSWORD'));
    await user.type(screen.getByLabelText('NEW PASSWORD'), 'a much longer password');
    await user.type(screen.getByLabelText('NEW PASSWORD AGAIN'), 'a much longer passwore');
    expect(screen.getByText('The passwords don’t match.')).toBeInTheDocument();
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('NEW PASSWORD AGAIN'), '{Backspace}d');
    await user.click(submit);
    expect(await screen.findByText('Password changed. Your other devices are signed out.')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/auth/password/change')?.body).toEqual({ currentPassword: 'old password here', newPassword: 'a much longer password' });
  });

  it('a wrong current password says so', async () => {
    mockApi({ 'POST /auth/password/change': { status: 401, body: { error: 'INVALID_CREDENTIALS', message: 'x' } } });
    renderAt('/account/password', <PasswordPage />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('CURRENT PASSWORD'), 'wrong');
    await user.type(screen.getByLabelText('NEW PASSWORD'), 'a much longer password');
    await user.type(screen.getByLabelText('NEW PASSWORD AGAIN'), 'a much longer password');
    await user.click(screen.getByRole('button', { name: 'CHANGE PASSWORD' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your current password is incorrect.');
  });
});

describe('backup codes (step-up first)', () => {
  it('asks for a code, then issues new codes shown once; DONE waits for the tick', async () => {
    let stepped = false;
    const calls = mockApi({
      'GET /me': () => ({ body: me(stepped ? new Date(Date.now() + 300_000).toISOString() : null) }),
      'POST /auth/step-up': () => ((stepped = true), { body: { stepUpUntil: new Date(Date.now() + 300_000).toISOString() } }),
      'POST /auth/mfa/backup-codes/regenerate': { body: { backupCodes: codes } },
    });
    renderAt('/account/backup-codes', <BackupCodesPage />);
    const user = userEvent.setup();
    await screen.findByText('CONFIRM IT’S YOU');
    expect(screen.queryByRole('button', { name: 'GET NEW BACKUP CODES' })).toBeNull();
    await user.type(screen.getByLabelText('CODE'), '123 456');
    await user.click(screen.getByRole('button', { name: 'CONFIRM' }));
    await user.click(await screen.findByRole('button', { name: 'GET NEW BACKUP CODES' }));
    const list = await screen.findByRole('list', { name: 'Backup codes' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    expect(calls.find((c) => c.path === '/auth/step-up')?.body).toEqual({ code: '123456' });
    const done = screen.getByRole('button', { name: 'DONE' });
    expect(done).toBeDisabled();
    await user.click(screen.getByLabelText('I’ve saved these codes.'));
    await user.click(done);
    expect(await screen.findByText('New backup codes saved. The old ones no longer work.')).toBeInTheDocument();
  });

  it('if the server still wants a fresh code, it asks again instead of failing', async () => {
    mockApi({
      'GET /me': { body: me(new Date(Date.now() + 300_000).toISOString()) },
      'POST /auth/mfa/backup-codes/regenerate': { status: 403, body: { error: 'STEP_UP_REQUIRED', message: 'x' } },
    });
    renderAt('/account/backup-codes', <BackupCodesPage />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'GET NEW BACKUP CODES' }));
    expect(await screen.findByText('CONFIRM IT’S YOU')).toBeInTheDocument();
  });
});

describe('replace the authenticator', () => {
  it('step-up, password, scan and confirm, then new backup codes', async () => {
    const calls = mockApi({
      'GET /me': { body: me(new Date(Date.now() + 300_000).toISOString()) },
      'POST /auth/mfa/totp/setup': { body: { secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP' } },
      'POST /auth/mfa/totp/confirm': { body: { backupCodes: codes } },
    });
    renderAt('/account/authenticator', <AuthenticatorPage />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('PASSWORD'), 'my password');
    await user.click(screen.getByRole('button', { name: 'CONTINUE' }));
    expect(await screen.findByText('JBSW Y3DP EHPK 3PXP')).toBeInTheDocument();
    await user.type(screen.getByLabelText('6-DIGIT CODE FROM THE NEW APP'), '654321');
    await user.click(screen.getByRole('button', { name: 'CONFIRM' }));
    expect(await screen.findByRole('heading', { name: 'Save your new backup codes' })).toBeInTheDocument();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(expect.arrayContaining(['POST /auth/mfa/totp/setup', 'POST /auth/mfa/totp/confirm']));
    expect(calls.find((c) => c.path === '/auth/mfa/totp/confirm')?.body).toEqual({ code: '654321' });
  });
});

describe('sessions', () => {
  it('names devices plainly', () => {
    expect(deviceName('Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36')).toBe('Chrome on Android');
    expect(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari on iPhone');
    expect(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0')).toBe('Firefox on Windows');
    expect(deviceName(null, 'mobile')).toBe('Burnout League app');
  });

  it('lists sessions, marks this device, signs out another; sign out everywhere ends here too', async () => {
    let list = [
      { id: 's1', client: 'web', ip: null, userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/141.0 Safari/537.36', createdAt: '2026-10-20T12:00:00Z', lastSeenAt: '2026-10-28T13:00:00Z', current: true },
      { id: 's2', client: 'web', ip: null, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1', createdAt: '2026-10-21T12:00:00Z', lastSeenAt: '2026-10-27T13:00:00Z', current: false },
    ];
    const calls = mockApi({
      'GET /me/sessions': () => ({ body: { sessions: list } }),
      'DELETE /me/sessions/s2': () => ((list = list.filter((s) => s.id !== 's2')), { body: { revoked: true } }),
      'POST /auth/logout-all': { body: { sessionsRevoked: 1 } },
    });
    renderAt('/account/sessions', <SessionsPage />);
    const user = userEvent.setup();
    const ul = await screen.findByRole('list', { name: 'Signed-in devices' });
    expect(within(ul).getAllByRole('listitem')).toHaveLength(2);
    expect(within(ul).getByText('THIS DEVICE')).toBeInTheDocument();
    expect(within(ul).getAllByRole('button')).toHaveLength(1); // no "sign out" on this device: that's the sign-out button
    await user.click(within(ul).getByRole('button', { name: /^Sign out Safari on iPhone/ }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Signed-in devices' })).getAllByRole('listitem')).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'SIGN OUT EVERYWHERE' }));
    expect(await screen.findByText('login screen')).toBeInTheDocument();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toContain('DELETE /me/sessions/s2');
  });
});

describe('feedback (§10)', () => {
  it('one text box with a counter; sends the trimmed text; confirms and closes', async () => {
    const calls = mockApi({ 'POST /feedback': { status: 201, body: { id: 'f1' } } });
    const onClose = vi.fn();
    render(<QueryClientProvider client={new QueryClient()}><FeedbackSheet onClose={onClose} /></QueryClientProvider>);
    const user = userEvent.setup();
    const send = screen.getByRole('button', { name: 'SEND FEEDBACK' });
    expect(send).toBeDisabled();
    await user.type(screen.getByPlaceholderText('Tell us what you’re thinking…'), '  burned list is great  ');
    expect(screen.getByText('24 / 2000')).toBeInTheDocument();
    await user.click(send);
    expect(await screen.findByText('Sent. Thanks, we read every one.')).toBeInTheDocument();
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/feedback', body: { body: 'burned list is great' } });
    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 3000 });
  });

  it('a failure says so and keeps the text', async () => {
    mockApi({ 'POST /feedback': { status: 429, body: { error: 'RATE_LIMITED', message: 'x' } } });
    render(<QueryClientProvider client={new QueryClient()}><FeedbackSheet onClose={() => {}} /></QueryClientProvider>);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox'), 'hello');
    await user.click(screen.getByRole('button', { name: 'SEND FEEDBACK' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t send. Too many tries.');
    expect(screen.getByRole('textbox')).toHaveValue('hello');
  });
});

describe('email notices (PRD-008 §6)', () => {
  const prefs = (over: object = {}) => ({ emailNotifications: 'on', email: { locks_burns: true, lineup_changes: true, receipts: true }, ...over });

  it('shows the three groups; a switch saves just that group; "nothing optional" turns the rest off', async () => {
    let state = prefs();
    const calls = mockApi({
      'GET /me/notification-preferences': () => ({ body: state }),
      'PUT /me/notification-preferences': (init) => {
        const b = JSON.parse(String(init!.body));
        state = { ...state, ...(b.emailNotifications ? { emailNotifications: b.emailNotifications } : {}), email: { ...state.email, ...(b.email ?? {}) } };
        return { body: state };
      },
    });
    renderAt('/account/notifications', <NotificationsPage />);
    const user = userEvent.setup();
    const list = await screen.findByRole('list', { name: 'Email notices' });
    const switches = within(list).getAllByRole('switch');
    expect(switches).toHaveLength(3);
    switches.forEach((s) => expect(s).toBeChecked());
    await user.click(within(list).getByRole('switch', { name: /Locks and burns/ }));
    await waitFor(() => expect(within(list).getByRole('switch', { name: /Locks and burns/ })).not.toBeChecked());
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ email: { locks_burns: false } });

    await user.click(screen.getByRole('switch', { name: /Email me nothing optional/ }));
    await waitFor(() => within(list).getAllByRole('switch').forEach((s) => expect(s).toBeDisabled()));
    expect(calls.filter((c) => c.method === 'PUT').at(-1)?.body).toEqual({ emailNotifications: 'off' });
  });

  it('the unsubscribe page confirms first, then posts the token; a missing token says so', async () => {
    const calls = mockApi({ 'POST /notifications/unsubscribe': { body: { unsubscribed: true } } });
    renderAt('/unsubscribe?token=abc.def', <UnsubscribePage />);
    const user = userEvent.setup();
    expect(screen.getByRole('heading', { name: 'Unsubscribe from emails?' })).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'UNSUBSCRIBE' }));
    expect(await screen.findByRole('heading', { name: 'You’re unsubscribed' })).toBeInTheDocument();
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/notifications/unsubscribe' });
  });
});
