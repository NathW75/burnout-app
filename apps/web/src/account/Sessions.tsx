/**
 * Sessions and receipts (PRD-007 §6.7): where you're signed in, with
 * revoke and sign-out-everywhere; and every confirmed lineup's receipt.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { api } from '../api/client';
import { useSeason } from '../api/hooks';
import { ErrorNote, Loading, useScreen } from '../components/layout';
import { errorText } from '../lib/errors';
import { fullET } from '../lib/format';
import { AccountSubPage } from './Security';

export interface SessionRow {
  id: string;
  client: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

/** "Chrome on Android", "Safari on iPhone", "Firefox on Windows": enough to recognize a device. */
export function deviceName(ua: string | null, client?: string): string {
  if (!ua) return client === 'mobile' ? 'Burnout League app' : 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'A browser';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : null;
  return os ? `${browser} on ${os}` : browser;
}

export function SessionsPage() {
  useScreen('account_sessions', 'Sessions');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: async () => (await api<{ sessions: SessionRow[] }>('/me/sessions')).sessions, staleTime: 0 });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/me/sessions/${id}`, { method: 'DELETE' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
  const everywhere = useMutation({
    mutationFn: () => api('/auth/logout-all', { method: 'POST' }),
    onSuccess: () => {
      qc.clear();
      navigate('/login', { replace: true });
    },
  });
  return (
    <AccountSubPage title="SESSIONS" heading="Where you’re signed in" intro="Sign out a device you don’t recognize. If you think someone else has your password, change it too.">
      {sessions.error && <ErrorNote>{errorText(sessions.error)}</ErrorNote>}
      {!sessions.data ? (
        <Loading />
      ) : (
        <ul className="m-0 flex list-none flex-col overflow-hidden rounded-sm border border-rule p-0" aria-label="Signed-in devices">
          {sessions.data.map((s, i) => (
            <li key={s.id} className={`flex items-center justify-between gap-3 bg-paper px-[14px] py-3 ${i === sessions.data.length - 1 ? '' : 'border-b border-rule'}`}>
              <div className="flex min-w-0 flex-col gap-[2px]">
                <span className="text-[15px] font-semibold">
                  {deviceName(s.userAgent, s.client)}
                  {s.current && <span className="ml-2 font-mono text-[11px] font-medium text-accent">THIS DEVICE</span>}
                </span>
                <span className="text-[12px] text-muted">Last active {fullET(s.lastSeenAt)}</span>
                <span className="text-[12px] text-muted">Signed in {fullET(s.createdAt)}</span>
              </div>
              {!s.current && (
                <button
                  type="button"
                  className="btn-outline flex-none px-3"
                  disabled={revoke.isPending && revoke.variables === s.id}
                  onClick={() => revoke.mutate(s.id)}
                  aria-label={`Sign out ${deviceName(s.userAgent, s.client)}, last active ${fullET(s.lastSeenAt)}`}
                >
                  SIGN OUT
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ErrorNote>{revoke.isError ? errorText(revoke.error) : everywhere.isError ? errorText(everywhere.error) : null}</ErrorNote>
      <button type="button" className="btn-outline min-h-12" onClick={() => everywhere.mutate()} disabled={everywhere.isPending}>SIGN OUT EVERYWHERE</button>
      <p className="m-0 text-[13px] text-muted">“Everywhere” signs out every device and browser, including this one.</p>
    </AccountSubPage>
  );
}

interface ReceiptSummary {
  id: string;
  week: number;
  confirmedAt: string;
  sha256: string | null;
}

export function ReceiptsPage() {
  useScreen('account_receipts', 'Receipts');
  const season = useSeason();
  const receipts = useQuery({
    queryKey: ['receipts', season.data?.season],
    queryFn: async () => (await api<{ receipts: ReceiptSummary[] }>(`/me/receipts?season=${encodeURIComponent(season.data!.season)}`)).receipts,
    enabled: !!season.data,
  });
  return (
    <AccountSubPage
      title="RECEIPTS"
      heading="Lineup receipts"
      intro={<>Every lineup you’ve confirmed, newest first. Each receipt has a checksum you can recompute. <Link to="/help#checksum">How</Link></>}
    >
      {receipts.error && <ErrorNote>{errorText(receipts.error)}</ErrorNote>}
      {!receipts.data ? (
        <Loading />
      ) : receipts.data.length === 0 ? (
        <p className="m-0 rounded-sm border border-dashed border-frame p-[14px] text-[14px] text-muted">No confirmed lineups yet this season.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col overflow-hidden rounded-sm border border-rule p-0" aria-label="Receipts">
          {receipts.data.map((r, i) => (
            <li key={r.id} className={i === receipts.data.length - 1 ? '' : 'border-b border-rule'}>
              <Link to={`/receipts/${r.id}`} className="flex items-center justify-between gap-3 bg-paper px-[14px] py-3 text-type no-underline hover:bg-newsprint">
                <span className="flex min-w-0 flex-col gap-[2px]">
                  <span className="text-[15px] font-semibold">Week {r.week}</span>
                  <span className="text-[12px] text-muted">{fullET(r.confirmedAt)}</span>
                </span>
                <code className="flex-none font-mono text-[12px] text-muted">{r.sha256 ? `${r.sha256.slice(0, 10)}…` : ''}</code>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </AccountSubPage>
  );
}
