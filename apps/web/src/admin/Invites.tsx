/**
 * Admin → Invites (PRD-006 §6.10): make a single-use code per tester
 * (optionally locked to their email, and emailed to them straight from here),
 * see who used which, revoke unused ones.
 * An admin sees every code and chooses invite helpers; a helper (role
 * recruiter, Nath 2026-10-30) sees and revokes only their own codes.
 * Behind a fresh code (step-up), as the API requires.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, isApiError } from '../api/client';
import { useMe } from '../api/hooks';
import { StepUpPrompt, useFreshStepUp } from '../account/StepUp';
import { AccountSubPage } from '../account/Security';
import { SubmitButton, TextField } from '../auth/AuthLayout';
import { ErrorNote, Loading, Panel, SectionTitle, useScreen } from '../components/layout';
import { errorText } from '../lib/errors';
import { fullET } from '../lib/format';

interface InviteRow {
  id: string;
  email: string | null;
  note: string | null;
  createdAt: string;
  expiresAt: string | null;
  usedAt: string | null;
  usedBy: string | null;
  status: 'active' | 'used' | 'revoked' | 'expired';
  /** Who made it, when someone other than me did (admin view only). */
  madeBy?: string | null;
}
interface Helper { id: string; email: string; handle: string | null }
interface Created { id: string; code: string; link: string; email: string | null; expiresAt: string | null; emailed?: boolean }

const KEY = ['admin', 'invites'];
const HELPERS = ['admin', 'helpers'];
const STATUS_TONE: Record<InviteRow['status'], string> = { active: 'text-accent', used: 'text-muted', revoked: 'text-pencil', expired: 'text-steel' };

