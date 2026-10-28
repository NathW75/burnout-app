/**
 * Reveal (PRD-007 §6.5, PRD-003 §6): one manager's lineup for a week, showing
 * only players whose window has locked. The server decides what's visible;
 * hidden slots arrive with no player at all, so nothing here can leak one.
 */
import { Link, useParams, useSearchParams } from 'react-router';
import { useFieldBoard, useMe, useReveal, useSeason } from '../api/hooks';
import type { RevealSlot } from '../api/types';
import { ErrorNote, Loading, Page, SubHeader, useScreen } from '../components/layout';
import { errorText, isNotFound } from '../lib/errors';
import { points } from '../lib/format';
import { SLOT_LABEL } from '../lib/slots';

export function ManagerPage() {
  const { handle = '' } = useParams();
  useScreen('manager_reveal', handle);
  const [params, setParams] = useSearchParams();
  const season = useSeason();
  const me = useMe();
  const board = useFieldBoard(season.data?.season, 0, false);
  // Weeks with anything locked; the default is the board's week (the latest with a lock).
  const weeks = (season.data?.weeks ?? []).filter((w) => w.status !== 'upcoming').map((w) => w.week);
  const asked = Number(params.get('week'));
  const week = Number.isInteger(asked) && asked > 0 ? asked : board.data?.week || season.data?.currentWeek || null;
  const reveal = useReveal(season.data?.season, week, handle);
  const own = !!me.data?.handle && me.data.handle.toLowerCase() === handle.toLowerCase();

  let body;
  if (reveal.error) body = <ErrorNote>{isNotFound(reveal.error) ? 'No manager has that handle.' : errorText(reveal.error)}</ErrorNote>;
  else if (!reveal.data) body = <Loading />;
  else {
    const shown = reveal.data.slots.filter((s) => s.state === 'LOCKED');
    const total = shown.reduce((sum, s) => sum + (s.state === 'LOCKED' ? s.pointsX100 : 0), 0);
    body = (
      <>
        <p className="m-0 text-[13px] leading-[1.45] text-muted">
          {own
            ? 'Your full lineup for the week. Other managers see only your locked players.'
            : 'Only players whose window has locked are shown. The rest stay hidden until their window locks.'}
        </p>
        <ul className="m-0 flex list-none flex-col overflow-hidden rounded-sm border border-rule p-0" aria-label={`${reveal.data.handle}, Week ${reveal.data.week}`}>
          {reveal.data.slots.map((s, i) => <SlotRow key={s.slotKey} s={s} last={i === reveal.data!.slots.length - 1} />)}
        </ul>
        {shown.length > 0 && (
          <p className="m-0 text-[13px] text-muted">
            <b className="tnum text-type">{points(total)}</b> pts from {shown.length} locked {shown.length === 1 ? 'player' : 'players'} so far.
          </p>
        )}
      </>
    );
  }

  return (
    <Page>
      <SubHeader title={handle} back="/board" backLabel="Back to standings" />
      <main className="flex flex-1 flex-col gap-4 p-4">
        <div className="flex items-end justify-between gap-3">
          <h1 className="m-0 font-mono text-[30px] leading-none font-medium break-all">{own ? 'Your lineup' : handle}</h1>
          {weeks.length > 0 && (
            <label className="flex items-center gap-2 font-mono text-[12px] text-muted">
              WEEK
              <select
                className="min-h-11 rounded-sm border border-frame bg-paper px-2 font-mono text-[14px] text-type"
                value={week ?? ''}
                onChange={(e) => setParams({ week: e.target.value }, { replace: true })}
              >
                {weeks.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </label>
          )}
        </div>
        {body}
        <Link to="/help" className="self-start text-[13px]">How locks and burns work</Link>
      </main>
    </Page>
  );
}

function SlotRow({ s, last }: { s: RevealSlot; last: boolean }) {
  const label = SLOT_LABEL[s.slotKey];
  const row = `flex items-center justify-between gap-3 px-[14px] py-3 ${last ? '' : 'border-b border-rule'}`;
  const meta = (p: { position: string | null; team: string | null }) => [p.position, p.team].filter(Boolean).join(' · ');
  switch (s.state) {
    case 'LOCKED':
      return (
        <li className={`${row} bg-paper`}>
          <div className="flex min-w-0 flex-col gap-[2px]">
            <span className={`font-mono text-[11px] ${s.burned ? 'text-pencil' : 'text-bulb'}`}>{label} · {s.burned ? 'BURNED' : 'LOCKED'}</span>
            <span className={`truncate text-[15px] font-semibold ${s.burned ? 'text-pencil line-through decoration-1' : ''}`}>{s.player.name ?? s.player.playerId}</span>
            <span className="text-[12px] text-muted">{meta(s.player)}{s.windowLabel ? ` · ${s.windowLabel}` : ''}</span>
          </div>
          <span className="tnum flex-none font-mono text-[15px] font-medium">{points(s.pointsX100)}<span className="ml-1 text-[11px] text-muted">pts</span></span>
        </li>
      );
    case 'SUBMITTED':
      return (
        <li className={`${row} bg-paper`}>
          <div className="flex min-w-0 flex-col gap-[2px]">
            <span className="font-mono text-[11px] text-muted">{label} · NOT LOCKED</span>
            <span className="truncate text-[15px] font-semibold">{s.player.name ?? s.player.playerId}</span>
            <span className="text-[12px] text-muted">{meta(s.player)}{s.windowLabel ? ` · ${s.windowLabel}` : ''} · hidden from others</span>
          </div>
        </li>
      );
    case 'VOIDED':
      return (
        <li className={`${row} bg-transparent`}>
          <div className="flex min-w-0 flex-col gap-[2px]">
            <span className="font-mono text-[11px] text-bulb">{label} · VOIDED</span>
            <span className="truncate text-[15px] font-semibold">{s.player.name ?? s.player.playerId}</span>
            <span className="text-[12px] text-muted">Voided before his lock. Not burned.</span>
          </div>
        </li>
      );
    case 'EMPTY':
      return (
        <li className={`${row} bg-transparent`}>
          <div className="flex flex-col gap-[2px]">
            <span className="font-mono text-[11px] text-muted">{label}</span>
            <span className="text-[15px] font-semibold text-muted">Empty</span>
          </div>
        </li>
      );
    default:
      return (
        <li className={`${row} bg-transparent`}>
          <div className="flex flex-col gap-[2px]">
            <span className="font-mono text-[11px] text-muted">{label}</span>
            <span className="text-[15px] text-muted">Hidden until its window locks</span>
          </div>
        </li>
      );
  }
}
