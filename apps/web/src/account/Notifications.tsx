/**
 * Account → Notifications (PRD-008 §6): which notices also come by email.
 * The in-app inbox always gets everything.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api/client';
import { AuthLayout } from '../auth/AuthLayout';
import { ErrorNote, Loading, Notice, useScreen } from '../components/layout';
import { errorText } from '../lib/errors';
import { AccountSubPage } from './Security';

export type EmailGroup = 'locks_burns' | 'lineup_changes' | 'receipts';
export interface NotificationPreferences {
  emailNotifications: 'on' | 'off';
  email: Record<EmailGroup, boolean>;
}

const GROUPS: Array<{ key: EmailGroup; title: string; detail: string }> = [
  { key: 'locks_burns', title: 'Locks and burns', detail: 'When a window locks with your players, and when they burn.' },
  { key: 'lineup_changes', title: 'Lineup changes we made', detail: 'A pick voided (Out, no game), moved to another game, or a slot reopened. Sent right away so you can re-pick.' },
  { key: 'receipts', title: 'Lineup receipts', detail: 'Your copy of each confirmed lineup, with its checksum.' },
];

const KEY = ['notification-preferences'];

export function NotificationsPage() {
  useScreen('account_notifications', 'Notifications');
  const qc = useQueryClient();
  const prefs = useQuery({ queryKey: KEY, queryFn: () => api<NotificationPreferences>('/me/notification-preferences') });
  const save = useMutation({
    mutationFn: (change: Partial<{ emailNotifications: 'on' | 'off'; email: Partial<Record<EmailGroup, boolean>> }>) =>
      api<NotificationPreferences>('/me/notification-preferences', { method: 'PUT', body: change }),
    onSuccess: (data) => qc.setQueryData(KEY, data),
  });
  const p = save.data ?? prefs.data;
  const allOff = p?.emailNotifications === 'off';
  return (
    <AccountSubPage
      title="NOTIFICATIONS"
      heading="Email notices"
      intro="Everything always lands in your inbox in the app. Choose what also comes by email. Times are Eastern (ET)."
    >
      {prefs.error && <ErrorNote>{errorText(prefs.error)}</ErrorNote>}
      {!p ? (
        <Loading />
      ) : (
        <>
          <ul className="m-0 flex list-none flex-col overflow-hidden rounded-sm border border-rule p-0" aria-label="Email notices">
            {GROUPS.map((g, i) => (
              <li key={g.key} className={`bg-paper ${i === GROUPS.length - 1 ? '' : 'border-b border-rule'}`}>
                <label className={`flex cursor-pointer items-start justify-between gap-4 px-[14px] py-3 ${allOff ? 'opacity-60' : ''}`}>
                  <span className="flex flex-col gap-[2px]">
                    <span className="text-[15px] font-semibold">{g.title}</span>
                    <span className="text-[13px] leading-[1.45] text-muted">{g.detail}</span>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    className="mt-1 size-6 flex-none accent-accent"
                    checked={!allOff && p.email[g.key]}
                    disabled={allOff || save.isPending}
                    onChange={(e) => save.mutate({ email: { [g.key]: e.target.checked } })}
                    aria-describedby={allOff ? 'all-off-note' : undefined}
                  />
                </label>
              </li>
            ))}
          </ul>
          <label className="flex cursor-pointer items-start justify-between gap-4 rounded-sm border border-rule bg-paper px-[14px] py-3">
            <span className="flex flex-col gap-[2px]">
              <span className="text-[15px] font-semibold">Email me nothing optional</span>
              <span id="all-off-note" className="text-[13px] leading-[1.45] text-muted">Stops every email above. Account and payment emails (sign-in links, receipts for money) still come.</span>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="mt-1 size-6 flex-none accent-accent"
              checked={allOff}
              disabled={save.isPending}
              onChange={(e) => save.mutate({ emailNotifications: e.target.checked ? 'off' : 'on' })}
            />
          </label>
          <ErrorNote>{save.isError ? errorText(save.error) : null}</ErrorNote>
          {save.isSuccess && <p role="status" className="m-0 text-[13px] text-muted">Saved.</p>}
        </>
      )}
    </AccountSubPage>
  );
}

/** The footer link in every notice email: confirm, then turn optional email off (PRD-008 §5). */
export function UnsubscribePage() {
  useScreen('unsubscribe', 'Unsubscribe');
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [done, setDone] = useState(false);
  const go = useMutation({
    mutationFn: () => api<{ unsubscribed: boolean }>(`/notifications/unsubscribe?token=${encodeURIComponent(token)}`, { method: 'POST' }),
    onSuccess: () => setDone(true),
  });
  return (
    <AuthLayout
      title={done ? 'You’re unsubscribed' : 'Unsubscribe from emails?'}
      intro={done ? 'We won’t send optional emails anymore. Account and payment emails still come. Everything stays in your inbox in the app.' : 'This stops lock, burn, lineup-change and receipt emails. Your inbox in the app keeps everything.'}
    >
      {done ? (
        <Notice>
          Changed your mind? Turn emails back on in <Link to="/account/notifications">Account → Notifications</Link>.
        </Notice>
      ) : (
        <>
          <ErrorNote>{!token ? 'This link is missing its code. Use the link from the email.' : go.isError ? errorText(go.error) : null}</ErrorNote>
          <button type="button" className="btn-primary disabled:opacity-60" disabled={!token || go.isPending} onClick={() => go.mutate()}>
            {go.isPending ? 'ONE MOMENT…' : 'UNSUBSCRIBE'}
          </button>
          <Link to="/" className="text-[14px]">Keep my emails</Link>
        </>
      )}
    </AuthLayout>
  );
}
