/**
 * Player picker (PRD-007 §6.3, patch c): position pills first, search within
 * the filter, and sortable per-game stat columns with a sticky name column.
 * Text only: no headshots, no logos (NIL).
 */
import { useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { usePool } from '../api/hooks';
import type { PlayerCard, SlotKey, StatBlock } from '../api/types';
import { BackIcon, LockIcon, SearchIcon } from '../components/icons';
import { ErrorNote, Loading, Page, useScreen } from '../components/layout';
import { errorText } from '../lib/errors';
import { dayTimeET, timeET, dayET } from '../lib/format';
import { anyWindowOpen, isSlotKey, positionsText, SLOT_LABEL, SLOT_ORDER, slotAccepts } from '../lib/slots';
import { useServerNow } from '../lib/useClock';
import { CAUTION_STATUSES } from './shared';
import { cell, defaultGroups, GROUP_COLUMNS, GROUP_LABEL, GROUP_ORDER, isKickerSlot, matchesPill, nextSort, pillsFor, sortPlayers, visibleColumns, type Column, type Group, type Period, type Pill, type Sort } from './stats';
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
  const slot = isSlotKey(raw) ? raw : null;
  useScreen('player_picker', slot ? `Pick ${SLOT_LABEL[slot]}` : 'Pick a player');
  // Filters and columns last for this visit to the picker only (§6.3.1–§6.3.2): opening it again starts fresh.
  const [q, setQ] = useState('');
  const [pill, setPill] = useState<Pill>('ALL');
  const [win, setWin] = useState<string>('ALL');
  const [showBurned, setShowBurned] = useState(false);
  const [groups, setGroups] = useState<Group[]>(() => (slot ? defaultGroups(slot) : []));
  const [period, setPeriod] = useState<Period>('season');
  const [sort, setSort] = useState<Sort | null>(null);

  const inLineup = useMemo(() => {
    const m = new Map<string, SlotKey>();
    for (const s of SLOT_ORDER) if (s !== slot && ctx.effective[s]) m.set(ctx.effective[s]!, s);
    return m;
  }, [ctx.effective, slot]);

  if (!slot) return <Navigate to="/lineup" replace />;
  const server = ctx.lineup.slots.find((s) => s.slot === slot)!;
  if ((server.locked && !server.voidReason) || !anyWindowOpen(ctx.windows, now)) return <Navigate to="/lineup" replace />;

  const kicker = isKickerSlot(slot);
  const columns = visibleColumns(slot, groups);
  const players = (pool.data?.players ?? []).filter((p) => slotAccepts(slot, p.position));
  const burnedCount = players.filter((p) => p.unavailableReason === 'BURNED').length;
  const openTimes = [...new Set(players.filter((p) => p.windowOpen && p.scheduledEt).map((p) => p.scheduledEt!))].sort();
  const needle = q.trim().toLowerCase();
  // Search narrows the position filter's list, never replaces it.
  const filtered = players
    .filter((p) => matchesPill(pill, p.position))
    .filter((p) => showBurned || p.unavailableReason !== 'BURNED')
    .filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.team.toLowerCase().includes(needle))
    .filter((p) => win === 'ALL' || p.scheduledEt === win);
  const open = sortPlayers(filtered.filter((p) => !unavailable(p, inLineup.get(p.playerId))), sort, period, columns);
  const closed = sortPlayers(filtered.filter((p) => !!unavailable(p, inLineup.get(p.playerId))), sort, period, columns);
  const shown = [...open, ...closed].map((p) => ({ p, why: unavailable(p, inLineup.get(p.playerId)) }));

  const choose = (p: PlayerCard) => {
    ctx.setSlot(slot, p.playerId);
    navigate('/lineup');
  };
  const choosePill = (next: Pill) => {
    setPill(next);
    setSort(null); // a new filter starts from the default order
  };
  const toggleGroup = (g: Group) => setGroups((cur) => (cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g]));
  const chipLabel = (iso: string) => {
    const t = timeET(iso);
    return `${dayET(iso).toUpperCase()} ${t.replace(/ (AM|PM)$/, '')}`;
  };
  const pillClass = (on: boolean) =>
    `min-h-9 flex-none rounded-sm border px-3 font-mono text-[12px] font-medium ${on ? 'border-accent bg-line text-ink' : 'border-rule bg-paper text-type'}`;
  const groupHeads = kicker
    ? [{ label: 'KICKING', span: columns.length }]
    : [{ label: '', span: 1 }, ...GROUP_ORDER.filter((g) => groups.includes(g)).map((g) => ({ label: GROUP_LABEL[g], span: GROUP_COLUMNS[g].length }))];

  return (
    <Page>
      <header className="sticky top-0 z-20 flex flex-col gap-[10px] border-b border-accent bg-chrome px-4 pt-[10px] pb-[10px]">
        <div className="flex items-center gap-2">
          <Link to="/lineup" aria-label="Back to lineup" className="-ml-3 flex size-11 items-center justify-center text-type">
            <BackIcon />
          </Link>
          <div className="flex flex-col gap-[2px]">
            <h1 className="m-0 font-mono text-[16px] font-medium tracking-[1px]">PICK {SLOT_LABEL[slot]}</h1>
            <span className="text-[12px] text-muted">{positionsText(slot)} · open windows only</span>
          </div>
        </div>
        {/* The position pills come first, before anything else (§6.3.1). */}
        <div role="group" aria-label="Filter by position" className="-mx-4 flex gap-[6px] overflow-x-auto px-4 pb-[2px]">
          {pillsFor(slot).map((p) => (
            <button key={p} type="button" aria-pressed={pill === p} onClick={() => choosePill(p)} className={pillClass(pill === p)}>
              {p}
            </button>
          ))}
        </div>
      </header>
      <main className="flex flex-1 flex-col">

      <div className="flex flex-col gap-[10px] px-4 pt-[12px]">
        <label htmlFor="player-search" className="font-mono text-[11px] tracking-[1px] text-muted">SEARCH {pill === 'ALL' ? 'PLAYERS' : `${pill}S`}</label>
        <div className="flex min-h-[46px] items-center gap-2 rounded-sm border border-frame bg-paper px-3">
          <SearchIcon className="text-muted" />
          <input id="player-search" type="search" placeholder="Name or team" value={q} onChange={(e) => setQ(e.target.value)} className="min-w-0 flex-1 border-0 bg-transparent text-[15px] text-type outline-offset-4" />
        </div>
        {openTimes.length > 1 && (
          <div role="group" aria-label="Filter by window" className="-mx-4 flex gap-[6px] overflow-x-auto px-4">
            {['ALL', ...openTimes].map((t) => (
              <button key={t} type="button" aria-pressed={win === t} onClick={() => setWin(t)} className={`min-h-9 flex-none rounded-sm border px-3 font-mono text-[12px] font-medium ${win === t ? 'border-accent bg-line text-ink' : 'border-frame bg-transparent text-type'}`}>
                {t === 'ALL' ? 'ALL OPEN' : chipLabel(t)}
              </button>
            ))}
          </div>
        )}
        <div className="-mx-4 flex items-center gap-3 overflow-x-auto px-4">
          <div role="group" aria-label="Stat period" className="flex flex-none overflow-hidden rounded-sm border border-frame">
            {(['season', 'last3'] as const).map((p) => (
              <button key={p} type="button" aria-pressed={period === p} onClick={() => setPeriod(p)} className={`min-h-9 px-3 font-mono text-[12px] ${period === p ? 'bg-type text-newsprint' : 'bg-paper text-type'}`}>
                {p === 'season' ? 'SEASON' : 'LAST 3'}
              </button>
            ))}
          </div>
          {!kicker && (
            <div role="group" aria-label="Stat groups" className="flex flex-none gap-[6px]">
              {GROUP_ORDER.map((g) => (
                <button key={g} type="button" aria-pressed={groups.includes(g)} onClick={() => toggleGroup(g)} className={pillClass(groups.includes(g))}>
                  {GROUP_LABEL[g]}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {pool.isPending ? (
        <Loading label="Loading players" />
      ) : pool.isError ? (
        <div className="p-4"><ErrorNote>{errorText(pool.error)}</ErrorNote></div>
      ) : (
        <>
        <p className="mx-4 mt-[10px] mb-0 font-mono text-[11px] text-muted" aria-hidden="true">
          {kicker ? 'KICKS: TOTALS · PTS: PER GAME' : 'COUNTS: TOTALS · YDS, PTS: PER GAME'}
        </p>
        <div className="mx-4 mt-[6px] overflow-x-auto rounded-sm border border-rule" tabIndex={0} role="region" aria-label="Players and stats; scrolls sideways">
          <table className="w-full border-collapse text-left" aria-label={`Players for ${SLOT_LABEL[slot]}`}>
            <caption className="sr-only">
              {`Players for ${SLOT_LABEL[slot]}, ${period === 'season' ? 'this season' : 'over the last 3 games'}: counts are totals, yards and points are per game. ${sort ? `Sorted by ${columns.find((c) => c.id === sort.col)?.name}, ${sort.dir === 'desc' ? 'highest' : 'lowest'} first.` : 'Sorted by fantasy points this season.'}`}
            </caption>
            <thead>
              <tr className="bg-chrome font-mono text-[10px] tracking-[1px] text-muted">
                <th scope="col" rowSpan={2} className="sticky left-0 z-[2] w-[144px] min-w-[144px] bg-chrome px-3 py-2 align-bottom text-[11px] font-medium">PLAYER</th>
                {groupHeads.map((g, i) => (
                  <th key={`${g.label}-${i}`} scope="colgroup" colSpan={g.span} className="border-l border-rule px-2 pt-2 text-center font-medium">{g.label}</th>
                ))}
              </tr>
              <tr className="bg-chrome font-mono text-[11px] text-muted">
                {columns.map((c) => {
                  const on = sort?.col === c.id;
                  return (
                    <th key={c.id} scope="col" aria-sort={on ? (sort!.dir === 'desc' ? 'descending' : 'ascending') : 'none'} className={`px-1 pb-2 text-right font-medium whitespace-nowrap ${on ? 'bg-line/10 text-type' : ''}`}>
                      <button type="button" title={c.name} aria-label={`${c.label}: ${c.name}, sort`} onClick={() => setSort(nextSort(sort, c.id))} className="min-h-9 min-w-[40px] px-1 text-right font-mono text-[11px] text-inherit">
                        {c.label}
                        {on && <span aria-hidden="true">{sort!.dir === 'desc' ? ' ▼' : ' ▲'}</span>}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr><td colSpan={columns.length + 1} className="p-4 text-center text-[14px] text-muted">No players match.</td></tr>
              )}
              {shown.map(({ p, why }) => (
                <PlayerRow key={p.playerId} p={p} why={why} columns={columns} block={p.stats?.[period] ?? null} sortCol={sort?.col ?? null} onSelect={() => choose(p)} />
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}

      {burnedCount > 0 && (
        <div className="mx-4 mt-[14px] mb-6 flex items-center justify-between rounded-sm border border-rule px-[14px] py-3">
          <label htmlFor="show-burned" className="text-[14px]">Show players I’ve burned ({burnedCount})</label>
          <input id="show-burned" type="checkbox" checked={showBurned} onChange={(e) => setShowBurned(e.target.checked)} className="size-[22px] accent-accent" />
        </div>
      )}
      <div className="pb-24" />
      </main>
    </Page>
  );
}

function PlayerRow({ p, why, columns, block, sortCol, onSelect }: { p: PlayerCard; why: Why | null; columns: Column[]; block: StatBlock | null; sortCol: string | null; onSelect: () => void }) {
  const where = p.opponent ? `${p.homeAway === 'home' ? 'vs' : '@'} ${p.opponent}` : null;
  const burned = p.unavailableReason === 'BURNED';
  const meta = (
    <span className={`block truncate text-[11px] ${why ? 'text-steel' : 'text-muted'}`}>
      <b className="font-mono font-medium">{p.position}</b> · {p.team}
      {where && ` · ${where}`}
      {!why && p.scheduledEt && <span className="sr-only">{`, ${dayTimeET(p.scheduledEt)} ET`}</span>}
      {!why && CAUTION_STATUSES.has(p.injuryStatus) && <> · <b className="text-live">{p.injuryStatus}</b></>}
    </span>
  );
  return (
    <tr aria-disabled={why ? 'true' : undefined} className="border-t border-rule">
      <th scope="row" className={`sticky left-0 z-[1] w-[144px] max-w-[144px] p-0 text-left font-normal ${why ? 'bg-newsprint' : 'bg-paper'}`}>
        {why ? (
          <span className="flex flex-col gap-[2px] px-3 py-[8px]">
            <span className={`truncate font-mono text-[13px] font-medium ${burned ? 'text-pencil line-through' : 'text-steel'}`}>{p.name}</span>
            {meta}
            <span className="flex items-center gap-1 self-start border border-frame px-[5px] font-mono text-[10px] font-medium text-steel">
              {why.tag === 'LOCKED' && <LockIcon />}
              {why.tag}
              <span className="sr-only">{`: ${why.text}`}</span>
            </span>
          </span>
        ) : (
          // The whole name cell picks the player: a big target, and rows stay short so more players fit.
          <button type="button" onClick={onSelect} className="flex min-h-[52px] w-full flex-col justify-center gap-[2px] border-l-[3px] border-l-accent px-3 py-[6px] text-left hover:bg-line/10">
            <span className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-[13px] font-medium text-type"><span className="sr-only">Select </span>{p.name}</span>
              <span aria-hidden="true" className="flex-none font-mono text-[15px] leading-none text-accent">+</span>
            </span>
            {meta}
          </button>
        )}
      </th>
      {columns.map((c) => (
        <td key={c.id} className={`tnum px-2 text-right font-mono text-[12px] whitespace-nowrap ${why ? 'text-steel' : 'text-type'} ${sortCol === c.id ? 'bg-line/10' : ''}`}>
          {cell(c, block)}
        </td>
      ))}
    </tr>
  );
}
