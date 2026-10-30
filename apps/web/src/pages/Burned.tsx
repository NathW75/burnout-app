/**
 * Burned roster (PRD-007 §6.4): every player I've burned this season, week by
 * week, with his slot, the window he burned in and what he scored. Read-only.
 */
import { Link } from 'react-router';
import { useBurns, useSeason } from '../api/hooks';
import type { Burn } from '../api/types';
import { ErrorNote, Loading, SectionTitle, TabPage, useScreen } from '../components/layout';
import { errorText } from '../lib/errors';
import { pointsExact, pointsSigned } from '../lib/format';
import { SLOT_LABEL } from '../lib/slots';

/** Weeks newest first; within a week, in the order they burned. */
export function groupByWeek(burns: Burn[]): Array<{ week: number; burns: Burn[] }> {
  const map = new Map<number, Burn[]>();
  for (const b of [...burns].sort((a, c) => Date.parse(a.burnedAt) - Date.parse(c.burnedAt))) {
    map.set(b.week, [...(map.get(b.week) ?? []), b]);
  }
  return [...map.entries()].sort((a, c) => c[0] - a[0]).map(([week, list]) => ({ week, burns: list }));
}

export function BurnedPage() {
  useScreen('burned_roster', 'Burned roster');
  const season = useSeason();
  const burns = useBurns(season.data?.season);

  const err = season.error ?? burns.error;
  if (err) return <TabPage><div className="p-4"><ErrorNote>{errorText(err)}</ErrorNote></div></TabPage>;
  if (!burns.data) return <TabPage><Loading /></TabPage>;
  const list = burns.data;
  const total = list.reduce((sum, b) => sum + b.pointsX100, 0);

  return (
    <TabPage>
      <section className="flex flex-col gap-[6px] px-4 pt-[22px] pb-2">
        <h1 className="m-0 font-mono text-[40px] leading-none font-medium tracking-[-1px]">Burned</h1>
        <p className="m-0 text-[13px] leading-[1.45] text-muted">
          A player in your lineup when his window locks is burned once his game goes Final. He’s gone for the rest of the season. <Link to="/help">The rules</Link>
        </p>
      </section>

      {list.length === 0 ? (
        <section className="px-4 pt-4">
          <p className="m-0 rounded-sm border border-dashed border-frame p-[14px] text-[14px] text-muted">No one burned yet. Your first burns land when a locked player’s game goes Final.</p>
        </section>
      ) : (
        <>
          <div className="mx-4 mt-2 flex gap-6 rounded-sm border border-rule bg-paper p-[14px]">
            <div className="flex flex-col">
              <span className="tnum font-mono text-[28px] leading-none font-medium text-pencil">{list.length}</span>
              <span className="mt-1 text-[12px] text-muted">{list.length === 1 ? 'player' : 'players'} burned</span>
            </div>
            <div className="flex flex-col">
              <span className="tnum font-mono text-[28px] leading-none font-medium">{pointsExact(total)}</span>
              <span className="mt-1 text-[12px] text-muted">pts they scored</span>
            </div>
          </div>
          {groupByWeek(list).map((g) => (
            <section key={g.week} className="flex flex-col gap-[10px] px-4 pt-6">
              <SectionTitle aside={<span className="tnum font-mono text-[12px] text-muted">{pointsExact(g.burns.reduce((s, b) => s + b.pointsX100, 0))} PTS</span>}>WEEK {g.week}</SectionTitle>
              <ul className="m-0 flex list-none flex-col overflow-hidden rounded-sm border border-rule p-0" aria-label={`Burned in Week ${g.week}`}>
                {g.burns.map((b, i) => (
                  <li key={`${b.playerId}-${b.week}`} className={`flex flex-col gap-2 bg-paper px-[14px] py-3 ${i === g.burns.length - 1 ? '' : 'border-b border-rule'}`}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 flex-col gap-[2px]">
                        <span className="font-mono text-[11px] text-pencil">{b.slot ? SLOT_LABEL[b.slot] : 'SLOT'} · BURNED</span>
                        <span className="truncate text-[15px] font-semibold text-pencil line-through decoration-1">{b.name ?? b.playerId}</span>
                        <span className="text-[12px] text-muted">{[b.position, b.team].filter(Boolean).join(' · ')} · {b.windowLabel}</span>
                      </div>
                      <span className="tnum flex-none font-mono text-[15px] font-medium">{pointsExact(b.pointsX100)}<span className="ml-1 text-[11px] text-muted">pts</span></span>
                    </div>
                    <Breakdown b={b} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </TabPage>
  );
}

/**
 * Where a burned player's points came from (transparency: Nath, 2026-10-30):
 * every stat he recorded, with what it earned, adding up to his total.
 */
function Breakdown({ b }: { b: Burn }) {
  if (b.breakdown === undefined) return null;
  if (b.breakdown === null) return <p className="m-0 text-[12px] text-muted">Stat line on its way from the stats feed.</p>;
  if (b.breakdown.length === 0) return <p className="m-0 text-[12px] text-muted">No scoring stats recorded: 0 points.</p>;
  return (
    <table className="w-full border-collapse text-[12px]">
      <caption className="sr-only">{`How ${b.name ?? b.playerId}'s ${pointsExact(b.pointsX100)} points add up`}</caption>
      <thead className="sr-only">
        <tr><th scope="col">Stat</th><th scope="col">Recorded</th><th scope="col">Points</th></tr>
      </thead>
      <tbody>
        {b.breakdown.map((l) => (
          <tr key={l.stat} className="border-t border-rule">
            <th scope="row" className="py-[5px] pr-2 text-left font-normal text-muted">{l.label}</th>
            <td className="tnum py-[5px] pr-3 text-right font-mono">{l.value}</td>
            <td className={`tnum w-[64px] py-[5px] text-right font-mono ${l.pointsX100 < 0 ? 'text-burnt' : ''}`}>{pointsSigned(l.pointsX100)}</td>
          </tr>
        ))}
        <tr className="border-t border-rule">
          <th scope="row" colSpan={2} className="py-[5px] pr-3 text-right font-mono text-[11px] font-medium text-muted">TOTAL · <Link to="/help#scoring">scoring rules</Link></th>
          <td className="tnum py-[5px] text-right font-mono font-medium">{pointsExact(b.pointsX100)}</td>
        </tr>
      </tbody>
    </table>
  );
}