export function InvitesPage() {
  useScreen('admin_invites', 'Invites');
  const me = useMe();
  const qc = useQueryClient();
  const fresh = useFreshStepUp();
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [days, setDays] = useState('14');
  const [sendIt, setSendIt] = useState(true);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);
  const isAdmin = me.data?.role === 'admin';
  const canInvite = isAdmin || me.data?.role === 'recruiter';
  const list = useQuery({ queryKey: KEY, queryFn: () => api<{ inviteOnly: boolean; invites: InviteRow[] }>('/admin/invites'), enabled: canInvite && fresh, retry: false });
  const sending = !!email.trim() && sendIt;
  const make = useMutation({
    mutationFn: () => api<Created>('/admin/invites', { body: { email: email.trim() || null, note: note.trim() || null, expiresInDays: Number(days) || null, ...(sending ? { send: true } : {}) } }),
    onSuccess: (r) => {
      setCreated(r);
      setCopied(false);
      setEmail('');
      setNote('');
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
  const revoke = useMutation({ mutationFn: (id: string) => api(`/admin/invites/${id}/revoke`, { method: 'POST' }), onSettled: () => qc.invalidateQueries({ queryKey: KEY }) });

  if (me.data && !canInvite) return <AccountSubPage title="INVITES" heading="Invites"><ErrorNote>Only an admin or an invite helper can make sign-up codes.</ErrorNote></AccountSubPage>;
  const stale = [list.error, make.error, revoke.error].some((e) => isApiError(e, 'STEP_UP_REQUIRED'));
  if (!fresh || stale) {
    return (
      <AccountSubPage title="INVITES" heading="Invites">
        <StepUpPrompt reason="Managing invites needs a fresh code." onDone={() => { make.reset(); revoke.reset(); void qc.invalidateQueries({ queryKey: KEY }); }} />
      </AccountSubPage>
    );
  }
  return (
    <AccountSubPage
      title="INVITES"
      heading="Invites"
      intro={list.data ? (list.data.inviteOnly ? `Sign-up is invite-only here: each tester needs a code. Each code works once.${isAdmin ? '' : ' You see the codes you made.'}` : 'Sign-up is open here; codes are ignored until SIGNUP_INVITE_ONLY is on.') : undefined}
    >
      {created && (
        <Panel className="flex flex-col gap-2">
          <span className="font-mono text-[11px] tracking-[1px] text-muted">NEW CODE · SHOWN ONCE{created.email ? ` · FOR ${created.email.toUpperCase()}` : ''}</span>
          {created.emailed === true && <span role="status" className="font-mono text-[12px] font-medium text-accent">SENT · INVITE EMAILED TO {created.email!.toUpperCase()}</span>}
          {created.emailed === false && <ErrorNote>Couldn’t send the email. The code still works: copy the link below and send it yourself.</ErrorNote>}
          <code className="font-mono text-[24px] tracking-[2px]">{created.code}</code>
          <span className="text-[13px] break-all text-muted">{created.link}</span>
          <button type="button" className="btn-outline self-start px-4" onClick={() => void navigator.clipboard?.writeText(created.link).then(() => setCopied(true))}>
            {copied ? 'COPIED' : 'COPY SIGN-UP LINK'}
          </button>
          {created.expiresAt && <span className="text-[12px] text-muted">Expires {fullET(created.expiresAt)}.</span>}
        </Panel>
      )}
      <form onSubmit={(e) => (e.preventDefault(), make.mutate())} className="flex flex-col gap-3" noValidate>
        <SectionTitle>NEW INVITE</SectionTitle>
        <TextField label="Their email (optional)" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} hint="If set, only this address can use the code." />
        {email.trim() && (
          <label className="flex items-center gap-3 text-[14px]">
            <input type="checkbox" checked={sendIt} onChange={(e) => setSendIt(e.target.checked)} className="size-6 flex-none accent-accent" />
            Email the invite to them
          </label>
        )}
        <TextField label="Note (optional)" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} hint="Just for you, e.g. who it's for." />
        <TextField label="Expires in days" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, '').slice(0, 2))} hint="1 to 90. Blank for no expiry." />
        <ErrorNote>{make.isError ? errorText(make.error) : null}</ErrorNote>
        <SubmitButton busy={make.isPending} disabled={!!days && (Number(days) < 1 || Number(days) > 90)}>{sending ? 'SEND INVITE' : 'MAKE CODE'}</SubmitButton>
      </form>
      <SectionTitle>{isAdmin ? 'ALL INVITES' : 'YOUR INVITES'}</SectionTitle>
      {list.error && !stale && <ErrorNote>{errorText(list.error)}</ErrorNote>}
      {!list.data ? (
        <Loading />
      ) : list.data.invites.length === 0 ? (
        <p className="m-0 text-[14px] text-muted">No invites yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col overflow-hidden rounded-sm border border-rule p-0" aria-label="Invites">
          {list.data.invites.map((i, n) => (
            <li key={i.id} className={`flex items-center justify-between gap-3 bg-paper px-[14px] py-3 ${n === list.data!.invites.length - 1 ? '' : 'border-b border-rule'}`}>
              <div className="flex min-w-0 flex-col gap-[2px]">
                <span className={`font-mono text-[11px] font-medium ${STATUS_TONE[i.status]}`}>{i.status.toUpperCase()}{i.usedBy ? ` · ${i.usedBy}` : ''}</span>
                <span className="truncate text-[14px]">{i.email ?? 'Any email'}{i.note ? ` · ${i.note}` : ''}</span>
                <span className="text-[12px] text-muted">Made {fullET(i.createdAt)}{i.madeBy ? ` by ${i.madeBy}` : ''}{i.expiresAt && i.status === 'active' ? ` · expires ${fullET(i.expiresAt)}` : ''}</span>
              </div>
              {i.status === 'active' && (
                <button type="button" className="btn-outline flex-none px-3" disabled={revoke.isPending} onClick={() => revoke.mutate(i.id)} aria-label={`Revoke invite${i.email ? ` for ${i.email}` : ''}${i.note ? `, ${i.note}` : ''}`}>
                  REVOKE
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {isAdmin && <InviteHelpers />}
    </AccountSubPage>
  );
}

/**
 * Admin only: who else may make sign-up codes. A helper gets the Invites page
 * and nothing else (no feedback, no other admin tools). They must have signed up first.
 */
function InviteHelpers() {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const helpers = useQuery({ queryKey: HELPERS, queryFn: () => api<{ helpers: Helper[] }>('/admin/helpers'), retry: false });
  const add = useMutation({
    mutationFn: () => api<Helper>('/admin/helpers', { body: { email: email.trim() } }),
    onSuccess: () => { setEmail(''); void qc.invalidateQueries({ queryKey: HELPERS }); },
  });
  const remove = useMutation({ mutationFn: (id: string) => api(`/admin/helpers/${id}/remove`, { method: 'POST' }), onSettled: () => qc.invalidateQueries({ queryKey: HELPERS }) });
  const list = helpers.data?.helpers ?? [];
  return (
    <section className="flex flex-col gap-3" aria-label="Invite helpers">
      <SectionTitle>INVITE HELPERS</SectionTitle>
      <p className="m-0 text-[13px] leading-[1.45] text-muted">People who can make sign-up codes too. They see only the codes they made, and none of the other admin tools.</p>
      {helpers.error && <ErrorNote>{errorText(helpers.error)}</ErrorNote>}
      {list.length > 0 && (
        <ul className="m-0 flex list-none flex-col overflow-hidden rounded-sm border border-rule p-0" aria-label="Current invite helpers">
          {list.map((h, n) => (
            <li key={h.id} className={`flex items-center justify-between gap-3 bg-paper px-[14px] py-3 ${n === list.length - 1 ? '' : 'border-b border-rule'}`}>
              <div className="flex min-w-0 flex-col gap-[2px]">
                <span className="truncate text-[14px]">{h.handle ?? h.email}</span>
                {h.handle && <span className="truncate text-[12px] text-muted">{h.email}</span>}
              </div>
              <button type="button" className="btn-outline flex-none px-3" disabled={remove.isPending} onClick={() => remove.mutate(h.id)} aria-label={`Remove ${h.handle ?? h.email} as an invite helper`}>
                REMOVE
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={(e) => (e.preventDefault(), add.mutate())} className="flex flex-col gap-3" noValidate>
        <TextField label="Their account email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} hint="They need to have signed up already." />
        <ErrorNote>{add.isError ? errorText(add.error) : null}</ErrorNote>
        <SubmitButton busy={add.isPending} disabled={!email.trim()}>ADD HELPER</SubmitButton>
      </form>
    </section>
  );
}
