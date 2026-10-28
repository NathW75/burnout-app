/** Lineup builder (PRD-007 §6.3, approved mockup "Lineup"). */
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../api/client';
import { useBurns, usePool } from '../api/hooks';
import type { LineupSlot, PlayerCard, ReviewResponse, SlotKey } from '../api/types';
import { ClockIcon, CloseIcon } from '../components/icons';
import { ABOVE_NAV, ErrorNote, Notice, Page, SubHeader, useScreen } from '../components/layout';
import { errorText, issuesOf } from '../lib/errors';
import { countdown, dayTimeET, points, shortName } from '../lib/format';
import { anyWindowOpen, SLOT_LABEL, SLOT_ORDER, slotState, VOID_TEXT } from '../lib/slots';
import { useServerNow } from '../lib/useClock';
import { cardMatchup, matchup, nextLock } from './shared';
import { useLineupCtx } from './context';

export function BuilderPage() {
  const ctx = useLineupCtx();
  const { season, week, lineup, windows, draft, effective, changes, setSlot, flash, setFlash } = ctx;
  useScreen('lineup_builder', `Week ${week} lineup`);
  const navigate = useNavigate();
  const now = useServerNow();
  const pool = usePool(season, week);
  const burns = useBurns(season);
  const cards = new Map((pool.data?.players ?? []).map((p) => [p.playerId, p]));
  const open = anyWindowOpen(windows, now);
  const elig = lineup.eligibility;
  const freePlayOver = elig.freePlayThroughWeek !== null && week > elig.freePlayThroughWeek;
  const next = nextLock(windows, now);
  const [issueSlots, setIssueSlots] = useState<Set<SlotKey>>(new Set());
  // Every open slot must be filled to submit (PRD-006 §9: SLOT_EMPTY). Locked and burned slots stay as they are.
  const missing = SLOT_ORDER.filter((slot) => {
    const s = lineup.slots.find((x) => x.slot === slot)!;
    return !effective[slot] && (!s.locked || s.voidReason !== null);
  });
  // A draft pick whose window has since locked (or who went Out) can't be submitted: it must be replaced.
  const stale = SLOT_ORDER.filter((slot) => {
    const id = draft[slot];
    const c = id ? cards.get(id) : undefined;
    return !!c && !c.selectable;
  });
  const blocked = [...missing, ...stale];

  const review = useMutation({
    mutationFn: () => api<ReviewResponse>(`/seasons/${season}/weeks/${week}/lineup/review`, { body: { slots: effective } }),
    onSuccess: (r) => {
      ctx.setReview(r);
      ctx.setAcknowledged(false);
      ctx.setConfirmed(null);
      setFlash(null);
      navigate('/lineup/review');
    },
    onError: (err) => setIssueSlots(new Set(issuesOf(err).map((i) => i.slot).filter((s): s is SlotKey => !!s))),
  });

  // Fetch the gates' code while the user builds, so Gate 1 opens at once.
  useEffect(() => {
    void import('./Gates');
  }, []);

  // A flash from a gate (expired, stale lock) is shown once, then cleared on the next change.
  useEffect(() => () => setFlash(null), [setFlash]);

  const burnFor = (slot: SlotKey) => burns.data?.find((b) => b.week === week && b.slot === slot);

  return (
    <Page>
      <SubHeader title={`WEEK ${week} LINEUP`} back="/" backLabel="Back to This Week" />
      <main className={`flex flex-1 flex-col gap-[14px] px-4 pt-[14px] ${open && !freePlayOver ? 'pb-28' : 'pb-24'}`}>
        <ErrorNote>{flash}</ErrorNote>
        {freePlayOver && <ErrorNote>Lineups are closed for the rest of this season.</ErrorNote>}
        {!open && <Notice>Every window this week has locked. Your lineup is set; next week opens when its schedule is final.</Notice>}
        {next && (
          <div className="flex items-center gap-[10px] rounded-sm border border-slate-edge bg-slate px-3 py-[10px]">
            <ClockIcon className="flex-none text-muted" />
            <p className="m-0 text-[13px] leading-[1.4]">
              Each slot locks at its game’s <b>scheduled</b> kickoff. Next lock:{' '}
              <b className="tnum text-live">
                {dayTimeET(next.scheduledEt)} ET · {countdown(Date.parse(next.scheduledEt) - now, next.scheduledEt)}
              </b>
            </p>
          </div>
        )}
        <ErrorNote>{review.isError ? errorText(review.error) : null}</ErrorNote>

        <ol className="m-0 flex list-none flex-col gap-[6px] p-0" aria-label="Your nine slots">
          {SLOT_ORDER.map((slot) => {
            const server = lineup.slots.find((s) => s.slot === slot)!;
            return (
              <SlotRow
                key={slot}
                server={server}
                draftValue={slot in draft ? (draft[slot] ?? null) : undefined}
                effectiveId={effective[slot]}
                card={effective[slot] ? cards.get(effective[slot]!) : undefined}
                state={slotState(server, windows)}
                burnPts={burnFor(slot)?.pointsX100}
                canEdit={open && !freePlayOver}
                flagged={issueSlots.has(slot) || stale.includes(slot)}
                windows={windows}
                week={week}
                onUndo={() => setSlot(slot, server.voidReason ? null : server.playerId)}
              />
            );
          })}
        </ol>

        <section className="mt-1 flex flex-col gap-2 rounded-sm border border-rule px-[14px] py-3">
          <h2 className="m-0 font-mono text-[12px] font-medium tracking-[1px] text-muted"><span className="text-mark">///</span> HOW SLOTS WORK</h2>
          <p className="m-0 text-[13px] leading-[1.5]">
            Start him, lose him. A player in your lineup when his window locks is <b>burned</b> once his game goes Final. An empty slot scores 0 and burns nothing. <Link to="/help">The rules</Link>
          </p>
        </section>
      </main>

      {open && !freePlayOver && (
        <div data-bottom-bar className={`sticky ${ABOVE_NAV} z-10 flex items-center justify-between gap-3 border-t border-rule bg-chrome px-4 pt-[14px] pb-[18px]`}>
          <div className="flex flex-col gap-[2px]">
            <span className="text-[14px] font-semibold">{changes === 0 ? 'No changes' : `${changes} change${changes === 1 ? '' : 's'} not submitted`}</span>
            <span className="text-[12px] text-muted">
              {blocked.length > 0
                ? `${missing.length ? 'Fill' : 'Replace'} ${blocked.map((m) => SLOT_LABEL[m]).join(', ')} to review`
                : changes === 0
                  ? 'Pick or change a slot to start'
                  : 'Draft saved on this device only'}
            </span>
          </div>
          <button type="button" className="btn-primary flex-none text-[14px] disabled:opacity-50" disabled={changes === 0 || blocked.length > 0 || review.isPending} onClick={() => review.mutate()}>
            {review.isPending ? 'CHECKING…' : 'REVIEW LINEUP'}
          </button>
        </div>
      )}
    </Page>
  );
}

