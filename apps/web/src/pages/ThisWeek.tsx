/** This Week (PRD-007 §6.2, approved mockup "Main"). */
import { Link } from 'react-router';
import { useBurns, useFieldMe, useLineup, useMe, useRefetchAtLocks, useUnread, useWindows } from '../api/hooks';
import type { GameWindow, LineupSlot, Notification } from '../api/types';
import { ErrorNote, Loading, Panel, SectionTitle, TabPage, useScreen } from '../components/layout';
import { useCurrentWeek } from '../lineup/context';
import { nextLock } from '../lineup/shared';
import { errorText } from '../lib/errors';
import { noticeView, type NoticeContext } from '../lib/notices';
import { countdown, dateLineET, points, shortName, timeET, dayET } from '../lib/format';
import { anyWindowOpen, SLOT_LABEL, SLOT_ORDER, slotState, VOID_TEXT, windowFor } from '../lib/slots';
import { useServerNow } from '../lib/useClock';

export function ThisWeekPage() {
  useScreen('this_week', 'This Week');
  const now = useServerNow();
  const { season, week, query } = useCurrentWeek();
  const windows = useWindows(season, week);
  const lineup = useLineup(season, week);
  const burns = useBurns(season);
  const field = useFieldMe(season);
  const inbox = useUnread();
  const meQ = useMe();
  useRefetchAtLocks(season, week, (windows.data ?? []).map((w) => Date.parse(w.scheduledEt)));

  const err = query.error ?? windows.error ?? lineup.error;
  if (err) return <TabPage><div className="p-4"><ErrorNote>{errorText(err)}</ErrorNote></div></TabPage>;
  if (query.isSuccess && week === null) {
    return (
      <TabPage>
        <section className="flex flex-col gap-2 px-4 pt-6">
          <span className="font-mono text-[12px] tracking-[1px] text-muted">{dateLineET(now)} · OFFICIAL TIME</span>
          <h1 className="m-0 font-mono text-[40px] leading-none font-medium">Off week</h1>
          <p className="m-0 text-[15px] text-muted">No games are scheduled right now.</p>
        </section>
      </TabPage>
    );
  }
  if (!week || !windows.data || !lineup.data) return <TabPage><Loading /></TabPage>;

  const me = field.data?.me ?? null;
  const elig = lineup.data.eligibility;
  const freePlayOver = elig.freePlayThroughWeek !== null && week > elig.freePlayThroughWeek;
  const open = anyWindowOpen(windows.data, now);
  const filled = lineup.data.slots.filter((s) => s.playerId && !s.voidReason).length;
  const unread = (inbox.data?.items ?? []).filter((n) => !n.read).slice(0, 3);
  const noticeCtx: NoticeContext = { players: inbox.data?.players ?? {}, currentWeek: week, myHandle: meQ.data?.handle ?? null };

  return (
    <TabPage>
      <section className="flex flex-col gap-[6px] px-4 pt-[22px] pb-2">
        <span className="font-mono text-[12px] tracking-[1px] text-muted">{dateLineET(now)} · OFFICIAL TIME</span>
        <div className="flex items-end justify-between">
          <h1 className="m-0 font-mono text-[52px] leading-none font-medium tracking-[-1px]">Week {week}</h1>
          {me && (
            <div className="flex flex-col items-end gap-[2px]">
              <span className="font-mono text-[30px] leading-none font-medium text-accent">#{me.rank}</span>
              <span className="text-[12px] text-muted">of {field.data!.fieldSize} managers</span>
            </div>
          )}
        </div>
        <div className="mt-[6px] flex flex-wrap gap-4 text-[13px] text-muted">
          {me ? (
            <>
              <span><b className="tnum text-type">{points(me.pointsX100)}</b> season pts</span>
              <span><b className="tnum text-type">{points(me.weekPointsX100)}</b> this week</span>
            </>
          ) : (
            <span>Not on the board yet: confirm a lineup to join it.</span>
          )}
        </div>
      </section>

      {freePlayOver && (
        <div className="mx-4 mt-3"><ErrorNote>Lineups are closed for the rest of this season.</ErrorNote></div>
      )}

      {unread.length > 0 && (
        <Panel className="mx-4 mt-3 flex flex-col gap-[10px]">
          <div className="flex items-center justify-between">
            <h2 className="m-0 font-mono text-[12px] font-medium tracking-[1px] text-muted">SINCE YOUR LAST VISIT</h2>
            <Link to="/inbox" className="text-[13px]">{inbox.data!.unread} unread · Inbox</Link>
          </div>
          {unread.map((n) => (
            <InboxLine key={n.id} n={n} ctx={noticeCtx} />
          ))}
        </Panel>
      )}

      <section className="flex flex-col gap-[10px] px-4 pt-6">
        <div className="flex flex-col gap-1">
          <SectionTitle>THIS WEEK’S LOCKS</SectionTitle>
          <span className="text-[12px] text-muted">Locks at scheduled kickoff, not actual kickoff. All times ET. <Link to="/help">Rules</Link></span>
        </div>
        <ol className="m-0 flex list-none flex-col overflow-hidden rounded-sm border border-rule p-0" aria-label="Game windows">
          {windows.data.map((w, i) => (
            <WindowRow key={w.id} w={w} now={now} slots={lineup.data!.slots} windows={windows.data!} isNext={nextLock(windows.data!, now)?.id === w.id} last={i === windows.data!.length - 1} />
          ))}
        </ol>
      </section>

      <section className="flex flex-col gap-[10px] px-4 pt-6">
        <SectionTitle aside={<span className="font-mono text-[12px] text-muted">{filled} / 9 SET</span>}>YOUR LINEUP</SectionTitle>
        <ul className="m-0 grid list-none grid-cols-3 gap-[6px] p-0" aria-label="Your nine slots">
          {SLOT_ORDER.map((slot) => {
            const s = lineup.data!.slots.find((x) => x.slot === slot)!;
            return <SlotTile key={slot} s={s} windows={windows.data!} burnPts={burns.data?.find((b) => b.week === week && b.slot === slot)?.pointsX100} />;
          })}
        </ul>
        {open && !freePlayOver && <Link to="/lineup" className="btn-primary mt-2">EDIT LINEUP</Link>}
        {(burns.data?.length ?? 0) > 0 && (
          <Link to="/burned" className="self-start text-[13px]">
            {burns.data!.length} burned this season · Burned roster
          </Link>
        )}
      </section>
    </TabPage>
  );
}

