import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from '../api/client';
import { serverClock } from './clock';

const RESYNC_MS = 5 * 60_000;

/** Syncs the official clock at load, on regaining focus, and every 5 minutes (PRD-007 §5.3). */
export function useClockSync(): void {
  useEffect(() => {
    const sync = () => void serverClock.sync(async () => (await api<{ serverTime: string }>('/time')).serverTime);
    sync();
    const onVisible = () => {
      if (document.visibilityState === 'visible') sync();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    const id = window.setInterval(sync, RESYNC_MS);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.clearInterval(id);
    };
  }, []);
}

/** Server time, re-rendered every `tickMs`. */
export function useServerNow(tickMs = 1000): number {
  useSyncExternalStore(serverClock.subscribe.bind(serverClock), () => serverClock.offset);
  const [now, setNow] = useState(() => serverClock.now());
  useEffect(() => {
    setNow(serverClock.now());
    const id = window.setInterval(() => setNow(serverClock.now()), tickMs);
    return () => window.clearInterval(id);
  }, [tickMs]);
  return now;
}
