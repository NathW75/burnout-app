/**
 * Account (PRD-007 §6.7): profile and handle, security (password,
 * authenticator, backup codes, sessions), receipts, appearance, sign out.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../api/client';
import { qk, useMe } from '../api/hooks';
import { SubmitButton, TextField } from '../auth/AuthLayout';
import { ErrorNote, SectionTitle, TabPage, useScreen } from '../components/layout';
import { errorText } from '../lib/errors';
import { useThemePref, type ThemePref } from '../lib/theme';

export function AccountPage() {
  useScreen('account', 'Account');
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const done = () => {
    qc.clear();
    navigate('/login', { replace: true });
  };
  const out = useMutation({ mutationFn: () => api('/auth/logout', { method: 'POST' }), onSettled: done });
  return (
    <TabPage>
      <section className="flex flex-col gap-2 px-4 pt-[22px]">
        <h1 className="m-0 font-mono text-[40px] leading-none font-medium tracking-[-1px]">Account</h1>
      </section>

      <section className="flex flex-col gap-3 px-4 pt-6">
        <SectionTitle>PROFILE</SectionTitle>
        <dl className="m-0 grid gap-3 rounded-sm border border-rule bg-paper p-[14px]">
          <HandleRow handle={me.data?.handle ?? null} />
          <div className="flex flex-col gap-[2px]">
            <dt className="font-mono text-[11px] text-muted">EMAIL (PRIVATE)</dt>
            <dd className="m-0 text-[15px] break-all">{me.data?.email}</dd>
          </div>
        </dl>
      </section>

      <section className="flex flex-col gap-3 px-4 pt-6">
        <SectionTitle>SECURITY</SectionTitle>
        <ul className="m-0 flex list-none flex-col overflow-hidden rounded-sm border border-rule p-0" aria-label="Security">
          <Row to="/account/password" title="Password" detail="Change it; signs out your other devices" />
          <Row to="/account/authenticator" title="Authenticator app" detail={me.data?.mfaEnrolled ? 'On. Replace it for a new phone' : 'Not set up'} />
          <Row to="/account/backup-codes" title="Backup codes" detail="Get new codes; the old ones stop working" />
          <Row to="/account/sessions" title="Sessions" detail="Where you’re signed in" last />
        </ul>
      </section>

      <section className="flex flex-col gap-3 px-4 pt-6">
        <SectionTitle>NOTIFICATIONS</SectionTitle>
        <ul className="m-0 flex list-none flex-col overflow-hidden rounded-sm border border-rule p-0" aria-label="Notifications">
          <Row to="/account/notifications" title="Email notices" detail="Locks, burns, lineup changes and receipts" last />
        </ul>
      </section>

      <section className="flex flex-col gap-3 px-4 pt-6">
        <SectionTitle>LINEUPS</SectionTitle>
        <ul className="m-0 flex list-none flex-col overflow-hidden rounded-sm border border-rule p-0" aria-label="Lineups">
          <Row to="/account/receipts" title="Receipts" detail="Every confirmed lineup, with its checksum" last />
        </ul>
      </section>

      <section className="flex flex-col gap-3 px-4 pt-6">
        <SectionTitle>APPEARANCE</SectionTitle>
        <ThemeChoice />
      </section>

      <section className="flex flex-col gap-3 px-4 pt-6">
        <SectionTitle>RULES AND HELP</SectionTitle>
        <Link to="/help" className="btn-outline min-h-12 no-underline">THE RULES</Link>
      </section>

      <section className="flex flex-col gap-3 px-4 pt-6">
        <SectionTitle>SIGN OUT</SectionTitle>
        <button type="button" className="btn-outline min-h-12" onClick={() => out.mutate()} disabled={out.isPending}>SIGN OUT</button>
        <p className="m-0 text-[13px] text-muted">To sign out every device at once, use <Link to="/account/sessions">Sessions</Link>.</p>
      </section>
    </TabPage>
  );
}

function Row({ to, title, detail, last }: { to: string; title: string; detail: ReactNode; last?: boolean }) {
  return (
    <li className={last ? '' : 'border-b border-rule'}>
      <Link to={to} className="flex items-center justify-between gap-3 bg-paper px-[14px] py-3 text-type no-underline hover:bg-newsprint">
        <span className="flex min-w-0 flex-col gap-[2px]">
          <span className="text-[15px] font-semibold">{title}</span>
          <span className="text-[12px] text-muted">{detail}</span>
        </span>
        <span aria-hidden="true" className="font-mono text-[16px] text-muted">›</span>
      </Link>
    </li>
  );
}

/** Handle: public, 3–20 letters, numbers or underscores; two changes a season (PRD-003). */
function HandleRow({ handle }: { handle: string | null }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const save = useMutation({
    mutationFn: () => api<{ handle: string }>('/me/handle', { method: 'PUT', body: { handle: value.trim() } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.me, refetchType: 'all' });
      void qc.invalidateQueries({ queryKey: ['fieldBoard'] });
      void qc.invalidateQueries({ queryKey: ['fieldMe'] });
      setEditing(false);
    },
  });
  const valid = /^[A-Za-z0-9_]{3,20}$/.test(value.trim());
  if (!editing) {
    return (
      <div className="flex items-end justify-between gap-3">
        <div className="flex flex-col gap-[2px]">
          <dt className="font-mono text-[11px] text-muted">HANDLE (PUBLIC)</dt>
          <dd className="m-0 text-[15px] font-semibold">{handle ?? '—'}</dd>
        </div>
        <button type="button" className="btn-outline px-3" onClick={() => (setValue(handle ?? ''), save.reset(), setEditing(true))}>CHANGE</button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <dt className="sr-only">Handle (public)</dt>
      <dd className="m-0">
        <form onSubmit={(e) => (e.preventDefault(), save.mutate())} className="flex flex-col gap-3" noValidate>
          <TextField
            label="New handle"
            autoComplete="username"
            maxLength={20}
            required
            value={value}
            onChange={(e) => setValue(e.target.value)}
            hint="3–20 letters, numbers or underscores. Shown on the standings. Two changes per season."
          />
          <ErrorNote>{save.isError ? errorText(save.error) : null}</ErrorNote>
          <div className="flex gap-2">
            <button type="button" className="btn-outline flex-1" onClick={() => setEditing(false)}>CANCEL</button>
            <div className="flex-1"><SubmitButton busy={save.isPending} disabled={!valid || value.trim() === handle}>SAVE</SubmitButton></div>
          </div>
        </form>
      </dd>
    </div>
  );
}

const THEMES: Array<{ value: ThemePref; label: string }> = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'Match device' },
];

function ThemeChoice() {
  const [pref, setPref] = useThemePref();
  return (
    <fieldset className="m-0 grid grid-cols-3 gap-2 border-0 p-0">
      <legend className="sr-only">Theme</legend>
      {THEMES.map((t) => (
        <label key={t.value} className={`flex min-h-11 cursor-pointer items-center justify-center rounded-sm border px-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent font-mono text-[12px] font-medium ${pref === t.value ? 'border-accent bg-line/8 text-type' : 'border-frame text-muted'}`}>
          <input type="radio" name="theme" value={t.value} checked={pref === t.value} onChange={() => setPref(t.value)} className="sr-only" />
          {t.label.toUpperCase()}
        </label>
      ))}
    </fieldset>
  );
}
