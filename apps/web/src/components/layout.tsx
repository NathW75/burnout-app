/**
 * App chrome: the header with the official clock, the bottom nav, and the
 * small shared pieces every screen uses.
 */
import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { setCurrentScreen } from '../api/client';
import { useUnread } from '../api/hooks';
import { clockET } from '../lib/format';
import { useServerNow } from '../lib/useClock';
import { BackIcon, BellIcon, BoardIcon, FlameIcon, HomeIcon, LineupIcon, UserIcon } from './icons';

/** Names the screen for X-Current-Screen and the document title. */
export function useScreen(slug: string, title: string): void {
  useEffect(() => {
    setCurrentScreen(slug);
    document.title = `${title} · Burnout League`;
  }, [slug, title]);
}

export function OfficialClock({ compact = false }: { compact?: boolean }) {
  const now = useServerNow();
  const text = clockET(now);
  return (
    <span role="timer" aria-live="off" className="flex items-center gap-2 font-mono text-[12px] text-muted" aria-label={`Official time ${text}`}>
      {!compact && <span className="size-[7px] rounded-full bg-accent" aria-hidden="true" />}
      <span className="tnum text-type" aria-hidden="true">{compact ? text.replace(/:\d\d (AM|PM)/, ' $1') : text}</span>
    </span>
  );
}

export function Wordmark() {
  return (
    <span className="flex items-center gap-2 font-mono text-[13px] font-medium tracking-[1px] text-type">
      <FlameIcon width={16} height={16} className="text-mark" />
      BURNOUT<span className="max-[379px]:hidden"> LEAGUE</span>
    </span>
  );
}

/** The inbox bell with its unread count (PRD-007 §6.6). The count is text, not just a dot. */
export function InboxBell() {
  const inbox = useUnread();
  const n = inbox.data?.unread ?? 0;
  return (
    <NavLink
      to="/inbox"
      aria-label={n ? `Inbox, ${n} unread` : 'Inbox'}
      className={({ isActive }) => `relative -mr-2 flex size-11 items-center justify-center no-underline ${isActive ? 'text-accent' : 'text-type hover:text-accent'}`}
    >
      <BellIcon />
      {n > 0 && (
        <span aria-hidden="true" className="tnum absolute top-[6px] right-[4px] min-w-[18px] rounded-full bg-pencil px-[5px] text-center font-mono text-[11px] leading-[18px] font-medium text-white">
          {n > 99 ? '99+' : n}
        </span>
      )}
    </NavLink>
  );
}

/** Top bar for the main tabs. */
export function AppHeader() {
  return (
    <header className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-accent bg-chrome py-[6px] pr-4 pl-4">
      <Link to="/" className="no-underline" aria-label="Burnout League, This Week">
        <Wordmark />
      </Link>
      <div className="flex items-center gap-2">
        <OfficialClock />
        <InboxBell />
      </div>
    </header>
  );
}

/** Top bar for a sub-screen: back, title, compact clock. */
export function SubHeader({ title, back, backLabel }: { title: string; back: string; backLabel: string }) {
  return (
    <header className="sticky top-0 z-10 flex items-center justify-between border-b border-accent bg-chrome px-4 py-[10px]">
      <Link to={back} aria-label={backLabel} className="-ml-3 flex size-11 items-center justify-center text-type">
        <BackIcon />
      </Link>
      <h1 className="m-0 font-mono text-[16px] font-medium tracking-[1px]">{title}</h1>
      <OfficialClock compact />
    </header>
  );
}

const tabs = [
  { to: '/', label: 'WEEK', icon: HomeIcon, end: true, also: [] as string[] },
  { to: '/lineup', label: 'LINEUP', icon: LineupIcon, end: false, also: [] }, // the gates live under /lineup, so LINEUP stays lit through them
  { to: '/board', label: 'BOARD', icon: BoardIcon, end: false, also: [] },
  { to: '/burned', label: 'BURNED', icon: FlameIcon, end: false, also: [] },
  { to: '/account', label: 'ACCOUNT', icon: UserIcon, end: false, also: ['/help', '/admin', '/receipts'] }, // reached from Account
];

/** Every signed-in screen sits inside the app shell, which keeps the bottom tabs on screen (PRD-007 §6.2.1, patch c). */
const ShellContext = createContext(false);
export function AppShell({ children }: { children: ReactNode }) {
  return <ShellContext.Provider value={true}>{children}</ShellContext.Provider>;
}
export const useInShell = () => useContext(ShellContext);

/** Bars pinned above the tabs (the lineup and gate footers) use this offset: the tabs' measured height. */
export const ABOVE_NAV = 'bottom-[var(--bl-nav-h,0px)]';

export function BottomNav() {
  const { pathname } = useLocation();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const set = () => root.style.setProperty('--bl-nav-h', `${el.getBoundingClientRect().height}px`);
    set();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(set) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      root.style.removeProperty('--bl-nav-h');
    };
  }, []);
  return (
    <nav ref={ref} data-bottom-bar aria-label="Main" className="sticky bottom-0 z-10 mt-auto grid grid-cols-5 border-t border-rule bg-chrome pb-[env(safe-area-inset-bottom)]">
      {tabs.map(({ to, label, icon: Icon, end, also }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) => {
            const on = isActive || also.some((p) => pathname === p || pathname.startsWith(`${p}/`));
            return `flex min-h-11 flex-col items-center gap-[3px] pt-[10px] pb-[14px] font-mono text-[11px] no-underline ${on ? 'text-accent' : 'text-muted hover:text-type'}`;
          }}
        >
          <Icon />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

/** A full-height column, mobile-first; centered and capped on wide screens. Inside the app shell it ends with the tabs. */
export function Page({ children, className = '' }: { children: ReactNode; className?: string }) {
  const shell = useInShell();
  return (
    <div className={`mx-auto flex min-h-dvh w-full max-w-[560px] flex-col bg-newsprint ${className}`}>
      {children}
      {shell && <BottomNav />}
    </div>
  );
}

export function TabPage({ children }: { children: ReactNode }) {
  return (
    <Page>
      <AppHeader />
      <main className="flex flex-1 flex-col pb-24">{children}</main>
    </Page>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="m-0 font-mono text-[15px] font-medium tracking-[1px]">
        <span className="text-mark">///</span> {children}
      </h2>
      {aside}
    </div>
  );
}

/** Slate information panel. */
export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-sm border border-slate-edge bg-slate p-[14px] ${className}`}>{children}</div>;
}

export function ErrorNote({ children, id }: { children: ReactNode; id?: string }) {
  if (!children) return null;
  return (
    <p id={id} role="alert" className="m-0 rounded-sm border border-pencil/60 bg-pencil/10 px-3 py-[10px] text-[14px] leading-[1.45] text-type">
      {children}
    </p>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="status" className="m-0 rounded-sm border border-slate-edge bg-slate px-3 py-[10px] text-[14px] leading-[1.45]">
      {children}
    </p>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex flex-1 items-center justify-center p-10 font-mono text-[12px] tracking-[1px] text-muted">
      {label.toUpperCase()}…
    </div>
  );
}
