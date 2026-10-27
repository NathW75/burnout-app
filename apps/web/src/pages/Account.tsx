/**
 * Account, phase A part (a): who you are and signing out. Security settings,
 * sessions and receipts arrive in patch (b) (PRD-007 §6.7).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { api } from '../api/client';
import { useMe } from '../api/hooks';
import { ErrorNote, SectionTitle, TabPage, useScreen } from '../components/layout';
import { errorText } from '../lib/errors';

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
  const outAll = useMutation({ mutationFn: () => api('/auth/logout-all', { method: 'POST' }), onSuccess: done });
  return (
    <TabPage>
      <section className="flex flex-col gap-2 px-4 pt-[22px]">
        <h1 className="m-0 font-mono text-[40px] leading-none font-medium tracking-[-1px]">Account</h1>
      </section>
      <section className="flex flex-col gap-3 px-4 pt-6">
        <SectionTitle>PROFILE</SectionTitle>
        <dl className="m-0 grid gap-3 rounded-sm border border-rule bg-paper p-[14px]">
          <div className="flex flex-col gap-[2px]">
            <dt className="font-mono text-[11px] text-muted">HANDLE (PUBLIC)</dt>
            <dd className="m-0 text-[15px] font-semibold">{me.data?.handle ?? '—'}</dd>
          </div>
          <div className="flex flex-col gap-[2px]">
            <dt className="font-mono text-[11px] text-muted">EMAIL (PRIVATE)</dt>
            <dd className="m-0 text-[15px] break-all">{me.data?.email}</dd>
          </div>
          <div className="flex flex-col gap-[2px]">
            <dt className="font-mono text-[11px] text-muted">TWO-FACTOR</dt>
            <dd className="m-0 text-[15px]">{me.data?.mfaEnrolled ? 'Authenticator app' : 'Not set up'}</dd>
          </div>
        </dl>
      </section>
      <section className="flex flex-col gap-3 px-4 pt-6">
        <SectionTitle>SIGN OUT</SectionTitle>
        <ErrorNote>{outAll.isError ? errorText(outAll.error) : null}</ErrorNote>
        <button type="button" className="btn-outline min-h-12" onClick={() => out.mutate()} disabled={out.isPending}>SIGN OUT</button>
        <button type="button" className="btn-outline min-h-12" onClick={() => outAll.mutate()} disabled={outAll.isPending}>SIGN OUT EVERYWHERE</button>
        <p className="m-0 text-[13px] text-muted">“Everywhere” signs out every device and browser, including this one.</p>
      </section>
    </TabPage>
  );
}
