/**
 * Server state (TanStack Query). The server is the authority for every rule:
 * these hooks only fetch and cache what it says (PRD-007 §1).
 */
import { QueryCache, QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { serverClock } from '../lib/clock';
import { api, ApiError } from './client';
import type { Burn, FieldMe, GameWindow, Lineup, Me, Notifications, Pool, Receipt, SeasonCurrent } from './types';

export const qk = {
  me: ['me'] as const,
  season: ['season', 'current'] as const,
  windows: (season: string, week: number) => ['windows', season, week] as const,
  lineup: (season: string, week: number) => ['lineup', season, week] as const,
  pool: (season: string, week: number) => ['pool', season, week] as const,
  burns: (season: string) => ['burns', season] as const,
  fieldMe: (season: string) => ['fieldMe', season] as const,
  notifications: ['notifications'] as const,
  receipt: (id: string) => ['receipt', id] as const,
};

/** Sign-up and session state live in GET /me; these codes mean it changed under us. */
const ACCOUNT_STATE_CODES = new Set(['MFA_ENROLLMENT_REQUIRED', 'EMAIL_UNVERIFIED', 'UNAUTHENTICATED']);

export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (err) => {
        if (err instanceof ApiError && (err.status === 401 || ACCOUNT_STATE_CODES.has(err.code))) {
          void client.invalidateQueries({ queryKey: qk.me });
        }
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: true, // PRD-007 §9: refetch on focus
        retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2,
      },
      mutations: { retry: false }, // never retry a mutation (Gate 3 above all)
    },
  });
  return client;
}

/** null = signed out. */
export function useMe() {
  return useQuery({
    queryKey: qk.me,
    queryFn: async (): Promise<Me | null> => {
      try {
        return await api<Me>('/me');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
  });
}

export function useSeason() {
  return useQuery({ queryKey: qk.season, queryFn: () => api<SeasonCurrent>('/seasons/current'), staleTime: 60_000 });
}

export function useWindows(season: string | undefined, week: number | null | undefined) {
  return useQuery({
    queryKey: qk.windows(season ?? '', week ?? 0),
    queryFn: async () => (await api<{ windows: GameWindow[] }>(`/seasons/${season}/weeks/${week}/windows`)).windows,
    enabled: !!season && !!week,
  });
}

export function useLineup(season: string | undefined, week: number | null | undefined) {
  return useQuery({
    queryKey: qk.lineup(season ?? '', week ?? 0),
    queryFn: () => api<Lineup>(`/seasons/${season}/weeks/${week}/lineup`),
    enabled: !!season && !!week,
  });
}

export function usePool(season: string | undefined, week: number | null | undefined) {
  return useQuery({
    queryKey: qk.pool(season ?? '', week ?? 0),
    queryFn: () => api<Pool>(`/seasons/${season}/weeks/${week}/pool`),
    enabled: !!season && !!week,
    staleTime: 30_000,
  });
}

export function useBurns(season: string | undefined) {
  return useQuery({
    queryKey: qk.burns(season ?? ''),
    queryFn: async () => (await api<{ burns: Burn[] }>(`/me/burns?season=${encodeURIComponent(season!)}`)).burns,
    enabled: !!season,
  });
}

export function useFieldMe(season: string | undefined) {
  return useQuery({ queryKey: qk.fieldMe(season ?? ''), queryFn: () => api<FieldMe>(`/seasons/${season}/leaderboard/me`), enabled: !!season });
}

export function useUnread() {
  return useQuery({ queryKey: qk.notifications, queryFn: () => api<Notifications>('/me/notifications?limit=5') });
}

export function useReceipt(id: string | undefined) {
  return useQuery({ queryKey: qk.receipt(id ?? ''), queryFn: () => api<Receipt>(`/receipts/${id}`), enabled: !!id, staleTime: Infinity });
}

/**
 * When a countdown hits zero, ask the server (PRD-007 §5.4): refetch the
 * lineup, pool and windows at each lock time, and again a minute later,
 * once the lock job has run.
 */
export function useRefetchAtLocks(season: string | undefined, week: number | null | undefined, lockTimes: number[]) {
  const qc = useQueryClient();
  const key = lockTimes.join(',');
  useEffect(() => {
    if (!season || !week) return;
    const now = serverClock.now();
    const next = lockTimes.filter((t) => t > now - 60_000).sort((a, b) => a - b);
    const timers: number[] = [];
    const refetch = () => {
      void qc.invalidateQueries({ queryKey: qk.lineup(season, week) });
      void qc.invalidateQueries({ queryKey: qk.pool(season, week) });
      void qc.invalidateQueries({ queryKey: qk.windows(season, week) });
    };
    for (const t of next.slice(0, 3)) {
      for (const delay of [t - now + 500, t - now + 65_000]) {
        if (delay > 0 && delay < 2 ** 31 - 1) timers.push(window.setTimeout(refetch, delay));
      }
    }
    return () => timers.forEach((id) => window.clearTimeout(id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc, season, week, key]);
}
