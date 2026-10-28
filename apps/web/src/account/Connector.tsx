/**
 * Account → AI connector (PRD-011 §5.2): personal tokens that let your own AI
 * assistant read your Burnout League data through the MCP connector.
 * Read-only: an AI can never make picks. A token is shown once; making one
 * needs a fresh code.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, API_BASE, isApiError } from '../api/client';
import { SubmitButton, TextField } from '../auth/AuthLayout';
import { ErrorNote, Loading, Panel, SectionTitle, useScreen } from '../components/layout';
import { errorText } from '../lib/errors';
import { fullET } from '../lib/format';
import { AccountSubPage } from './Security';
import { StepUpPrompt, useFreshStepUp } from './StepUp';

interface TokenRow { id: string; label: string | null; createdAt: string; expiresAt: string; lastUsedAt: string | null }
interface Created { token: string; credential: TokenRow }

const KEY = ['mcp-credentials'];
export const MCP_URL = `${API_BASE}/mcp`;

export function ConnectorPage() {
  useScreen('account_connector', 'AI connector');
  const qc = useQueryClient();
  const fresh = useFreshStepUp();
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState<'token' | 'url' | null>(null);
  const list = useQuery({ queryKey: KEY, queryFn: () => api<{ tokens: TokenRow[]; maxTokens: number }>('/me/mcp') });
  const make = useMutation({
    mutationFn: () => api<Created>('/me/mcp/tokens', { body: { label: label.trim() || null } }),
    onSuccess: (r) => {
      setCreated(r);
      setCopied(null);
      setLabel('');
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
  const revoke = useMutation({ mutationFn: (id: string) => api(`/me/mcp/tokens/${id}`, { method: 'DELETE' }), onSettled: () => qc.invalidateQueries({ queryKey: KEY }) });
  const copy = (what: 'token' | 'url', text: string) => void navigator.clipboard?.writeText(text).then(() => setCopied(what));
  const needCode = !fresh || isApiError(make.error, 'STEP_UP_REQUIRED');
  const full = !!list.data && list.data.tokens.length >= list.data.maxTokens;

  return (
    <AccountSubPage
      title="AI CONNECTOR"
      heading="AI connector"
      intro="Let your own AI assistant read your Burnout League data: your player pool and burns, standings, and how much of the field has burned each player. It’s read-only. An AI can’t make or change picks; only you can, in the app."
    >
      {created && (
        <Panel className="flex flex-col gap-2">
          <span className="font-mono text-[11px] tracking-[1px] text-muted">NEW TOKEN · SHOWN ONCE{created.credential.label ? ` · ${created.credential.label.toUpperCase()}` : ''}</span>
          <code className="font-mono text-[13px] break-all">{created.token}</code>
          <button type="button" className="btn-outline self-start px-4" onClick={() => copy('token', created.token)}>{copied === 'token' ? 'COPIED' : 'COPY TOKEN'}</button>
          <span className="text-[12px] text-muted">Save it in your AI app now: it won’t be shown again. Expires {fullET(created.credential.expiresAt)}.</span>
        </Panel>
      )}

      <SectionTitle>SET IT UP</SectionTitle>
      <ol className="m-0 flex flex-col gap-2 pl-5 text-[14px] leading-[1.5]">
        <li>Make a token below.</li>
        <li>In your AI app or developer tool, add a remote MCP server (HTTP) with this address:
          <span className="mt-1 flex flex-wrap items-center gap-2">
            <code className="rounded-sm border border-rule bg-paper px-2 py-1 font-mono text-[13px] break-all">{MCP_URL}</code>
            <button type="button" className="btn-outline px-3" onClick={() => copy('url', MCP_URL)}>{copied === 'url' ? 'COPIED' : 'COPY'}</button>
          </span>
        </li>
        <li>Give it the header <code className="font-mono text-[13px]">Authorization: Bearer</code> followed by your token.</li>
      </ol>
      <p className="m-0 text-[13px] leading-[1.45] text-muted">Connecting from the Claude or ChatGPT apps by signing in, with no token to paste, is coming in the next update.</p>

      <SectionTitle>NEW TOKEN</SectionTitle>
      {full ? (
        <p className="m-0 text-[14px] text-muted">You have {list.data!.maxTokens} tokens, the most allowed. Revoke one to make another.</p>
      ) : needCode ? (
        <StepUpPrompt reason="Making a token needs a fresh code." onDone={() => make.reset()} />
      ) : (
        <form onSubmit={(e) => (e.preventDefault(), make.mutate())} className="flex flex-col gap-3" noValidate>
          <TextField label="Name (optional)" maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} hint="Which app it’s for, e.g. Claude Code. Tokens last 90 days." />
          <ErrorNote>{make.isError ? errorText(make.error) : null}</ErrorNote>
          <SubmitButton busy={make.isPending}>MAKE TOKEN</SubmitButton>
        </form>
      )}

      <SectionTitle>YOUR TOKENS</SectionTitle>
      {list.error && <ErrorNote>{errorText(list.error)}</ErrorNote>}
      {revoke.isError && <ErrorNote>{errorText(revoke.error)}</ErrorNote>}
      {!list.data ? (
        <Loading />
      ) : list.data.tokens.length === 0 ? (
        <p className="m-0 text-[14px] text-muted">No tokens yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col overflow-hidden rounded-sm border border-rule p-0" aria-label="Tokens">
          {list.data.tokens.map((t, n) => (
            <li key={t.id} className={`flex items-center justify-between gap-3 bg-paper px-[14px] py-3 ${n === list.data!.tokens.length - 1 ? '' : 'border-b border-rule'}`}>
              <div className="flex min-w-0 flex-col gap-[2px]">
                <span className="truncate text-[15px] font-semibold">{t.label ?? 'Unnamed token'}</span>
                <span className="text-[12px] text-muted">{t.lastUsedAt ? `Last used ${fullET(t.lastUsedAt)}` : 'Not used yet'} · expires {fullET(t.expiresAt)}</span>
              </div>
              <button type="button" className="btn-outline flex-none px-3" disabled={revoke.isPending} onClick={() => revoke.mutate(t.id)} aria-label={`Revoke ${t.label ?? 'unnamed token'}`}>
                REVOKE
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="m-0 text-[12px] leading-[1.45] text-muted">Changing your password or signing out everywhere revokes every token.</p>
    </AccountSubPage>
  );
}
