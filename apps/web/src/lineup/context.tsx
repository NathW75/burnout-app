/**
 * Lineup state shared by the builder, the picker and the three gates:
 * the server's lineup, the local draft on top of it, and the confirmation in
 * progress. The server is the authority; the draft is a convenience.
 */
import { createContext, Suspense, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Outlet } from 'react-router';
import { useLineup, useMe, useRefetchAtLocks, useSeason, useWindows } from '../api/hooks';
import type { ConfirmResponse, GameWindow, Lineup, ReviewResponse, SlotKey, Slots } from '../api/types';
import { ErrorNote, Loading, TabPage } from '../components/layout';
import { changeCount, clearDraft, effectiveSlots, loadDraft, reconcile, saveDraft, type Draft } from '../lib/draft';
import { errorText } from '../lib/errors';

export interface LineupCtx {
  season: string;
  week: number;
  lineup: Lineup;
  windows: GameWindow[];
  draft: Draft;
  effective: Slots;
  changes: number;
  setSlot: (slot: SlotKey, playerId: string | null) => void;
  discardDraft: () => void;
  /** Gate 1 result; null when no confirmation is in progress. */
  review: ReviewResponse | null;
  setReview: (r: ReviewResponse | null) => void;
  acknowledged: boolean;
  setAcknowledged: (v: boolean) => void;
  /** Gate 3 result, shown as the "Locked in." screen. */
  confirmed: ConfirmResponse | null;
  setConfirmed: (r: ConfirmResponse | null) => void;
  /** A message for the builder after a gate sends the user back. */
  flash: string | null;
  setFlash: (m: string | null) => void;
  /** Ends any confirmation in progress (expired, stale, or done). */
  endConfirmation: () => void;
}

export const LineupContext = createContext<LineupCtx | null>(null);
const Ctx = LineupContext;

export function useLineupCtx(): LineupCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useLineupCtx outside LineupProvider');
  return c;
}

/** The current week (server-decided) for screens outside the lineup routes. */
export function useCurrentWeek() {
  const season = useSeason();
  return { season: season.data?.season, week: season.data?.currentWeek ?? null, query: season };
}

function Provider({ userId, season, week, lineup, windows, children }: { userId: string; season: string; week: number; lineup: Lineup; windows: GameWindow[]; children: ReactNode }) {
  const [draft, setDraft] = useState<Draft>(() => reconcile(loadDraft(userId, season, week), lineup));
  const [review, setReview] = useState<ReviewResponse | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmed, setConfirmed] = useState<ConfirmResponse | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  // Any refetch of the lineup reconciles the draft: locked and voided slots win.
  useEffect(() => {
    setDraft((d) => {
      const r = reconcile(d, lineup);
      saveDraft(userId, season, week, r);
      return r;
    });
  }, [lineup, userId, season, week]);

  const setSlot = useCallback(
    (slot: SlotKey, playerId: string | null) => {
      setDraft((d) => {
        const r = reconcile({ ...d, [slot]: playerId }, lineup);
        saveDraft(userId, season, week, r);
        return r;
      });
    },
    [lineup, userId, season, week]
  );
  const discardDraft = useCallback(() => {
    clearDraft(userId, season, week);
    setDraft({});
  }, [userId, season, week]);
  const endConfirmation = useCallback(() => {
    setReview(null);
    setAcknowledged(false);
  }, []);

  const value = useMemo<LineupCtx>(
    () => ({
      season, week, lineup, windows, draft,
      effective: effectiveSlots(lineup, draft),
      changes: changeCount(draft),
      setSlot, discardDraft,
      review, setReview, acknowledged, setAcknowledged, confirmed, setConfirmed, flash, setFlash, endConfirmation,
    }),
    [season, week, lineup, windows, draft, setSlot, discardDraft, review, acknowledged, confirmed, flash, endConfirmation]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Route element for /lineup/*: loads the week, then renders the child route. */
export function LineupRoutes() {
  const me = useMe();
  const { season, week, query } = useCurrentWeek();
  const lineup = useLineup(season, week);
  const windows = useWindows(season, week);
  useRefetchAtLocks(season, week, (windows.data ?? []).map((w) => Date.parse(w.scheduledEt)));

  const err = query.error ?? lineup.error ?? windows.error;
  if (err) {
    return (
      <TabPage>
        <div className="p-4"><ErrorNote>{errorText(err)}</ErrorNote></div>
      </TabPage>
    );
  }
  if (query.isSuccess && week === null) {
    return (
      <TabPage>
        <p className="p-4 text-[15px] text-muted">No games are scheduled right now. Check back when the schedule is out.</p>
      </TabPage>
    );
  }
  if (!me.data || !season || !week || !lineup.data || !windows.data) return <TabPage><Loading /></TabPage>;
  return (
    <Provider key={`${season}:${week}`} userId={me.data.id} season={season} week={week} lineup={lineup.data} windows={windows.data}>
      {/* Inside the provider, so loading a gate's code never drops the confirmation in progress. */}
      <Suspense fallback={<TabPage><Loading /></TabPage>}>
        <Outlet />
      </Suspense>
    </Provider>
  );
}
