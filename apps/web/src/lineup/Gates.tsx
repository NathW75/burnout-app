/**
 * The three gates (PRD-007 §7, PRD-001 §9) as approved in the mockups:
 *   1. Review   – every slot as it will lock.
 *   2. Acknowledge – three unticked boxes; CONTINUE stays lime and can't be
 *      tapped until all three are ticked, then turns red with white text.
 *   3. Confirm  – press and hold 1.5 s; the ring fills lime while the center
 *      fills red from 0 to 100% opacity in step with it.
 * The server sets the deadline and timestamps each gate; the app never
 * retries confirm.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { api, isApiError, NetworkError } from '../api/client';
import { qk, useBurns } from '../api/hooks';
import type { ConfirmResponse, DescribedSlot, SlotKey } from '../api/types';
import { HoldButton } from '../components/HoldButton';
import { ABOVE_NAV, ErrorNote, Page, useScreen } from '../components/layout';
import { clearDraft } from '../lib/draft';
import { errorText, issuesOf, issueText } from '../lib/errors';
import { countdown, dayET, fullET, points, shortName, timeET } from '../lib/format';
import { SLOT_LABEL, SLOT_ORDER, slotState } from '../lib/slots';
import { useServerNow } from '../lib/useClock';
import { useMe } from '../api/hooks';
import { matchup, nextLock } from './shared';
import { useLineupCtx } from './context';

const STEPS = ['01 REVIEW', '02 ACKNOWLEDGE', '03 CONFIRM'];

function GateFrame({ step, back, backLabel, children, footer }: { step: 1 | 2 | 3; back: string; backLabel: string; children: ReactNode; footer?: ReactNode }) {
  const ctx = useLineupCtx();
  const navigate = useNavigate();
  const now = useServerNow();
  const expiresAt = ctx.review ? Date.parse(ctx.review.expiresAt) : 0;
  const left = expiresAt - now;
  const done = step === 3 && !!ctx.confirmed;

  // The confirmation expired: start again at Gate 1 (PRD-007 §7).
  useEffect(() => {
    if (ctx.review && !done && left <= 0) {
      ctx.endConfirmation();
      ctx.setFlash('Your review expired. Review your lineup again.');
      navigate('/lineup', { replace: true });
    }
  }, [ctx, done, left, navigate]);

  return (
    <Page>
      <header className="sticky top-0 z-10 flex flex-col gap-3 border-b border-accent bg-chrome px-4 pt-[10px] pb-4">
        <div className="flex items-center justify-between">
          {done ? <span /> : <Link to={back} className="flex min-h-11 items-center font-mono text-[12px] no-underline">← {backLabel}</Link>}
          {!done && ctx.review && (
            <span className="text-[13px] text-muted">
              Expires in <b role="timer" className="tnum font-mono font-medium text-type">{countdown(left, ctx.review.expiresAt)}</b>
            </span>
          )}
        </div>
        <ol aria-label="Confirmation steps" className="m-0 grid list-none grid-cols-3 gap-[6px] p-0">
          {STEPS.map((s, i) => (
            <li key={s} aria-current={i + 1 === step ? 'step' : undefined} className="flex flex-col gap-[6px]">
              <span className={`h-[3px] ${i + 1 <= step ? 'bg-accent' : 'bg-rule'}`} />
              <span className={`font-mono text-[11px] ${i + 1 === step ? 'text-accent' : 'text-muted'}`}>{s}</span>
            </li>
          ))}
        </ol>
      </header>
      <main className="flex flex-1 flex-col pb-20">{children}</main>
      {footer && <div data-bottom-bar className={`sticky ${ABOVE_NAV} z-10 flex flex-col gap-2 border-t border-rule bg-chrome px-4 pt-[14px] pb-[18px]`}>{footer}</div>}
    </Page>
  );
}

/** Slot keys whose player differs from the server lineup. */
function changedSlots(review: DescribedSlot[], server: ReturnType<typeof useLineupCtx>['lineup']): Set<SlotKey> {
  const out = new Set<SlotKey>();
  for (const r of review) {
    const s = server.slots.find((x) => x.slot === r.slot);
    const before = s && !s.voidReason ? s.playerId : null;
    if (r.playerId !== before) out.add(r.slot);
  }
  return out;
}