interface RowProps {
  server: LineupSlot;
  /** undefined = no draft change; null = cleared; string = new pick. */
  draftValue: string | null | undefined;
  effectiveId: string | null;
  card: PlayerCard | undefined;
  state: ReturnType<typeof slotState>;
  burnPts: number | undefined;
  canEdit: boolean;
  flagged: boolean;
  windows: Parameters<typeof matchup>[2];
  week: number;
  /** Drops this slot's draft change, back to what the server has. */
  onUndo: () => void;
}

const row = 'flex items-center gap-3 rounded-sm p-3';
const labelCls = 'w-11 flex-none font-mono text-[14px] font-medium';

function SlotRow({ server, draftValue, effectiveId, card, state, burnPts, canEdit, flagged, windows, week, onUndo }: RowProps) {
  const slot = server.slot;
  const label = SLOT_LABEL[slot];
  const ring = flagged ? ' outline outline-2 outline-pencil' : '';
  const pickLink = (text: string, primary: boolean) =>
    canEdit ? (
      <Link to={`/lineup/pick/${slot}`} className={primary ? 'btn-primary flex-none min-h-11 px-[14px] text-[13px]' : 'btn-outline flex-none'} aria-label={`${text} ${label}`}>
        {text}
      </Link>
    ) : null;

  if (state === 'BURNED') {
    return (
      <li className={`${row} border border-rule bg-paper${ring}`}>
        <span className={`${labelCls} text-pencil`}>{label}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
          <span className="text-[15px] font-semibold text-pencil line-through">{shortName(server.name)}</span>
          <span className="text-[12px] text-steel">
            {[matchup(server.team, server.scheduledEt, windows), 'Final', burnPts !== undefined ? `${points(burnPts)} pts` : null].filter(Boolean).join(' · ')}
          </span>
        </div>
        <span className="flex-none font-mono text-[11px] font-medium text-pencil">BURNED W{week}</span>
      </li>
    );
  }
  if (state === 'LOCKED') {
    return (
      <li className={`${row} border border-rule bg-bulb/14${ring}`}>
        <span className={`${labelCls} text-live`}>{label}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
          <span className="text-[15px] font-semibold">{shortName(server.name)}</span>
          <span className="text-[12px] text-muted">{[matchup(server.team, server.scheduledEt, windows), server.scheduledEt ? `locked ${dayTimeET(server.scheduledEt)} ET` : null].filter(Boolean).join(' · ')}</span>
        </div>
        <span className="flex-none bg-bulb px-[6px] py-[2px] font-mono text-[11px] font-medium text-ink">GAME LIVE</span>
      </li>
    );
  }

  const isNew = draftValue !== undefined && draftValue !== null;
  if (effectiveId && (isNew || state === 'PICKED')) {
    const name = isNew ? card?.name ?? effectiveId : server.name;
    const team = isNew ? card?.team ?? null : server.team;
    const sched = isNew ? card?.scheduledEt ?? null : server.scheduledEt;
    const pos = isNew ? card?.position : server.position;
    const game = isNew && card ? cardMatchup(card) : matchup(team, sched, windows);
    return (
      <li className={`${row} border ${isNew ? 'border-accent bg-line/8' : 'border-rule bg-paper'}${ring}`}>
        <span className={`${labelCls} ${isNew ? 'text-accent' : 'text-muted'}`}>{label}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
          <span className="text-[15px] font-semibold">
            {shortName(name)}
            {pos === 'FB' && <span className="ml-1 text-[12px] font-medium text-muted">FB</span>}
            {isNew && <span className="ml-1 font-mono text-[11px] font-medium text-accent">· NEW</span>}
          </span>
          {isNew && card && !card.selectable ? (
            <span className="text-[12px] text-pencil">{card.unavailableReason === 'INACTIVE' ? `Now listed ${card.injuryStatus}. Pick someone else.` : 'His window locked. Pick someone else.'}</span>
          ) : (
            <span className="text-[12px] text-muted">{[game, sched ? `locks ${dayTimeET(sched)} ET` : null].filter(Boolean).join(' · ')}</span>
          )}
        </div>
        {isNew && canEdit ? (
          <button type="button" onClick={onUndo} aria-label={`Undo: remove ${name} from ${label}`} className="btn-outline flex-none size-11 p-0">
            <CloseIcon />
          </button>
        ) : (
          pickLink('CHANGE', false)
        )}
      </li>
    );
  }

  // Empty, cleared, or voided-and-open.
  const voided = state === 'VOIDED' && draftValue === undefined;
  const cleared = draftValue === null && server.playerId && !server.voidReason;
  return (
    <li className={`${row} border border-dashed ${voided ? 'border-live' : 'border-frame'}${ring}`}>
      <span className={`${labelCls} ${voided ? 'text-live' : 'text-muted'}`}>{label}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
        <span className={`text-[15px] font-semibold ${voided ? '' : 'text-muted'}`}>{voided ? 'Open' : 'Empty'}</span>
        <span className="text-[12px] text-muted">
          {voided
            ? `${shortName(server.name)} voided: ${VOID_TEXT[server.voidReason!]}`
            : cleared
              ? `Removed ${shortName(server.name)}. Pick a player to submit.`
              : canEdit
                ? 'Pick a player: every open slot is needed to submit.'
                : 'Empty: scores 0, burns nothing.'}
        </span>
      </div>
      {pickLink('PICK', true)}
    </li>
  );
}
