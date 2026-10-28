/** Receipt (PRD-007 §6.7, §7): server timestamps, the nine slots, the checksum. */
import { Link, useParams } from 'react-router';
import { usePool, useReceipt, useWindows } from '../api/hooks';
import { ErrorNote, Loading, Page, SubHeader, useScreen } from '../components/layout';
import { errorText } from '../lib/errors';
import { fullET, timeET, dayET } from '../lib/format';
import { SLOT_LABEL, SLOT_ORDER } from '../lib/slots';

export function ReceiptPage() {
  const { id } = useParams();
  useScreen('receipt', 'Receipt');
  const receipt = useReceipt(id);
  const r = receipt.data;
  const pool = usePool(r?.season, r?.week);
  const windows = useWindows(r?.season, r?.week);
  const names = new Map((pool.data?.players ?? []).map((p) => [p.playerId, p]));
  return (
    <Page>
      <SubHeader title="RECEIPT" back="/" backLabel="Back to This Week" />
      <main className="flex flex-1 flex-col gap-4 px-4 pt-5 pb-24">
        {receipt.isPending && <Loading />}
        {receipt.isError && <ErrorNote>{errorText(receipt.error)}</ErrorNote>}
        {r && (
          <>
            <div className="flex flex-col gap-1">
              <span className="font-mono text-[12px] tracking-[1px] text-muted">{r.season.toUpperCase()}</span>
              <h1 className="m-0 font-mono text-[30px] leading-[1.1] font-medium">Week {r.week} lineup</h1>
            </div>
            <dl className="m-0 grid grid-cols-1 gap-3 rounded-sm border border-slate-edge bg-slate p-[14px]">
              {[
                ['GATE 1 · REVIEWED', r.gate1_at],
                ['GATE 2 · ACKNOWLEDGED', r.gate2_at],
                ['GATE 3 · CONFIRMED', r.gate3_at],
              ].map(([k, v]) => (
                <div key={k} className="flex flex-col gap-[2px]">
                  <dt className="font-mono text-[11px] text-muted">{k} (SERVER)</dt>
                  <dd className="m-0 tnum text-[14px] font-semibold">{fullET(v)}</dd>
                </div>
              ))}
              <div className="flex flex-col gap-[2px]">
                <dt className="font-mono text-[11px] text-muted">CHECKSUM (SHA-256)</dt>
                <dd className="m-0 font-mono text-[13px] font-medium break-all">{r.sha256}</dd>
              </div>
            </dl>
            <ol className="m-0 list-none overflow-hidden rounded-sm border border-rule p-0" aria-label="Slots on this receipt">
              {SLOT_ORDER.map((slot, i) => {
                const s = r.slots.find((x) => x.slot === slot);
                const p = s?.playerId ? names.get(s.playerId) : undefined;
                const w = windows.data?.find((x) => x.id === s?.gameWindowId);
                return (
                  <li key={slot} className={`flex items-center gap-3 bg-paper px-[14px] py-3 ${i < SLOT_ORDER.length - 1 ? 'border-b border-rule' : ''}`}>
                    <span className="w-[42px] flex-none font-mono text-[13px] font-medium text-muted">{SLOT_LABEL[slot]}</span>
                    <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
                      <span className={`text-[15px] font-semibold ${s?.playerId ? '' : 'text-muted'}`}>{s?.playerId ? (p ? `${p.name}` : s.playerId) : 'Empty'}</span>
                      <span className="text-[12px] text-muted">
                        {[p ? `${p.position} · ${p.team}` : null, w ? `${dayET(w.scheduledEt)} ${timeET(w.scheduledEt)} ET` : null, s?.locked ? 'already locked' : null].filter(Boolean).join(' · ')}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ol>
            <p className="m-0 text-[13px] leading-[1.5] text-muted">
              The checksum proves this receipt hasn’t changed. <Link to="/help#checksum">How to recompute it</Link>
            </p>
          </>
        )}
      </main>
    </Page>
  );
}
