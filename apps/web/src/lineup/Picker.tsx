/** Player picker (PRD-007 §6.3, approved mockup "Picker"). Text only: no headshots, no logos (NIL). */
import { useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { usePool } from '../api/hooks';
import type { PlayerCard, SlotKey } from '../api/types';
import { BackIcon, LockIcon, SearchIcon } from '../components/icons';
import { ErrorNote, Loading, Page, useScreen } from '../components/layout';
import { errorText } from '../lib/errors';
import { dayTimeET, timeET, dayET } from '../lib/format';
import { anyWindowOpen, isSlotKey, positionsText, SLOT_LABEL, SLOT_ORDER, slotAccepts } from '../lib/slots';
import { useServerNow } from '../lib/useClock';
import { CAUTION_STATUSES } from './shared';
import { useLineupCtx } from './context';

type Why = { tag: string; text: string };

/** Why a card can't be picked, in the words the mockups use. */
export function unavailable(p: PlayerCard, inSlot: SlotKey | undefined): Why | null {
  if (inSlot) return { tag: SLOT_LABEL[inSlot], text: `Already in your lineup at ${SLOT_LABEL[inSlot]}` };
  switch (p.unavailableReason) {
    case 'BURNED':
      return { tag: 'BURNED', text: 'Burned: gone for the season' };
    case 'LOCKED':
      return { tag: 'LOCKED', text: 'Locked in your lineup' };
    case 'INACTIVE':
      return { tag: p.injuryStatus.toUpperCase(), text: `${p.injuryStatus}: not selectable, not burned` };
    case 'BYE':
      return { tag: 'BYE WEEK', text: 'No game this week' };
    case 'WINDOW_CLOSED':
      return { tag: 'LOCKED', text: `${p.opponent ? `${p.homeAway === 'home' ? 'vs' : '@'} ${p.opponent} · ` : ''}window has locked` };
    default:
      return null;
  }
}

export function PickerPage() {
  const { slot: raw } = useParams();
  const ctx = useLineupCtx();
  const navigate = useNavigate();
  const now = useServerNow(15_000);
  const pool = usePool(ctx.season, ctx.week);
  const [q, setQ] = useState('');
  const [win, setWin] = useState<string>('ALL');
  const [showBurned, setShowBurned] = useState(false);
  const slot = isSlotKey(raw) ? raw : null;
  useScreen('player_picker', slot ? `Pick ${SLOT_LABEL[slot]}` : 'Pick a player');

  const inLineup = useMemo(() => {
    const m = new Map<string, SlotKey>();
    for (const s of SLOT_ORDER) if (s !== slot && ctx.effective[s]) m.set(ctx.effective[s]!, s);
    return m;
  }, [ctx.effective, slot]);

  if (!slot) return <Navigate to="/lineup" replace />;
  const server = ctx.lineup.slots.find((s) => s.slot === slot)!;
  if ((server.locked && !server.voidReason) || !anyWindowOpen(ctx.windows, now)) return <Navigate to="/lineup" replace />;

  const players = (pool.data?.players ?? []).filter((p) => slotAccepts(slot, p.position));
  const burnedCount = players.filter((p) => p.unavailableReason === 'BURNED').length;
  const openTimes = [...new Set(players.filter((p) => p.windowOpen && p.scheduledEt).map((p) => p.scheduledEt!))].sort();
  const needle = q.trim().toLowerCase();
  const shown = players
    .filter((p) => showBurned || p.unavailableReason !== 'BURNED')
    .filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.team.toLowerCase() === needle || p.team.toLowerCase().includes(needle))
    .filter((p) => win === 'ALL' || p.scheduledEt === win)
    .map((p) => ({ p, why: unavailable(p, inLineup.get(p.playerId)) }))
    .sort((a, b) => Number(!!a.why) - Number(!!b.why) || (a.p.scheduledEt ?? '').localeCompare(b.p.scheduledEt ?? '') || a.p.name.localeCompare(b.p.name));

  const choose = (p: PlayerCard) => {
    ctx.setSlot(slot, p.playerId);
    navigate('/lineup');
  };
  const chipLabel = (iso: string) => {
    const t = timeET(iso);
    return `${dayET(iso).toUpperCase()} ${t.replace(/ (AM|PM)$/, '')}`;
  };

  return (
    <Page>
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-accent bg-chrome px-4 py-[10px]">
        <Link to="/lineup" aria-label="Back to lineup" className="-ml-3 flex size-11 items-center justify-center text-type">
          <BackIcon />
        </Link>
        <div className="flex flex-col gap-[2px]">
          <h1 className="m-0 font-mono text-[16px] font-medium tracking-[1px]">PICK {SLOT_LABEL[slot]}</h1>
          <span className="text-[12px] text-muted">{positionsText(slot)} · open windows only</span>
        </div>
      </header>

      <div className="flex flex-col gap-[10px] px-4 pt-[14px]">
        <label htmlFor="player-search" className="font-mono text-[11px] tracking-[1px] text-muted">SEARCH PLAYERS</label>
        <div className="flex min-h-[46px] items-center gap-2 rounded-sm border border-frame bg-paper px-3">
          <SearchIcon className="text-muted" />
          <input id="player-search" type="search" placeholder="Name or team" value={q} onChange={(e) => setQ(e.target.value)} className="min-w-0 flex-1 border-0 bg-transparent text-[15px] text-type outline-offset-4" />
        </div>
        <div role="group" aria-label="Filter by window" className="flex flex-wrap gap-[6px]">
          {['ALL', ...openTimes].map((t) => {
            const on = win === t;
            return (
              <button key={t} type="button" aria-pressed={on} onClick={() => setWin(t)} className={`min-h-9 rounded-sm border px-3 font-mono text-[12px] font-medium ${on ? 'border-accent bg-line text-ink' : 'border-frame bg-transparent text-type'}`}>
                {t === 'ALL' ? 'ALL OPEN' : chipLabel(t)}
              </button>
            );
          })}
        </div>
      </div>

      {pool.isPending ? (
        <Loading label="Loading players" />
      ) : pool.isError ? (
        <div className="p-4"><ErrorNote>{errorText(pool.error)}</ErrorNote></div>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-[6px] px-4 pt-[14px]" aria-label={`Players for ${SLOT_LABEL[slot]}`}>
          {shown.length === 0 && <li className="p-4 text-center text-[14px] text-muted">No players match.</li>}
          {shown.map(({ p, why }) => (
            <PlayerRow key={p.playerId} p={p} why={why} onSelect={() => choose(p)} />
          ))}
        </ul>
      )}

      {burnedCount > 0 && (
        <div className="mx-4 mt-[14px] mb-6 flex items-center justify-between rounded-sm border border-rule px-[14px] py-3">
          <label htmlFor="show-burned" className="text-[14px]">Show players I’ve burned ({burnedCount})</label>
          <input id="show-burned" type="checkbox" checked={showBurned} onChange={(e) => setShowBurned(e.target.checked)} className="size-[22px] accent-accent" />
        </div>
      )}
    </Page>
  );
}

