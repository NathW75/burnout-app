/**
 * Account security (PRD-007 §6.7): change password, replace the
 * authenticator, renew backup codes. Each is its own screen under /account.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { qk, useMe } from '../api/hooks';
import type { TotpSetup } from '../api/types';
import { SubmitButton, TextField } from '../auth/AuthLayout';
import { AuthenticatorQr, BackupCodesPanel } from '../auth/factor-parts';
import { ErrorNote, Notice, Page, SubHeader, useScreen } from '../components/layout';
import { isApiError } from '../api/client';
import { errorText } from '../lib/errors';
import { StepUpPrompt, useFreshStepUp } from './StepUp';

export function AccountSubPage({ title, heading, intro, children }: { title: string; heading: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <Page>
      <SubHeader title={title} back="/account" backLabel="Back to account" />
      <main className="flex flex-1 flex-col gap-4 p-4 pb-24">
        <h1 className="m-0 font-mono text-[30px] leading-none font-medium">{heading}</h1>
        {intro && <p className="m-0 text-[14px] leading-[1.5] text-muted">{intro}</p>}
        {children}
      </main>
    </Page>
  );
}

function Done({ children }: { children: ReactNode }) {
  return (
    <>
      <Notice>{children}</Notice>
      <Link to="/account" className="btn-primary">BACK TO ACCOUNT</Link>
    </>
  );
}

// ── password ────────────────────────────────────────────────────────────────

export function PasswordPage() {
  useScreen('account_password', 'Change password');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const change = useMutation({ mutationFn: () => api('/auth/password/change', { body: { currentPassword: current, newPassword: next } }) });
  const tooShort = next.length > 0 && (next.length < 12 || next.length > 128);
  const mismatch = again.length > 0 && again !== next;
  return (
    <AccountSubPage title="PASSWORD" heading="Change password" intro="Use 12 to 128 characters. Changing it signs out your other devices; this one stays signed in.">
      {change.isSuccess ? (
        <Done>Password changed. Your other devices are signed out.</Done>
      ) : (
        <form onSubmit={(e) => (e.preventDefault(), change.mutate())} className="flex flex-col gap-4" noValidate>
          <TextField label="Current password" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
          <TextField label="New password" type="password" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} error={tooShort ? 'Use 12 to 128 characters.' : null} />
          <TextField label="New password again" type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} error={mismatch ? 'The passwords don’t match.' : null} />
          <ErrorNote>{change.isError ? (isApiError(change.error, 'INVALID_CREDENTIALS') ? 'Your current password is incorrect.' : errorText(change.error)) : null}</ErrorNote>
          <SubmitButton busy={change.isPending} disabled={!current || next.length < 12 || next.length > 128 || again !== next}>CHANGE PASSWORD</SubmitButton>
        </form>
      )}
    </AccountSubPage>
  );
}

// ── replace the authenticator ───────────────────────────────────────────────

export function AuthenticatorPage() {
  useScreen('account_authenticator', 'Replace authenticator');
  const me = useMe();
  const qc = useQueryClient();
  const fresh = useFreshStepUp();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [finished, setFinished] = useState(false);
  const setup = useMutation({ mutationFn: () => api<TotpSetup>('/auth/mfa/totp/setup', { body: { password } }) });
  const confirm = useMutation({
    mutationFn: () => api<{ backupCodes: string[] }>('/auth/mfa/totp/confirm', { body: { code: code.replace(/\s+/g, '') } }),
    onSuccess: (r) => setCodes(r.backupCodes),
  });
  const intro = 'For a new phone or app. Your old authenticator stops working once the new one is confirmed, and you get new backup codes.';

  if (finished) return <AccountSubPage title="AUTHENTICATOR" heading="Replace authenticator"><Done>Your new authenticator is set up. The old one and your old backup codes no longer work.</Done></AccountSubPage>;
  if (codes) {
    return (
      <AccountSubPage title="AUTHENTICATOR" heading="Save your new backup codes" intro="Your old codes no longer work. We show these only now. Keep them somewhere safe, away from your phone.">
        <BackupCodesPanel codes={codes} email={me.data?.email} saved={saved} onSaved={setSaved} />
        <button type="button" className="btn-primary disabled:opacity-60" disabled={!saved} onClick={() => setFinished(true)}>DONE</button>
      </AccountSubPage>
    );
  }
  if (setup.data) {
    return (
      <AccountSubPage title="AUTHENTICATOR" heading="Scan with the new app" intro="Scan this with your new authenticator, then enter the code it shows.">
        <AuthenticatorQr secret={setup.data.secret} otpauthUrl={setup.data.otpauthUrl} />
        <form onSubmit={(e) => (e.preventDefault(), confirm.mutate())} className="flex flex-col gap-4" noValidate>
          <TextField label="6-digit code from the new app" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} required value={code} onChange={(e) => setCode(e.target.value)} />
          <ErrorNote>{confirm.isError ? errorText(confirm.error) : null}</ErrorNote>
          <SubmitButton busy={confirm.isPending} disabled={code.replace(/\s/g, '').length !== 6}>CONFIRM</SubmitButton>
        </form>
      </AccountSubPage>
    );
  }
  // The server wants a fresh code (step-up) before a new factor; asked for in place, then the password.
  const needStepUp = !fresh || (setup.isError && isApiError(setup.error, 'STEP_UP_REQUIRED'));
  return (
    <AccountSubPage title="AUTHENTICATOR" heading="Replace authenticator" intro={intro}>
      {needStepUp ? (
        <StepUpPrompt reason="Replacing your authenticator needs a code from the current one." onDone={() => setup.reset()} />
      ) : (
        <form onSubmit={(e) => (e.preventDefault(), setup.mutate(undefined, { onError: () => void qc.invalidateQueries({ queryKey: qk.me }) }))} className="flex flex-col gap-4" noValidate>
          <TextField label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          <ErrorNote>{setup.isError ? errorText(setup.error) : null}</ErrorNote>
          <SubmitButton busy={setup.isPending} disabled={!password}>CONTINUE</SubmitButton>
        </form>
      )}
    </AccountSubPage>
  );
}

// ── renew backup codes ──────────────────────────────────────────────────────

export function BackupCodesPage() {
  useScreen('account_backup_codes', 'Backup codes');
  const me = useMe();
  const fresh = useFreshStepUp();
  const [saved, setSaved] = useState(false);
  const [finished, setFinished] = useState(false);
  const regen = useMutation({ mutationFn: () => api<{ backupCodes: string[] }>('/auth/mfa/backup-codes/regenerate', { method: 'POST' }) });

  if (finished) return <AccountSubPage title="BACKUP CODES" heading="Backup codes"><Done>New backup codes saved. The old ones no longer work.</Done></AccountSubPage>;
  if (regen.data) {
    return (
      <AccountSubPage title="BACKUP CODES" heading="Your new backup codes" intro="Your old codes no longer work. We show these only now.">
        <BackupCodesPanel codes={regen.data.backupCodes} email={me.data?.email} saved={saved} onSaved={setSaved} />
        <button type="button" className="btn-primary disabled:opacity-60" disabled={!saved} onClick={() => setFinished(true)}>DONE</button>
      </AccountSubPage>
    );
  }
  const needStepUp = !fresh || (regen.isError && isApiError(regen.error, 'STEP_UP_REQUIRED'));
  return (
    <AccountSubPage title="BACKUP CODES" heading="Backup codes" intro="Each backup code signs you in once if you lose your phone. New codes replace all of your old ones, used or not.">
      {needStepUp ? (
        <StepUpPrompt reason="New backup codes need a fresh code." onDone={() => regen.reset()} />
      ) : (
        <>
          <ErrorNote>{regen.isError ? errorText(regen.error) : null}</ErrorNote>
          <button type="button" className="btn-primary disabled:opacity-60" disabled={regen.isPending} onClick={() => regen.mutate()}>
            {regen.isPending ? 'ONE MOMENT…' : 'GET NEW BACKUP CODES'}
          </button>
        </>
      )}
    </AccountSubPage>
  );
}