function WindowRow({ w, now, slots, windows, isNext, last }: { w: GameWindow; now: number; slots: LineupSlot[]; windows: GameWindow[]; isNext: boolean; last: boolean }) {
  const t = Date.parse(w.scheduledEt);
  const mine = slots.filter((s) => s.playerId && !s.voidReason && windowFor(s.scheduledEt, windows)?.id === w.id).map((s) => SLOT_LABEL[s.slot]);
  const who = mine.length === 0 ? 'None of your players' : `${mine.length} of your players · ${mine.join(', ')}`;
  const label = w.label.includes('·') ? w.label : `${w.label} · ${timeET(w.scheduledEt)}`;
  const closed = w.status !== 'pending' || t <= now;
  const border = last ? '' : 'border-b border-rule';
  let right;
  if (w.status === 'final') right = <span className="font-mono text-[11px] font-medium text-pencil">{mine.length ? 'BURNED · FINAL' : 'FINAL'}</span>;
  else if (w.status === 'canceled') right = <span className="font-mono text-[11px] font-medium text-steel">CANCELED</span>;
  else if (closed) right = <span className="bg-bulb px-[6px] py-[2px] font-mono text-[11px] font-medium text-ink">LOCKED · LIVE</span>;
  else if (isNext)
    right = (
      <div className="flex flex-col items-end gap-1">
        <span className="bg-bulb px-[6px] py-[2px] font-mono text-[11px] font-medium text-ink">NEXT LOCK</span>
        <span role="timer" aria-label={`Locks ${dayET(w.scheduledEt)} ${timeET(w.scheduledEt)} ET`} className="tnum font-mono text-[18px] font-medium text-live">{countdown(t - now, w.scheduledEt)}</span>
      </div>
    );
  else right = <span role="timer" aria-label={`Locks ${dayET(w.scheduledEt)} ${timeET(w.scheduledEt)} ET`} className="tnum font-mono text-[13px] text-muted">{countdown(t - now, w.scheduledEt)}</span>;
  return (
    <li className={`flex items-center justify-between gap-3 px-[14px] py-3 ${border} ${isNext ? 'bg-bulb/14' : 'bg-paper'}`}>
      <div className="flex flex-col gap-[2px]">
        <span className={`text-[14px] font-semibold ${w.status === 'final' ? 'text-steel' : ''}`}>{label} <span className="font-normal text-muted">ET</span></span>
        <span className={`text-[12px] ${w.status === 'final' ? 'text-steel' : 'text-muted'}`}>{who}</span>
      </div>
      {right}
    </li>
  );
}