// ── Gate 1 ────────────────────────────────────────────────────────────────────

export function Gate1Page() {
  const ctx = useLineupCtx();
  const now = useServerNow();
  const navigate = useNavigate();
  const burns = useBurns(ctx.season);
  useScreen('gate_review', `Review Week ${ctx.week}`);
  if (!ctx.review) return <Navigate to="/lineup" replace />;
  const { review, lineup, windows, week } = ctx;
  const changed = changedSlots(review.slots, lineup);
  const next = nextLock(windows, now);
  const nextT = next ? Date.parse(next.scheduledEt) : null;
  const emptyOpen = SLOT_ORDER.filter((slot) => { const r = review.slots.find((x) => x.slot === slot)!; return !r.playerId && !r.locked; });
  const lockingNext = nextT === null ? 0 : review.slots.filter((s) => s.playerId && !s.locked && s.scheduledEt && Date.parse(s.scheduledEt) === nextT).length;

  return (
    <GateFrame
      step={1}
      back="/lineup"
      backLabel="EDIT LINEUP"
      footer={<button type="button" className="btn-primary" onClick={() => navigate('/lineup/acknowledge')}>CONTINUE</button>}
    >
      <section className="flex flex-col gap-2 px-4 pt-[22px]">
        <h1 className="m-0 font-mono text-[30px] leading-[1.1] font-medium tracking-[-0.5px]">Review Week {week}</h1>
        <p className="m-0 text-[14px] leading-[1.5] text-muted">Each player locks at his window’s scheduled kickoff. When his game goes Final, he is burned for the rest of the season.</p>
      </section>
      {emptyOpen.length > 0 && (
        <p role="note" className="m-0 mx-4 mt-4 rounded-sm border border-dashed border-live px-[14px] py-3 text-[14px] leading-[1.5]">
          <b className="font-mono text-[12px] tracking-[1px] text-live">{emptyOpen.length === 1 ? '1 SLOT IS EMPTY' : `${emptyOpen.length} SLOTS ARE EMPTY`}</b>
          <br />
          {emptyOpen.map((s) => SLOT_LABEL[s]).join(', ')} will score 0 and burn nothing. You can fill {emptyOpen.length === 1 ? 'it' : 'them'} any time before {emptyOpen.length === 1 ? 'its' : 'their'} last game locks: <Link to="/lineup">edit lineup</Link>.
        </p>
      )}
      <ol className="m-0 mx-4 mt-4 list-none overflow-hidden rounded-sm border border-rule p-0" aria-label="Your lineup as it will lock">
        {SLOT_ORDER.map((slot, i) => {
          const r = review.slots.find((s) => s.slot === slot)!;
          const server = lineup.slots.find((s) => s.slot === slot)!;
          const state = r.locked ? slotState(server, windows) : null;
          const isNew = changed.has(slot);
          const isNext = !!r.scheduledEt && !r.locked && nextT !== null && Date.parse(r.scheduledEt) === nextT;
          const last = i === SLOT_ORDER.length - 1;
          const base = `flex items-center gap-3 px-[14px] py-3 ${last ? '' : 'border-b border-rule'}`;
          const time = r.scheduledEt ? `${dayET(r.scheduledEt).toUpperCase()} ${timeET(r.scheduledEt).replace(/ (AM|PM)$/, '')}` : '';
          if (state === 'BURNED') {
            const b = burns.data?.find((x) => x.week === week && x.slot === slot);
            return (
              <li key={slot} className={`${base} bg-paper`}>
                <span className="w-[42px] flex-none font-mono text-[13px] font-medium text-pencil">{SLOT_LABEL[slot]}</span>
                <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
                  <span className="text-[15px] font-semibold text-pencil line-through">{shortName(r.name)}</span>
                  <span className="text-[12px] text-steel">Already burned · can’t change{b ? ` · ${points(b.pointsX100)} pts` : ''}</span>
                </div>
                <span className="flex-none font-mono text-[12px] text-pencil">FINAL</span>
              </li>
            );
          }
          if (!r.playerId) {
            return (
              <li key={slot} className={`${base} bg-paper`}>
                <span className="w-[42px] flex-none font-mono text-[13px] font-medium text-muted">{SLOT_LABEL[slot]}</span>
                <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
                  <span className="text-[15px] font-semibold text-muted">Empty {isNew && <span className="font-mono text-[11px] font-medium text-accent">· CHANGED</span>}</span>
                  <span className="text-[12px] text-muted">Scores 0, burns nothing</span>
                </div>
              </li>
            );
          }
          return (
            <li key={slot} className={`${base} ${isNew ? 'bg-line/8' : 'bg-paper'}`}>
              <span className={`w-[42px] flex-none font-mono text-[13px] font-medium ${isNew ? 'text-accent' : r.locked ? 'text-live' : 'text-muted'}`}>{SLOT_LABEL[slot]}</span>
              <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
                <span className="text-[15px] font-semibold">
                  {shortName(r.name)}
                  {r.position === 'FB' && <span className="ml-1 text-[12px] font-medium text-muted">FB</span>}
                  {isNew && <span className="ml-1 font-mono text-[11px] font-medium text-accent">· NEW</span>}
                </span>
                <span className="text-[12px] text-muted">{r.locked ? 'Locked · game live · can’t change' : matchup(r.team, r.scheduledEt, windows) ?? r.team}</span>
              </div>
              <span className={`flex-none font-mono text-[12px] ${r.locked ? 'text-live' : isNext ? 'text-live' : 'text-muted'}`}>{r.locked ? 'LIVE' : time}</span>
            </li>
          );
        })}
      </ol>
      <p className="mx-4 mt-3 mb-6 text-[12px] leading-[1.5] text-muted">
        All times ET. Locks fire at the scheduled kickoff, not the actual kickoff.
        {next && lockingNext > 0 && (
          <>
            {' '}
            {lockingNext === 1 ? 'One player locks' : `${lockingNext} players lock`} in{' '}
            <b className="tnum font-mono font-medium text-live">{countdown(nextT! - now, next.scheduledEt)}</b>.
          </>
        )}
      </p>
    </GateFrame>
  );
}

