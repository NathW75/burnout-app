/**
 * App chrome: the header with the official clock, the bottom nav, and the
 * small shared pieces every screen uses.
 */
import { useEffect, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router';
import { setCurrentScreen } from '../api/client';
import { clockET } from '../lib/format';
import { useServerNow } from '../lib/useClock';
import { BackIcon, FlameIcon, HelpIcon, HomeIcon, LineupIcon, UserIcon } from './icons';

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
      {!compact && <span className="size-[7px] rounded-full bg-line" aria-hidden="true" />}
      <span className="tnum text-type" aria-hidden="true">{compact ? text.replace(/:\d\d (AM|PM)/, ' $1') : text}</span>
    </span>
  );
}

export function Wordmark() {
  return (
    <span className="flex items-center gap-2 font-mono text-[13px] font-medium tracking-[1px] text-type">
      <FlameIcon width={16} height={16} className="text-line" />
      BURNOUT LEAGUE
    </span>
  );
}

/** Top bar for the main tabs. */
export function AppHeader() {
  return (
    <header className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-graphite px-4 py-[14px]">
      <Link to="/" className="no-underline" aria-label="Burnout League, This Week">
        <Wordmark />
      </Link>
      <OfficialClock />
    </header>
  );
}

/** Top bar for a sub-screen: back, title, compact clock. */
export function SubHeader({ title, back, backLabel }: { title: string; back: string; backLabel: string }) {
  return (
    <header className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-graphite px-4 py-[10px]">
      <Link to={back} aria-label={backLabel} className="-ml-3 flex size-11 items-center justify-center text-type">
        <BackIcon />
      </Link>
      <h1 className="m-0 font-mono text-[16px] font-medium tracking-[1px]">{title}</h1>
      <OfficialClock compact />
    </header>
  );
}

const tabs = [
  { to: '/', label: 'WEEK', icon: HomeIcon, end: true },
  { to: '/lineup', label: 'LINEUP', icon: LineupIcon, end: false },
  { to: '/help', label: 'RULES', icon: HelpIcon, end: false },
  { to: '/account', label: 'ACCOUNT', icon: UserIcon, end: false },
];

export function BottomNav() {
  return (
    <nav aria-label="Main" className="sticky bottom-0 z-10 mt-auto grid grid-cols-4 border-t border-rule bg-graphite pb-[env(safe-area-inset-bottom)]">
      {tabs.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            `flex min-h-11 flex-col items-center gap-[3px] pt-[10px] pb-[14px] font-mono text-[11px] no-underline ${isActive ? 'text-line' : 'text-muted hover:text-type'}`
          }
        >
          <Icon />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

/** A full-height column, mobile-first; centered and capped on wide screens. */
export function Page({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto flex min-h-dvh w-full max-w-[560px] flex-col bg-newsprint ${className}`}>{children}</div>;
}

export function TabPage({ children }: { children: ReactNode }) {
  return (
    <Page>
      <AppHeader />
      <main className="flex flex-1 flex-col pb-6">{children}</main>
      <BottomNav />
    </Page>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="m-0 font-mono text-[15px] font-medium tracking-[1px]">
        <span className="text-line">///</span> {children}
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
