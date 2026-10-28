/**
 * Standings (PRD-007 §6.5): the season field board. Rank, handle, this week's
 * and the season's points; my row is always visible; paging is server-side.
 * Tapping a manager opens their locked picks (the reveal).
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { BOARD_PAGE, useFieldBoard, useWindows } from '../api/hooks';
import type { FieldRow } from '../api/types';
import { ErrorNote, Loading, Panel, SectionTitle, TabPage, useScreen } from '../components/layout';
import { useCurrentWeek } from '../lineup/context';
import { errorText } from '../lib/errors';
import { clockET, points } from '../lib/format';

export function StandingsPage() {
  useScreen('standings', 'Standings');
  const { season, week } = useCurrentWeek();
  const windows = useWindows(season, week);
  // Live while any window this week is locked and not yet Final: scores move every 15 minutes.
  const live = (windows.data ?? []).some((w) => w.status === 'locked');
  const [offset, setOffset] = useState(0);
  const board = useFieldBoard(season, offset, live);

  if (board.error && !board.data) return <TabPage><div className="p-4"><ErrorNote>{errorText(board.error)}</ErrorNote></div></TabPage>;
  if (!board.data) return <TabPage><Loading /></TabPage>;
  const b = board.data;
  const me = b.me;
  const meOnPage = !!me && b.rows.some((r) => r.isMe);
  const last = Math.min(b.offset + b.rows.length, b.fieldSize);

  return (
    <TabPage>
      <section className="flex flex-col gap-[6px] px-4 pt-[22px] pb-2">
        <h1 className="m-0 font-mono text-[40px] leading-none font-medium tracking-[-1px]">Standings</h1>
        <p className="m-0 text-[13px] leading-[1.45] text-muted">
          Season field · {b.fieldSize} {b.fieldSize === 1 ? 'manager' : 'managers'}. Free play: these aren’t prize standings.
          {b.week > 0 && <> The WEEK column is Week {b.week}.</>}
        </p>
      </section>

      {me ? (
        <Panel className="mx-4 mt-2 flex items-center justify-between gap-3">
          <div className="flex flex-col gap-[2px]">
            <span className="font-mono text-[11px] tracking-[1px] text-muted">YOU · {me.handle}</span>
            <span className="text-[13px] text-muted">
              <b className="tnum text-type">{points(me.pointsX100)}</b> season · <b className="tnum text-type">{points(me.weekPointsX100)}</b> week
            </span>
          </div>
          <span className="font-mono text-[30px] leading-none font-medium text-accent" aria-label={`Rank ${me.rank} of ${b.fieldSize}`}>#{me.rank}</span>
        </Panel>
      ) : (
        <Panel className="mx-4 mt-2"><p className="m-0 text-[14px]">You’re not on the board yet. Confirm a lineup to join it.</p></Panel>
      )}

      <section className="flex flex-col gap-[10px] px-4 pt-6">
        <SectionTitle aside={<span className="font-mono text-[11px] text-muted">{live ? 'LIVE · ' : ''}UPDATED {clockET(board.dataUpdatedAt).toUpperCase()}</span>}>THE FIELD</SectionTitle>
        {b.fieldSize === 0 ? (
          <p className="m-0 text-[14px] text-muted">No one is on the board yet.</p>
        ) : (
          <table className="w-full border-collapse overflow-hidden rounded-sm border border-rule text-left">
            <caption className="sr-only">Season field leaderboard, ranks {b.offset + 1} to {last} of {b.fieldSize}. Tied managers share a rank.</caption>
            <thead>
              <tr className="bg-chrome font-mono text-[11px] tracking-[1px] text-muted">
                <th scope="col" className="w-12 px-3 py-2 font-medium">#</th>
                <th scope="col" className="px-2 py-2 font-medium">MANAGER</th>
                <th scope="col" className="w-16 px-2 py-2 text-right font-medium">WEEK</th>
                <th scope="col" className="w-20 px-3 py-2 text-right font-medium">SEASON</th>
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r) => <Row key={r.handle} r={r} />)}
              {me && !meOnPage && (
                <>
                  <tr aria-hidden="true"><td colSpan={4} className="border-t border-rule bg-paper py-1 text-center font-mono text-[11px] text-steel">· · ·</td></tr>
                  <Row r={me} />
                </>
              )}
            </tbody>
          </table>
        )}
        {b.fieldSize > BOARD_PAGE && (
          <nav aria-label="Board pages" className="flex items-center justify-between gap-3">
            <button type="button" className="btn-outline min-h-11 px-4" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - BOARD_PAGE))}>PREVIOUS</button>
            <span className="tnum text-[13px] text-muted">{b.offset + 1}–{last} of {b.fieldSize}</span>
            <button type="button" className="btn-outline min-h-11 px-4" disabled={last >= b.fieldSize} onClick={() => setOffset(offset + BOARD_PAGE)}>NEXT</button>
          </nav>
        )}
        <p className="m-0 text-[12px] leading-[1.45] text-muted">Tap a manager to see the players they’ve locked. Picks stay hidden until their window locks.</p>
      </section>
    </TabPage>
  );
}

function Row({ r }: { r: FieldRow }) {
  return (
    <tr className={`border-t border-rule ${r.isMe ? 'bg-line/8' : 'bg-paper'}`}>
      <td className={`tnum px-3 py-[10px] font-mono text-[14px] ${r.isMe ? 'text-accent' : ''}`}>{r.rank}</td>
      <td className="px-2 py-[10px] text-[14px] font-semibold">
        <Link to={`/board/${encodeURIComponent(r.handle)}`} className="text-type no-underline hover:underline">{r.handle}</Link>
        {r.isMe && <span className="ml-2 font-mono text-[11px] font-medium text-accent">YOU</span>}
      </td>
      <td className="tnum px-2 py-[10px] text-right text-[14px] text-muted">{points(r.weekPointsX100)}</td>
      <td className="tnum px-3 py-[10px] text-right text-[14px] font-semibold">{points(r.pointsX100)}</td>
    </tr>
  );
}
