/**
 * Inbox (PRD-007 §6.6): every in-app notice, newest first, with per-item read
 * state and "mark all read". Each notice links to what it's about; opening
 * one marks it read.
 */
import { Link } from 'react-router';
import { useInbox, useMarkRead, useMe } from '../api/hooks';
import type { Notification } from '../api/types';
import { ErrorNote, Loading, TabPage, useScreen } from '../components/layout';
import { useCurrentWeek } from '../lineup/context';
import { errorText } from '../lib/errors';
import { dayET, timeET } from '../lib/format';
import { noticeView, type NoticeContext } from '../lib/notices';

const dateFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });

export function InboxPage() {
  useScreen('inbox', 'Inbox');
  const inbox = useInbox();
  const mark = useMarkRead();
  const me = useMe();
  const { week } = useCurrentWeek();

  if (inbox.error && !inbox.data) return <TabPage><div className="p-4"><ErrorNote>{errorText(inbox.error)}</ErrorNote></div></TabPage>;
  if (!inbox.data) return <TabPage><Loading /></TabPage>;
  const pages = inbox.data.pages;
  const items = pages.flatMap((p) => p.items);
  const unread = pages[0]?.unread ?? 0;
  const ctx: NoticeContext = {
    players: Object.assign({}, ...pages.map((p) => p.players)),
    currentWeek: week,
    myHandle: me.data?.handle ?? null,
  };

  return (
    <TabPage>
      <section className="flex items-end justify-between gap-3 px-4 pt-[22px] pb-2">
        <div className="flex flex-col gap-[6px]">
          <h1 className="m-0 font-mono text-[40px] leading-none font-medium tracking-[-1px]">Inbox</h1>
          <span className="text-[13px] text-muted" role="status">{unread === 0 ? 'All read' : `${unread} unread`}</span>
        </div>
        <button type="button" className="btn-outline min-h-11 px-4" disabled={unread === 0 || mark.isPending} onClick={() => mark.mutate({ all: true })}>
          MARK ALL READ
        </button>
      </section>
      {mark.isError && <div className="mx-4"><ErrorNote>{errorText(mark.error)}</ErrorNote></div>}

      {items.length === 0 ? (
        <p className="mx-4 mt-4 rounded-sm border border-dashed border-frame p-[14px] text-[14px] text-muted">
          No notices yet. Locks, burns and anything that changes your lineup show up here.
        </p>
      ) : (
        <ul className="m-0 mt-2 flex list-none flex-col gap-2 px-4 pt-2" aria-label="Notices">
          {items.map((n) => (
            <Item key={n.id} n={n} ctx={ctx} onOpen={() => !n.read && mark.mutate({ ids: [n.id] })} />
          ))}
        </ul>
      )}

      {inbox.hasNextPage && (
        <div className="px-4 pt-4">
          <button type="button" className="btn-outline min-h-11 w-full" disabled={inbox.isFetchingNextPage} onClick={() => void inbox.fetchNextPage()}>
            {inbox.isFetchingNextPage ? 'LOADING…' : 'OLDER NOTICES'}
          </button>
        </div>
      )}
    </TabPage>
  );
}

function Item({ n, ctx, onOpen }: { n: Notification; ctx: NoticeContext; onOpen: () => void }) {
  const v = noticeView(n, ctx);
  const when = `${dayET(n.createdAt)}, ${dateFmt.format(new Date(n.createdAt))} · ${timeET(n.createdAt)} ET${v.week !== null ? ` · Week ${v.week}` : ''}`;
  const box = `flex flex-col gap-1 rounded-sm border px-[14px] py-3 ${n.read ? 'border-rule bg-paper' : 'border-line/60 border-l-[3px] border-l-line bg-line/5'}`;
  const content = (
    <>
      <span className="flex items-center gap-2 font-mono text-[11px] font-medium">
        {!n.read && <span className="text-line">NEW</span>}
        <span className={v.tone}>{v.tag}</span>
      </span>
      <span className="text-[14px] leading-[1.45] text-type">{v.text}</span>
      <span className="text-[12px] text-muted">{when}</span>
    </>
  );
  if (v.to) {
    return (
      <li>
        <Link to={v.to} onClick={onOpen} className={`${box} no-underline hover:border-frame`}>{content}</Link>
      </li>
    );
  }
  return (
    <li className={box}>
      {content}
      {!n.read && (
        <button type="button" className="mt-1 self-start font-mono text-[12px] text-line underline" onClick={onOpen}>Mark read</button>
      )}
    </li>
  );
}
