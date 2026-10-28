/** Sign up, verify, sign in, reset (PRD-007 §6.1). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api, isApiError } from '../api/client';
import { qk, useMe } from '../api/hooks';
import type { LoginResponse } from '../api/types';
import { ErrorNote, Notice, useScreen } from '../components/layout';
import { Turnstile, TURNSTILE_SITE_KEY, type TurnstileHandle } from '../components/Turnstile';
import { errorText } from '../lib/errors';
import { AuthLayout, SignupSteps, SubmitButton, TextField } from './AuthLayout';
import { safeNext } from './guards';

const PASSWORD_HINT = '12 to 128 characters. A long phrase works well.';
const HANDLE_HINT = 'Your public name on the boards: 3–20 letters, numbers or underscores.';

// ── sign up ───────────────────────────────────────────────────────────────────

export function SignUpPage() {
  useScreen('signup', 'Sign up');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [handle, setHandle] = useState('');
  const [params] = useSearchParams();
  // Invite links carry the code (PRD-006 §6.10): /signup?invite=7KX2M-QW9TD
  const [invite, setInvite] = useState(() => params.get('invite') ?? '');
  const config = useQuery({ queryKey: ['signup-config'], queryFn: () => api<{ inviteOnly: boolean }>('/auth/signup-config'), staleTime: 60_000 });
  const inviteOnly = config.data?.inviteOnly ?? false;
  const [token, setToken] = useState<string | null>(null);
  const [widgetError, setWidgetError] = useState(false);
  const ts = useRef<TurnstileHandle>(null);
  const signup = useMutation({
    mutationFn: () => api('/auth/signup', { body: { email, password, handle, ...(token ? { turnstileToken: token } : {}), ...(inviteOnly ? { inviteCode: invite.trim() } : {}) } }),
    onSettled: () => ts.current?.reset(), // a token works once
  });

  if (signup.isSuccess) {
    return (
      <AuthLayout title="Check your email" steps={<SignupSteps current={2} />}>
        <Notice>
          We sent a link to <b>{email}</b>. Open it to verify your email, then sign in to set up your authenticator. If the email
          already has an account, we sent a sign-in link instead.
        </Notice>
        <Link to="/login" className="btn-outline">SIGN IN</Link>
      </AuthLayout>
    );
  }

  const needsToken = !!TURNSTILE_SITE_KEY;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    signup.mutate();
  };
  return (
    <AuthLayout
      title="Start him. Lose him."
      intro={`Create your account. Sign-up has four steps: account, verify your email, set up an authenticator, save your backup codes.${inviteOnly ? ' Testing is invite-only for now: you’ll need the code you were sent.' : ''}`}
      steps={<SignupSteps current={1} />}
    >
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {inviteOnly && (
          <TextField
            label="Invite code"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            required
            maxLength={20}
            hint="10 letters and numbers, like 7KX2M-QW9TD. Each code works once."
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
          />
        )}
        <TextField label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <TextField label="Password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} hint={PASSWORD_HINT} value={password} onChange={(e) => setPassword(e.target.value)} />
        <TextField label="Handle" autoComplete="nickname" required minLength={3} maxLength={20} pattern="[A-Za-z0-9_]{3,20}" hint={HANDLE_HINT} value={handle} onChange={(e) => setHandle(e.target.value)} />
        <Turnstile ref={ts} onToken={setToken} onError={() => setWidgetError(true)} />
        {widgetError && <ErrorNote>The human check didn’t load. Reload the page, or turn off anything blocking challenges.cloudflare.com.</ErrorNote>}
        <ErrorNote>{signup.isError ? errorText(signup.error) : null}</ErrorNote>
        <SubmitButton busy={signup.isPending} disabled={(needsToken && !token) || (inviteOnly && invite.replace(/[\s-]/g, '').length !== 10)}>CREATE ACCOUNT</SubmitButton>
      </form>
      <p className="m-0 text-[14px] text-muted">
        Already have an account? <Link to="/login">Sign in</Link>
      </p>
    </AuthLayout>
  );
}

// ── verify email ──────────────────────────────────────────────────────────────

export function VerifyEmailPage() {
  useScreen('verify_email', 'Verify email');
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const qc = useQueryClient();
  const me = useMe();
  const verify = useMutation({
    mutationFn: () => api('/auth/verify-email', { body: { token } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.me, refetchType: 'all' }),
  });
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !token) return;
    started.current = true; // tokens are single-use: call once, even under StrictMode
    verify.mutate();
  }, [token, verify]);

  if (!token || verify.isError) {
    return (
      <AuthLayout title="Link didn’t work" steps={<SignupSteps current={2} />}>
        <ErrorNote>{verify.isError ? errorText(verify.error) : 'That link is missing its token.'}</ErrorNote>
        {me.data ? <Link to="/verify-pending" className="btn-primary">SEND A NEW LINK</Link> : <Link to="/login" className="btn-primary">SIGN IN</Link>}
      </AuthLayout>
    );
  }
  if (!verify.isSuccess) return <AuthLayout title="Verifying…" steps={<SignupSteps current={2} />}>{null}</AuthLayout>;
  return (
    <AuthLayout title="Email verified" intro="Next, set up an authenticator app. Every account needs one." steps={<SignupSteps current={3} />}>
      {me.data ? (
        <Link to="/setup-2fa" className="btn-primary">SET UP AUTHENTICATOR</Link>
      ) : (
        <Link to="/login?next=%2Fsetup-2fa" className="btn-primary">SIGN IN TO CONTINUE</Link>
      )}
    </AuthLayout>
  );
}

export function VerifyPendingPage() {
  useScreen('verify_pending', 'Verify your email');
  const me = useMe();
  const resend = useMutation({ mutationFn: () => api('/auth/verify-email/resend', { method: 'POST' }) });
  return (
    <AuthLayout
      title="Verify your email"
      intro={<>Open the link we sent to <b className="text-type">{me.data?.email}</b>. Then come back here to set up your authenticator.</>}
      steps={<SignupSteps current={2} />}
    >
      {resend.isSuccess && <Notice>A new link is on its way. It works for 48 hours.</Notice>}
      <ErrorNote>{resend.isError ? errorText(resend.error) : null}</ErrorNote>
      <button type="button" className="btn-outline" onClick={() => resend.mutate()} disabled={resend.isPending}>
        SEND A NEW LINK
      </button>
      <SignOutLink />
    </AuthLayout>
  );
}

export function SignOutLink() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const out = useMutation({
    mutationFn: () => api('/auth/logout', { method: 'POST' }),
    onSettled: () => {
      qc.clear();
      navigate('/login', { replace: true });
    },
  });
  return (
    <button type="button" onClick={() => out.mutate()} className="self-start border-0 bg-transparent p-0 text-[14px] text-accent underline">
      Sign out
    </button>
  );
}

// ── sign in ───────────────────────────────────────────────────────────────────

export function LoginPage() {
  useScreen('login', 'Sign in');
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () => api<LoginResponse>('/auth/login', { body: { email, password, client: 'web' } }),
    onSuccess: async (r) => {
      if (r.mfaRequired) return navigate(`/login/code?next=${encodeURIComponent(next)}`);
      await qc.invalidateQueries({ queryKey: qk.me, refetchType: 'all' });
      navigate(next, { replace: true }); // the guards route an unfinished sign-up to its next step
    },
  });
  return (
    <AuthLayout title="Sign in" intro="Password first, then a code from your authenticator.">
      <form onSubmit={(e) => (e.preventDefault(), login.mutate())} className="flex flex-col gap-4" noValidate>
        <TextField label="Email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <TextField label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <ErrorNote>{login.isError ? errorText(login.error) : null}</ErrorNote>
        <SubmitButton busy={login.isPending}>CONTINUE</SubmitButton>
      </form>
      <div className="flex flex-col gap-2 text-[14px] text-muted">
        <Link to="/forgot-password">Forgot your password?</Link>
        <span>
          New here? <Link to="/signup">Create an account</Link>
        </span>
      </div>
    </AuthLayout>
  );
}

export function LoginCodePage() {
  useScreen('login_code', 'Enter your code');
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const mfa = useMutation({
    mutationFn: () => api('/auth/login/mfa', { body: { code: code.replace(/\s+/g, '') } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.me, refetchType: 'all' });
      navigate(next, { replace: true });
    },
  });
  const expired = isApiError(mfa.error, 'MFA_NOT_PENDING') || (isApiError(mfa.error) && mfa.error.status === 401);
  return (
    <AuthLayout title="Enter your code" intro="The 6-digit code from your authenticator app, or one of your backup codes.">
      <form onSubmit={(e) => (e.preventDefault(), mfa.mutate())} className="flex flex-col gap-4" noValidate>
        <TextField label="Code" inputMode="text" autoComplete="one-time-code" autoFocus required maxLength={20} value={code} onChange={(e) => setCode(e.target.value)} />
        <ErrorNote>{mfa.isError ? (expired ? 'Your sign-in timed out. Start again.' : errorText(mfa.error)) : null}</ErrorNote>
        <SubmitButton busy={mfa.isPending} disabled={code.trim().length < 6}>SIGN IN</SubmitButton>
      </form>
      <p className="m-0 text-[14px] text-muted">
        Lost your phone and your backup codes? Contact support for an identity check and a reset. <Link to="/login">Start over</Link>
      </p>
    </AuthLayout>
  );
}

// ── password reset ────────────────────────────────────────────────────────────

export function ForgotPasswordPage() {
  useScreen('forgot_password', 'Reset your password');
  const [email, setEmail] = useState('');
  const req = useMutation({ mutationFn: () => api('/auth/password/reset-request', { body: { email } }) });
  return (
    <AuthLayout title="Reset your password" intro="We’ll email you a link. It works once, for one hour.">
      {req.isSuccess ? (
        <Notice>If that email has an account, the link is on its way.</Notice>
      ) : (
        <form onSubmit={(e) => (e.preventDefault(), req.mutate())} className="flex flex-col gap-4" noValidate>
          <TextField label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <ErrorNote>{req.isError ? errorText(req.error) : null}</ErrorNote>
          <SubmitButton busy={req.isPending}>SEND LINK</SubmitButton>
        </form>
      )}
      <Link to="/login" className="text-[14px]">Back to sign in</Link>
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  useScreen('reset_password', 'Choose a new password');
  const [params] = useSearchParams();
  const token = params.get('token');
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const qc = useQueryClient();
  const reset = useMutation({
    mutationFn: () => api('/auth/password/reset', { body: { token, newPassword: pw } }),
    onSuccess: () => qc.clear(), // every session was signed out
  });
  if (!token) return <ForgotPasswordPage />;
  const mismatch = again.length > 0 && again !== pw;
  return (
    <AuthLayout title="Choose a new password" intro="Every device signed in to your account is signed out when you change it.">
      {reset.isSuccess ? (
        <>
          <Notice>Password changed. Sign in with the new one.</Notice>
          <Link to="/login" className="btn-primary">SIGN IN</Link>
        </>
      ) : (
        <form onSubmit={(e) => (e.preventDefault(), !mismatch && reset.mutate())} className="flex flex-col gap-4" noValidate>
          <TextField label="New password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} hint={PASSWORD_HINT} value={pw} onChange={(e) => setPw(e.target.value)} />
          <TextField label="Type it again" type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} error={mismatch ? 'The two passwords don’t match.' : null} />
          <ErrorNote>{reset.isError ? errorText(reset.error) : null}</ErrorNote>
          <SubmitButton busy={reset.isPending} disabled={!pw || mismatch}>CHANGE PASSWORD</SubmitButton>
        </form>
      )}
    </AuthLayout>
  );
}
