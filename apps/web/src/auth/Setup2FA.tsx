/**
 * Sign-up step 3 and 4 (PRD-007 §6.1.1): set up the authenticator, then save
 * the backup codes. Required for every account; the API refuses everything
 * else until the factor is confirmed (§8.6).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { api } from '../api/client';
import { qk, useMe } from '../api/hooks';
import type { TotpSetup } from '../api/types';
import { ErrorNote, useScreen } from '../components/layout';
import { errorText } from '../lib/errors';
import { AuthLayout, SignupSteps, SubmitButton, TextField } from './AuthLayout';
import { SignOutLink } from './pages';

/** "JBSW Y3DP EHPK 3PXP": the secret in groups of four, for typing by hand. */
export const groupSecret = (s: string) => s.replace(/(.{4})/g, '$1 ').trim();

export function Setup2FAPage() {
  useScreen('setup_2fa', 'Set up your authenticator');
  const me = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  // Decided once: confirming the factor flips mfaEnrolled, and the codes must stay on screen until saved.
  const [alreadyEnrolled] = useState(() => me.data?.mfaEnrolled === true);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [qr, setQr] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);

  const setup = useMutation({ mutationFn: () => api<TotpSetup>('/auth/mfa/totp/setup', { body: { password } }) });
  const confirm = useMutation({
    mutationFn: () => api<{ backupCodes: string[] }>('/auth/mfa/totp/confirm', { body: { code: code.replace(/\s+/g, '') } }),
    onSuccess: (r) => setCodes(r.backupCodes),
  });

  useEffect(() => {
    if (!setup.data) return;
    let live = true;
    QRCode.toDataURL(setup.data.otpauthUrl, { margin: 1, width: 220, color: { dark: '#0D0E0F', light: '#EDEFEA' } })
      .then((url) => live && setQr(url))
      .catch(() => live && setQr(null));
    return () => {
      live = false;
    };
  }, [setup.data]);

  if (alreadyEnrolled) return <Navigate to="/" replace />;
  if (me.data && !me.data.emailVerified) return <Navigate to="/verify-pending" replace />;

  // ── step 4: backup codes ──
  if (codes) {
    const finish = async () => {
      await qc.invalidateQueries({ queryKey: qk.me, refetchType: 'all' });
      navigate('/welcome', { replace: true });
    };
    const download = () => {
      const text = `Burnout League backup codes for ${me.data?.email ?? 'your account'}\nEach code works once.\n\n${codes.join('\n')}\n`;
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: 'burnout-league-backup-codes.txt' });
      a.click();
      URL.revokeObjectURL(url);
    };
    return (
      <AuthLayout
        title="Save your backup codes"
        intro="If you lose your phone, each of these signs you in once. We show them only now. Keep them somewhere safe, away from your phone."
        steps={<SignupSteps current={4} />}
      >
        <ul aria-label="Backup codes" className="m-0 grid list-none grid-cols-2 gap-2 rounded-sm border border-rule bg-paper p-4 font-mono text-[16px] tnum">
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <div className="flex gap-2">
          <button type="button" className="btn-outline flex-1" onClick={download}>DOWNLOAD .TXT</button>
          <button type="button" className="btn-outline flex-1" onClick={() => void navigator.clipboard?.writeText(codes.join('\n'))}>COPY</button>
        </div>
        <label className={`flex cursor-pointer items-start gap-[14px] rounded-sm border bg-paper p-[14px] ${saved ? 'border-line' : 'border-rule'}`}>
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="m-0 size-6 flex-none accent-line" />
          <span className="text-[14px] leading-[1.5]">I’ve saved these codes.</span>
        </label>
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
        <div className="flex flex-col items-center gap-3 rounded-sm border border-rule bg-paper p-4">
          {qr ? <img src={qr} width={220} height={220} alt="QR code for your authenticator app" className="rounded-sm" /> : <div className="size-[220px]" />}
          <div className="flex flex-col items-center gap-1 text-center">
            <span className="font-mono text-[11px] tracking-[1px] text-muted">CAN’T SCAN? ENTER THIS KEY</span>
            <code className="font-mono text-[15px] tracking-[1px] break-words text-type">{groupSecret(setup.data.secret)}</code>
          </div>
        </div>
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
