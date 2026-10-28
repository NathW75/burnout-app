/**
 * Account → Notifications (PRD-008 §6, §9): which notices also come by email
 * or as a push notification. The in-app inbox always gets everything.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api/client';
import { AuthLayout } from '../auth/AuthLayout';
import { ErrorNote, Loading, Notice, SectionTitle, useScreen } from '../components/layout';
import { errorText } from '../lib/errors';
import { disablePush, enablePush, pushSupport, PushPermissionError, syncPush, type PushConfig, type PushSupport } from '../lib/push';
import { AccountSubPage } from './Security';

export type EmailGroup = 'locks_burns' | 'lineup_changes' | 'receipts';
export interface NotificationPreferences {
  emailNotifications: 'on' | 'off';
  email: Record<EmailGroup, boolean>;
  push: Record<EmailGroup, boolean>;
}
type Change = Partial<{ emailNotifications: 'on' | 'off'; email: Partial<Record<EmailGroup, boolean>>; push: Partial<Record<EmailGroup, boolean>> }>;

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
    mutationFn: (change: Change) =>
      api<NotificationPreferences>('/me/notification-preferences', { method: 'PUT', body: change }),
    onSuccess: (data) => qc.setQueryData(KEY, data),
  });
  const p = save.data ?? prefs.data;
  const allOff = p?.emailNotifications === 'off';
  return (
    <AccountSubPage
      title="NOTIFICATIONS"
      heading="Email and push"
      intro="Everything always lands in your inbox in the app. Choose what also comes by email or as a push notification. Times are Eastern (ET)."
    >
      {prefs.error && <ErrorNote>{errorText(prefs.error)}</ErrorNote>}
      {!p ? (
        <Loading />
      ) : (
        <>
          <SectionTitle>EMAIL</SectionTitle>
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
              <span id="all-off-note" className="text-[13px] leading-[1.45] text-muted">Stops every email above. Account emails (sign-in links, security notices) still come.</span>
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
          <PushSection prefs={p} saving={save.isPending} onChange={(push) => save.mutate({ push })} />
          <ErrorNote>{save.isError ? errorText(save.error) : null}</ErrorNote>
          {save.isSuccess && <p role="status" className="m-0 text-[13px] text-muted">Saved.</p>}
        </>
      )}
    </AccountSubPage>
  );
}

const PUSH_DEVICE = ['push-device'];

/** Push (PRD-008 §9): turn it on for this device, and choose what it sends to every device. Hidden where push is off. */
function PushSection({ prefs, saving, onChange }: { prefs: NotificationPreferences; saving: boolean; onChange: (push: Partial<Record<EmailGroup, boolean>>) => void }) {
  const qc = useQueryClient();
  const config = useQuery({ queryKey: ['push-config'], queryFn: () => api<PushConfig>('/push/config'), staleTime: 5 * 60_000 });
  const [support, setSupport] = useState<PushSupport>(pushSupport);
  const enabled = !!config.data?.enabled && !!config.data.publicKey;
  // Re-saving an existing subscription keeps this device pointed at whoever is signed in.
  const device = useQuery({ queryKey: PUSH_DEVICE, queryFn: syncPush, enabled: enabled && support === 'ready', retry: false });
  const toggle = useMutation({
    mutationFn: async (on: boolean) => {
      if (on) await enablePush(config.data!.publicKey!);
      else await disablePush();
      return on;
    },
    onSuccess: (on) => qc.setQueryData(PUSH_DEVICE, on),
    onError: () => setSupport(pushSupport()),
  });
  if (!enabled) return null;
  const on = device.data === true;

  let deviceBody: ReactNode;
  if (support === 'ios-install') {
    deviceBody = (
      <p className="m-0 text-[13px] leading-[1.45] text-muted">
        On iPhone and iPad, push works from the Home Screen app. In Safari, tap <b className="text-type">Share</b>, then <b className="text-type">Add to Home Screen</b>. Open Burnout from there and turn this on.
      </p>
    );
  } else if (support === 'unsupported') {
    deviceBody = <p className="m-0 text-[13px] leading-[1.45] text-muted">This browser can’t show push notifications. Email and the inbox still work.</p>;
  } else if (support === 'denied') {
    deviceBody = <p className="m-0 text-[13px] leading-[1.45] text-muted">Notifications are blocked for this site. Allow them in your browser’s site settings, then come back here.</p>;
  } else {
    deviceBody = (
      <>
        <p className="m-0 text-[13px] leading-[1.45] text-muted" role="status">
          {device.isPending ? 'Checking this device…' : on ? 'Push is on for this device.' : 'Push is off for this device.'}
        </p>
        <button
          type="button"
          className={`${on ? 'btn-outline' : 'btn-primary'} min-h-11 self-start px-4 disabled:opacity-60`}
          disabled={toggle.isPending || device.isPending}
          onClick={() => toggle.mutate(!on)}
        >
          {toggle.isPending ? 'ONE MOMENT…' : on ? 'TURN OFF ON THIS DEVICE' : 'TURN ON FOR THIS DEVICE'}
        </button>
      </>
    );
  }
  const err = toggle.error instanceof PushPermissionError
    ? toggle.error.permission === 'denied' ? null /* the blocked note says it */ : 'You didn’t allow notifications. Tap the button again to choose Allow.'
    : toggle.isError ? errorText(toggle.error) : null;

  return (
    <>
      <div className="pt-2"><SectionTitle>PUSH</SectionTitle></div>
      <div className="flex flex-col gap-3 rounded-sm border border-rule bg-paper px-[14px] py-3">
        <span className="font-mono text-[11px] tracking-[1px] text-muted">THIS DEVICE</span>
        {deviceBody}
        <ErrorNote>{err}</ErrorNote>
      </div>
      <ul className="m-0 flex list-none flex-col overflow-hidden rounded-sm border border-rule p-0" aria-label="Push notices">
        {GROUPS.map((g, i) => (
          <li key={g.key} className={`bg-paper ${i === GROUPS.length - 1 ? '' : 'border-b border-rule'}`}>
            <label className="flex cursor-pointer items-start justify-between gap-4 px-[14px] py-3">
              <span className="flex flex-col gap-[2px]">
                <span className="text-[15px] font-semibold">{g.title}</span>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="mt-1 size-6 flex-none accent-accent"
                checked={prefs.push[g.key]}
                disabled={saving}
                onChange={(e) => onChange({ [g.key]: e.target.checked })}
              />
            </label>
          </li>
        ))}
      </ul>
      <p className="m-0 text-[12px] leading-[1.45] text-muted">These apply to every device with push on. “Email me nothing optional” doesn’t turn push off.</p>
    </>
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
      intro={done ? 'We won’t send optional emails anymore. Account emails still come. Everything stays in your inbox in the app.' : 'This stops lock, burn, lineup-change and receipt emails. Your inbox in the app keeps everything.'}
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
