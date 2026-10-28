/** This Week (PRD-007 §6.2, approved mockup "Main"). */
import { Link } from 'react-router';
import { useBurns, useFieldMe, useLineup, useRefetchAtLocks, useUnread, useWindows } from '../api/hooks';
import type { GameWindow, LineupSlot, Notification } from '../api/types';
import { ErrorNote, Loading, Panel, SectionTitle, TabPage, useScreen } from '../components/layout';
import { useCurrentWeek } from '../lineup/context';
import { nextLock } from '../lineup/shared';
import { errorText } from '../lib/errors';
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
  const freePlay = !elig.prizeEligible;
  const freePlayOver = elig.freePlayThroughWeek !== null && week > elig.freePlayThroughWeek;
  const open = anyWindowOpen(windows.data, now);
  const filled = lineup.data.slots.filter((s) => s.playerId && !s.voidReason).length;
  const unread = (inbox.data?.items ?? []).filter((n) => !n.read).slice(0, 3);

  return (
    <TabPage>
      <section className="flex flex-col gap-[6px] px-4 pt-[22px] pb-2">
        <span className="font-mono text-[12px] tracking-[1px] text-muted">{dateLineET(now)} · OFFICIAL TIME</span>
        <div className="flex items-end justify-between">
          <h1 className="m-0 font-mono text-[52px] leading-none font-medium tracking-[-1px]">Week {week}</h1>
          {me && (
            <div className="flex flex-col items-end gap-[2px]">
              <span className="font-mono text-[30px] leading-none font-medium text-line">#{me.rank}</span>
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
          {freePlay && <span>Free play</span>}
        </div>
      </section>

      {freePlayOver && (
        <div className="mx-4 mt-3"><ErrorNote>Free play ended after Week {elig.freePlayThroughWeek}. Enter a pool to keep playing this season.</ErrorNote></div>
      )}

      {unread.length > 0 && (
        <Panel className="mx-4 mt-3 flex flex-col gap-[10px]">
          <div className="flex items-center justify-between">
            <h2 className="m-0 font-mono text-[12px] font-medium tracking-[1px] text-muted">SINCE YOUR LAST VISIT</h2>
            <span className="text-[13px] text-muted">{inbox.data!.unread} unread</span>
          </div>
          {unread.map((n) => (
            <InboxLine key={n.id} n={n} />
          ))}
        </Panel>
      )}

      <section className="flex flex-col gap-[10px] px-4 pt-6">
        <div className="flex flex-col gap-1">
          <SectionTitle>THIS WEEK’S LOCKS</SectionTitle>
          <span className="text-[12px] text-muted">Locks at scheduled kickoff, not actual kickoff. All times ET.</span>
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
        <span role="timer" aria-label={`Locks ${dayET(w.scheduledEt)} ${timeET(w.scheduledEt)} ET`} className="tnum font-mono text-[18px] font-medium text-bulb">{countdown(t - now, w.scheduledEt)}</span>
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

function SlotTile({ s, windows, burnPts }: { s: LineupSlot; windows: GameWindow[]; burnPts?: number }) {
  const state = slotState(s, windows);
  const label = SLOT_LABEL[s.slot];
  const box = 'flex flex-col gap-1 rounded-sm p-[10px]';
  const when = s.scheduledEt ? `${dayET(s.scheduledEt)} ${timeET(s.scheduledEt).replace(/ (AM|PM)$/, '')}` : '';
  switch (state) {
    case 'BURNED':
      return (
        <li className={`${box} border border-rule bg-paper`}>
          <span className="font-mono text-[11px] text-pencil">{label} · BURNED</span>
          <span className="text-[13px] font-semibold text-pencil line-through">{shortName(s.name)}</span>
          <span className="tnum text-[11px] text-steel">{burnPts !== undefined ? `${points(burnPts)} pts` : 'Final'}</span>
        </li>
      );
    case 'LOCKED':
      return (
        <li className={`${box} border border-bulb bg-bulb/14`}>
          <span className="font-mono text-[11px] text-bulb">{label} · LIVE</span>
          <span className="text-[13px] font-semibold">{shortName(s.name)}</span>
          <span className="text-[11px] text-muted">Locked {when}</span>
        </li>
      );
    case 'VOIDED':
      return (
        <li className={`${box} border border-dashed border-bulb bg-transparent`}>
          <span className="font-mono text-[11px] text-bulb">{label} · OPEN</span>
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

/** One inbox notice in plain words (the full inbox is patch b). */
export function noticeText(n: Notification): { tag: string; tone: string; text: string } {
  const p = n.payload as Record<string, unknown>;
  const slot = typeof p.slot === 'string' && p.slot in SLOT_LABEL ? SLOT_LABEL[p.slot as keyof typeof SLOT_LABEL] : null;
  const name = typeof p.playerName === 'string' ? shortName(p.playerName) : null;
  const count = Array.isArray(p.players) ? p.players.length : 0;
  const players = count === 1 ? '1 player' : `${count} players`;
  switch (n.kind) {
    case 'BURN':
      return { tag: 'BURNED', tone: 'text-pencil', text: `${players} burned: their games went Final.` };
    case 'LOCK':
      return { tag: 'LOCKED', tone: 'text-bulb', text: `${typeof p.windowLabel === 'string' ? p.windowLabel : 'A window'} locked with ${players} of yours.` };
    case 'SUBMISSION_VOIDED':
      return {
        tag: 'VOIDED',
        tone: 'text-bulb',
        text: `${name ?? 'Your pick'} was voided${p.reason === 'PLAYER_INACTIVE' ? `: listed ${typeof p.injuryStatus === 'string' ? p.injuryStatus : 'Out'} before his lock` : p.reason === 'PLAYER_NO_GAME' ? ': no game this week' : p.reason === 'PLAYER_MERGED' ? ': he was listed twice and is already in your lineup' : ''}. Not burned.${slot ? ` ${slot} is open.` : ''}`,
      };
    case 'SUBMISSION_REPOINTED':
      return { tag: 'MOVED', tone: 'text-bulb', text: `${name ?? 'Your pick'} changed teams. ${slot ?? 'His slot'} now locks with ${typeof p.newWindowLabel === 'string' ? p.newWindowLabel : 'his new game'}.` };
    case 'SLOT_REOPENED':
      return { tag: 'REOPENED', tone: 'text-bulb', text: `${slot ?? 'A slot'} reopened after a game disruption.` };
    case 'LINEUP_RECEIPT':
      return { tag: 'CONFIRMED', tone: 'text-line', text: typeof p.week === 'number' ? `Week ${p.week} lineup confirmed.` : 'Lineup confirmed.' };
    case 'SCORE_CORRECTION':
      return { tag: 'SCORE', tone: 'text-muted', text: 'A stat correction changed your points.' };
    default:
      return { tag: n.kind.replace(/_/g, ' '), tone: 'text-muted', text: 'New notice.' };
  }
}

function InboxLine({ n }: { n: Notification }) {
  const t = noticeText(n);
  return (
    <div className="flex items-start gap-[10px]">
      <span className={`mt-[2px] flex-none font-mono text-[11px] font-medium ${t.tone}`}>{t.tag}</span>
      <p className="m-0 text-[14px] leading-[1.4]">{t.text}</p>
    </div>
  );
}