// ── Gate 2 ────────────────────────────────────────────────────────────────────

const ACKS = [
  { key: 'burnRules', title: '01 · THE BURN RULE', text: 'A player in my lineup when his window locks is burned once his game goes Final, win or lose.' },
  { key: 'permanent', title: '02 · IT’S PERMANENT', text: 'A burned player is gone from my pool for the rest of the season. No undo.' },
  { key: 'noRefund', title: '03 · IT’S FINAL', text: 'Once I confirm, this lineup can’t be undone or reversed.' },
] as const;
type AckKey = (typeof ACKS)[number]['key'];

export function Gate2Page() {
  const ctx = useLineupCtx();
  const navigate = useNavigate();
  useScreen('gate_acknowledge', 'Acknowledge');
  const [ticks, setTicks] = useState<Record<AckKey, boolean>>({ burnRules: false, permanent: false, noRefund: false });
  const ack = useMutation({
    mutationFn: () => api(`/lineup-confirmations/${ctx.review!.confirmationId}/acknowledge`, { body: ticks }),
    onSuccess: () => {
      ctx.setAcknowledged(true);
      navigate('/lineup/confirm');
    },
    onError: (err) => {
      if (isApiError(err, 'CONFIRMATION_EXPIRED') || isApiError(err, 'GATE_ORDER')) {
        ctx.endConfirmation();
        ctx.setFlash(errorText(err));
        navigate('/lineup', { replace: true });
      }
    },
  });
  if (!ctx.review) return <Navigate to="/lineup" replace />;
  if (ctx.acknowledged) return <Navigate to="/lineup/confirm" replace />;
  const left = ACKS.filter((a) => !ticks[a.key]).length;
  const all = left === 0;

  return (
    <GateFrame
      step={2}
      back="/lineup/review"
      backLabel="BACK TO REVIEW"
      footer={
        <>
          <ErrorNote>{ack.isError ? errorText(ack.error) : null}</ErrorNote>
          {all ? (
            <button type="button" className="btn-primary bg-commit text-white disabled:opacity-70" onClick={() => ack.mutate()} disabled={ack.isPending}>
              {ack.isPending ? 'ONE MOMENT…' : 'CONTINUE'}
            </button>
          ) : (
            <>
              <button type="button" className="btn-primary" disabled aria-describedby="tick-hint">CONTINUE</button>
              <span id="tick-hint" className="text-center text-[12px] text-muted">Tick {left} more to continue</span>
            </>
          )}
        </>
      }
    >
      <section className="flex flex-col gap-2 px-4 pt-[22px]">
        <h1 className="m-0 font-mono text-[30px] leading-[1.1] font-medium tracking-[-0.5px]">Before you lock in</h1>
        <p className="m-0 text-[14px] leading-[1.5] text-muted">Tick each one. Nothing is pre-checked.</p>
      </section>
      <fieldset className="m-0 mx-4 mt-[18px] flex flex-col gap-2 border-0 p-0">
        <legend className="sr-only">Acknowledgments</legend>
        {ACKS.map((a) => (
          <label key={a.key} className={`flex cursor-pointer items-start gap-[14px] rounded-sm border bg-paper p-[14px] ${ticks[a.key] ? 'border-accent' : 'border-rule'}`}>
            <input type="checkbox" checked={ticks[a.key]} onChange={(e) => setTicks({ ...ticks, [a.key]: e.target.checked })} className="m-0 size-6 flex-none accent-accent" />
            <span className="flex flex-col gap-1">
              <span className="font-mono text-[13px] font-medium">{a.title}</span>
              <span className="text-[14px] leading-[1.5] text-muted">{a.text}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <p className="mx-4 mt-[14px] mb-6 text-[12px] leading-[1.5] text-muted">
        Draft wording. Final text comes from the Terms (<Link to="/help#terms">read them</Link>).
      </p>
    </GateFrame>
  );
}

// ── Gate 3 ────────────────────────────────────────────────────────────────────

export function Gate3Page() {
  const ctx = useLineupCtx();
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const now = useServerNow();
  useScreen('gate_confirm', `Lock in Week ${ctx.week}`);
  const [netFail, setNetFail] = useState(false);

  const confirm = useMutation({
    mutationFn: () => api<ConfirmResponse>(`/lineup-confirmations/${ctx.review!.confirmationId}/confirm`, { method: 'POST' }),
    onSuccess: (r) => {
      ctx.setConfirmed(r);
      if (me.data) clearDraft(me.data.id, ctx.season, ctx.week);
      ctx.discardDraft();
    },
    onError: (err) => {
      if (err instanceof NetworkError) {
        setNetFail(true); // never retry: the lineup may or may not have gone in
        return;
      }
      const issues = issuesOf(err);
      ctx.endConfirmation();
      ctx.setFlash(issues.length ? `${issues.map(issueText).join(' ')} Your lineup was not confirmed; review it again.` : errorText(err));
      navigate('/lineup', { replace: true });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.lineup(ctx.season, ctx.week) });
      void qc.invalidateQueries({ queryKey: qk.pool(ctx.season, ctx.week) });
      void qc.invalidateQueries({ queryKey: qk.notifications });
      void qc.invalidateQueries({ queryKey: qk.fieldMe(ctx.season) });
    },
  });

  if (ctx.confirmed) return <Done />;
  if (!ctx.review) return <Navigate to="/lineup" replace />;
  if (!ctx.acknowledged) return <Navigate to="/lineup/acknowledge" replace />;

  if (netFail) {
    return (
      <GateFrame step={3} back="/lineup" backLabel="LINEUP">
        <section className="flex flex-col gap-4 px-4 pt-7">
          <h1 className="m-0 font-mono text-[30px] leading-[1.1] font-medium">Check your lineup</h1>
          <p className="m-0 text-[14px] leading-[1.5] text-muted">We lost the connection while confirming, so we can’t tell whether your lineup went in. Open your lineup to see what the server has.</p>
          <button type="button" className="btn-primary" onClick={() => { ctx.endConfirmation(); navigate('/lineup', { replace: true }); }}>CHECK MY LINEUP</button>
        </section>
      </GateFrame>
    );
  }

  const changes = changedSlots(ctx.review.slots, ctx.lineup).size;
  const filled = ctx.review.slots.filter((s) => s.playerId).length;
  const next = nextLock(ctx.windows, now);
  return (
    <GateFrame step={3} back="/lineup/acknowledge" backLabel="BACK">
      <section className="flex flex-col items-center gap-2 px-4 pt-7 text-center">
        <h1 className="m-0 font-mono text-[30px] leading-[1.1] font-medium tracking-[-0.5px]">Lock in Week {ctx.week}</h1>
        <p className="m-0 max-w-[300px] text-[14px] leading-[1.5] text-muted">
          {filled} slot{filled === 1 ? '' : 's'} · {changes} change{changes === 1 ? '' : 's'}
          {next ? ` · first lock ${dayET(next.scheduledEt)} ${timeET(next.scheduledEt)} ET` : ''}. Hold the button until the ring fills.
        </p>
      </section>
      <div className="flex flex-col items-center gap-4 pt-10 pb-8">
        <HoldButton label={`Hold to lock in your Week ${ctx.week} lineup`} busy={confirm.isPending} onComplete={() => confirm.mutate()} />
        <p id="hold-hint" className="m-0 px-4 text-center text-[13px] text-muted">
          {confirm.isPending ? 'Locking in…' : 'Press and hold for 1.5 seconds. Keyboard: hold Space or Enter. Let go to cancel.'}
        </p>
      </div>
    </GateFrame>
  );
}

function Done() {
  const ctx = useLineupCtx();
  const r = ctx.confirmed!;
  const navigate = useNavigate();
  const now = useServerNow();
  const next = nextLock(ctx.windows, now);
  const nextT = next ? Date.parse(next.scheduledEt) : null;
  const lockingNext = nextT === null ? 0 : r.slots.filter((s) => s.playerId && !s.locked && ctx.windows.find((w) => w.id === s.gameWindowId && Date.parse(w.scheduledEt) === nextT)).length;
  // Leaving /lineup unmounts the lineup state, so the confirmation ends with the navigation.
  const finish = (to: string) => navigate(to);
  return (
    <GateFrame step={3} back="/" backLabel="">
      <section className="flex flex-col gap-4 px-4 pt-8 pb-8">
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="bg-line px-2 py-[3px] font-mono text-[12px] font-medium text-ink">CONFIRMED</span>
          <h1 className="m-0 font-mono text-[30px] leading-[1.1] font-medium">Locked in.</h1>
          <p className="m-0 text-[14px] leading-[1.5] text-muted">
            Your Week {ctx.week} lineup is confirmed.
            {next && lockingNext > 0 && ` ${lockingNext === 1 ? 'One player locks' : `${lockingNext} players lock`} ${dayET(next.scheduledEt)} at ${timeET(next.scheduledEt)} ET.`}
          </p>
        </div>
        <dl className="m-0 grid grid-cols-2 gap-x-2 gap-y-3 rounded-sm border border-slate-edge bg-slate p-[14px]">
          <div className="flex flex-col gap-[2px]">
            <dt className="font-mono text-[11px] text-muted">CONFIRMED (SERVER)</dt>
            <dd className="m-0 text-[14px] font-semibold tnum">{fullET(r.gate3At)}</dd>
          </div>
          <div className="flex flex-col gap-[2px]">
            <dt className="font-mono text-[11px] text-muted">CHANGES</dt>
            <dd className="m-0 text-[14px] font-semibold">{r.changedSlots.length ? r.changedSlots.map((s) => SLOT_LABEL[s]).join(', ') : 'None'}</dd>
          </div>
          <div className="col-span-2 flex flex-col gap-[2px]">
            <dt className="font-mono text-[11px] text-muted">RECEIPT CHECKSUM (SHA-256)</dt>
            <dd className="m-0 font-mono text-[13px] font-medium break-all">{r.sha256}</dd>
          </div>
        </dl>
        <button type="button" className="btn-outline min-h-12 text-[13px] tracking-[1px]" onClick={() => finish(`/receipts/${r.receiptId}`)}>VIEW RECEIPT</button>
        <button type="button" className="btn-primary" onClick={() => finish('/')}>BACK TO THIS WEEK</button>
      </section>
    </GateFrame>
  );
}
