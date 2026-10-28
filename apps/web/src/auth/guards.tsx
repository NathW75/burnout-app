/**
 * Route guards for the one sign-up process (PRD-007 §6.1.1): account →
 * verify email → authenticator → in. A user who stops partway resumes at the
 * step they left. The API enforces the same order (§8.6); these guards just
 * send the user to the right screen.
 */
import { Navigate, Outlet, useLocation } from 'react-router';
import { useMe } from '../api/hooks';
import type { Me } from '../api/types';
import { ErrorNote, Loading, Page } from '../components/layout';
import { errorText } from '../lib/errors';
import { FeedbackButton } from '../components/Feedback';

/** Only same-app paths: never another origin, never a protocol-relative URL. */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  return raw;
}

export function nextStep(me: Me | null | undefined): '/login' | '/verify-pending' | '/setup-2fa' | null {
  if (!me) return '/login';
  if (!me.emailVerified) return '/verify-pending';
  if (!me.mfaEnrolled) return '/setup-2fa';
  return null;
}

function Gate({ allow, feedback = false }: { allow: (me: Me | null, next: string) => string | null; feedback?: boolean }) {
  const me = useMe();
  const loc = useLocation();
  const next = safeNext(new URLSearchParams(loc.search).get('next'));
  if (me.isPending) return <Page><Loading /></Page>;
  if (me.isError) {
    return (
      <Page className="p-4">
        <ErrorNote>{errorText(me.error)}</ErrorNote>
      </Page>
    );
  }
  const to = allow(me.data, next);
  if (to) {
    const back = to === '/login' ? `?next=${encodeURIComponent(loc.pathname + loc.search)}` : '';
    return <Navigate to={`${to}${back}`} replace />;
  }
  return (
    <>
      <Outlet />
      {feedback && me.data && <FeedbackButton />}
    </>
  );
}

/** Signed in, verified, with an authenticator: the whole app. */
export function RequireAccount() {
  return <Gate allow={(me) => nextStep(me)} feedback />;
}

/** Signed in (any sign-up step): verify-pending and setup. */
export function RequireSignedIn() {
  return <Gate allow={(me) => (me ? null : '/login')} feedback />;
}

/** Sign-in and sign-up screens: a finished account goes straight in. */
export function GuestOnly() {
  return <Gate allow={(me, next) => (me && nextStep(me) === null ? next : null)} />;
}
