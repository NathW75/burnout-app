/**
 * Sign-up step 3 and 4 (PRD-007 §6.1.1): set up the authenticator, then save
 * the backup codes. Required for every account; the API refuses everything
 * else until the factor is confirmed (§8.6).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { api } from '../api/client';
import { qk, useMe } from '../api/hooks';
import type { TotpSetup } from '../api/types';
import { ErrorNote, useScreen } from '../components/layout';
import { errorText } from '../lib/errors';
import { AuthLayout, SignupSteps, SubmitButton, TextField } from './AuthLayout';
import { AuthenticatorQr, BackupCodesPanel } from './factor-parts';
import { SignOutLink } from './pages';

export { groupSecret } from './factor-parts';

export function Setup2FAPage() {
  useScreen('setup_2fa', 'Set up your authenticator');
  const me = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  // Decided once: confirming the factor flips mfaEnrolled, and the codes must stay on screen until saved.
  const [alreadyEnrolled] = useState(() => me.data?.mfaEnrolled === true);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);

  const setup = useMutation({ mutationFn: () => api<TotpSetup>('/auth/mfa/totp/setup', { body: { password } }) });
  const confirm = useMutation({
    mutationFn: () => api<{ backupCodes: string[] }>('/auth/mfa/totp/confirm', { body: { code: code.replace(/\s+/g, '') } }),
    onSuccess: (r) => setCodes(r.backupCodes),
  });

  if (alreadyEnrolled) return <Navigate to="/" replace />;
  if (me.data && !me.data.emailVerified) return <Navigate to="/verify-pending" replace />;

  // ── step 4: backup codes ──
  if (codes) {
    const finish = async () => {
      await qc.invalidateQueries({ queryKey: qk.me, refetchType: 'all' });
      navigate('/welcome', { replace: true });
    };
    return (
      <AuthLayout
        title="Save your backup codes"
        intro="If you lose your phone, each of these signs you in once. We show them only now. Keep them somewhere safe, away from your phone."
        steps={<SignupSteps current={4} />}
      >
        <BackupCodesPanel codes={codes} email={me.data?.email} saved={saved} onSaved={setSaved} />
        <button type="button" className="btn-primary disabled:opacity-60" disabled={!saved} onClick={() => void finish()}>
          CONTINUE
        </button>
      </AuthLayout>
    );
  }

  // ── step 3b: scan and confirm ──
  if (setup.data) {
    return (
      <AuthLayout
        title="Scan with your authenticator"
        intro="Use any authenticator app: Google Authenticator, Microsoft Authenticator, 1Password, Authy, or your phone’s built-in passwords app."
        steps={<SignupSteps current={3} />}
      >
        <AuthenticatorQr secret={setup.data.secret} otpauthUrl={setup.data.otpauthUrl} />
        <form onSubmit={(e) => (e.preventDefault(), confirm.mutate())} className="flex flex-col gap-4" noValidate>
          <TextField label="6-digit code from the app" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} required value={code} onChange={(e) => setCode(e.target.value)} />
          <ErrorNote>{confirm.isError ? errorText(confirm.error) : null}</ErrorNote>
          <SubmitButton busy={confirm.isPending} disabled={code.replace(/\s/g, '').length !== 6}>CONFIRM</SubmitButton>
        </form>
      </AuthLayout>
    );
  }

  // ── step 3a: confirm the password ──
  return (
    <AuthLayout
      title="Set up your authenticator"
      intro="Every Burnout League account needs a second factor. Confirm your password to start; it takes about a minute."
      steps={<SignupSteps current={3} />}
    >
      <form onSubmit={(e) => (e.preventDefault(), setup.mutate())} className="flex flex-col gap-4" noValidate>
        <TextField label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <ErrorNote>{setup.isError ? errorText(setup.error) : null}</ErrorNote>
        <SubmitButton busy={setup.isPending} disabled={!password}>CONTINUE</SubmitButton>
      </form>
      <SignOutLink />
    </AuthLayout>
  );
}