export function SlotTile({ s, windows, burnPts }: { s: LineupSlot; windows: GameWindow[]; burnPts?: number }) {
  const state = slotState(s, windows);
  const label = SLOT_LABEL[s.slot];
  const box = 'flex flex-col gap-1 rounded-sm p-[10px]';
  const when = s.scheduledEt ? `${dayET(s.scheduledEt)} ${timeET(s.scheduledEt).replace(/ (AM|PM)$/, '')}` : '';
  switch (state) {
    case 'BURNED':
      return (
        <li className={`${box} border border-pencil bg-pencil/14`}>
          <span className="font-mono text-[11px] text-burnt">{label} · BURNED</span>
          <span className="text-[13px] font-semibold text-burnt line-through">{shortName(s.name)}</span>
          <span className="tnum text-[11px] text-muted">{burnPts !== undefined ? `${points(burnPts)} pts` : 'Final'}</span>
        </li>
      );
    case 'LOCKED':
      return (
        <li className={`${box} border border-live bg-bulb/14`}>
          <span className="font-mono text-[11px] text-live">{label} · LIVE</span>
          <span className="text-[13px] font-semibold">{shortName(s.name)}</span>
          <span className="text-[11px] text-muted">Locked {when}</span>
        </li>
      );
    case 'VOIDED':
      return (
        <li className={`${box} border border-dashed border-live bg-transparent`}>
          <span className="font-mono text-[11px] text-live">{label} · OPEN</span>
          <span className="text-[13px] font-semibold">Voided</span>
          <span className="text-[11px] text-muted">{shortName(s.name)}: {VOID_TEXT[s.voidReason!].split('.')[0]}</span>
        </li>
      );
    case 'EMPTY':
      return (
        <li className={`${box} border border-dashed border-frame bg-transparent`}>
          <span className="font-mono text-[11px] text-muted">{label}</span>
          <span className="text-[13px] font-semibold text-muted">Empty</span>
          <span className="text-[11px] text-muted">0 pts, no burn</span>
        </li>
      );
    default:
      return (
        <li className={`${box} border border-rule bg-paper`}>
          <span className="font-mono text-[11px] text-muted">{label}{s.position === 'FB' ? ' · FB' : ''}</span>
          <span className="text-[13px] font-semibold">{shortName(s.name)}</span>
          <span className="text-[11px] text-muted">{when}</span>
        </li>
      );
  }
}

function InboxLine({ n, ctx }: { n: Notification; ctx: NoticeContext }) {
  const t = noticeView(n, ctx);
  const body = (
    <>
      <span className={`mt-[2px] flex-none font-mono text-[11px] font-medium ${t.tone}`}>{t.tag}</span>
      <span className="text-[14px] leading-[1.4] text-type">{t.text}</span>
    </>
  );
  return t.to ? (
    <Link to={t.to} className="flex items-start gap-[10px] no-underline hover:underline">{body}</Link>
  ) : (
    <div className="flex items-start gap-[10px]">{body}</div>
  );
}