function PlayerRow({ p, why, onSelect }: { p: PlayerCard; why: Why | null; onSelect: () => void }) {
  const where = p.opponent ? `${p.homeAway === 'home' ? 'vs' : '@'} ${p.opponent} (${p.homeAway})` : null;
  if (why) {
    return (
      <li aria-disabled="true" className="flex items-center gap-3 rounded-sm border border-rule bg-transparent p-3">
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span className={`text-[15px] font-semibold ${p.unavailableReason === 'BURNED' ? 'text-pencil line-through' : 'text-steel'}`}>
            {p.name} <span className="text-[12px] font-medium no-underline">{p.position} · {p.team}</span>
          </span>
          <span className="text-[12px] text-steel">{why.text}</span>
        </div>
        <span className="flex flex-none items-center gap-1 border border-frame px-2 py-[3px] font-mono text-[11px] font-medium text-steel">
          {why.tag === 'LOCKED' && <LockIcon />}
          {why.tag}
        </span>
      </li>
    );
  }
  return (
    <li className="flex items-center gap-3 rounded-sm border border-rule bg-paper p-3">
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="text-[15px] font-semibold">
          {p.name} <span className="text-[12px] font-medium text-muted">{p.position} · {p.team}</span>
        </span>
        <span className="text-[12px] text-muted">
          {[where, p.scheduledEt ? `${dayTimeET(p.scheduledEt)} ET` : null].filter(Boolean).join(' · ')}
          {CAUTION_STATUSES.has(p.injuryStatus) && (
            <>
              {' · '}
              <b className="text-live">{p.injuryStatus}</b>
            </>
          )}
          {p.position === 'FB' && ' · FB counts at RB and FLEX'}
        </span>
      </div>
      <button type="button" onClick={onSelect} aria-label={`Select ${p.name}`} className="btn-primary min-h-11 flex-none px-[14px] text-[13px]">
        SELECT
      </button>
    </li>
  );
}
