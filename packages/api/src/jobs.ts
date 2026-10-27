/**
 * Scheduled jobs — PRD-006 §11
 *
 * Each job runs under a Postgres advisory lock (two workers never run the
 * same job at once), logs one JSON line, and never takes another job down.
 */
import { createPostgresBurnStore, evaluateAndCommitBurns, evaluateAndFireLocks } from '@burnout/burn-engine';
import { createLeaderboardService, leaderboardHooks } from '@burnout/leaderboard';
import type { PaymentsService } from '@burnout/payments';
import { createScoringStore, parseGamelogs, parseGames } from '@burnout/scoring-engine';
import type { Redis } from 'ioredis';
import type { ApiContext, Log } from './context';
import { parsePlayers } from './players/msf-players';
import { reresolveSubmissions, syncInjuries, syncPlayers } from './players/roster';
import type { SqlDatabase } from './sql';

/** MSF v2.1 pull API. Only the worker calls it (§7.4). */
export interface MsfFetcher {
  /** path relative to the NFL base, e.g. "2026-2027-regular/week/7/games.json". */
  get(path: string): Promise<unknown>;
}

export class MsfHttpError extends Error {
  constructor(readonly status: number, path: string) {
    super(`MSF ${path.split('?')[0]}: HTTP ${status}`); // never include the key
    this.name = 'MsfHttpError';
  }
}

export function msfFetcher(baseUrl: string, apiKey: string): MsfFetcher {
  const auth = `Basic ${Buffer.from(`${apiKey}:MYSPORTSFEEDS`).toString('base64')}`;
  return {
    async get(path) {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/${path}`, { headers: { authorization: auth, 'accept-encoding': 'gzip' } });
      if (!res.ok) throw new MsfHttpError(res.status, path);
      return res.json();
    },
  };
}

export interface JobsDeps {
  db: SqlDatabase;
  redis?: Redis;
  namespace?: string;
  payments: PaymentsService;
  msf: MsfFetcher;
  season: string;
  now: () => Date;
  log: Log;
  /** Context used by roster sync / re-resolve (audit + notifications). */
  apiContext: ApiContext;
}

export type JobName = 'locks' | 'payments' | 'scoring' | 'roster' | 'injuries';

export function createJobs(deps: JobsDeps) {
  const { db, season, now, log } = deps;
  const burnStore = createPostgresBurnStore(db, {
    afterLock: leaderboardHooks.afterLock,
    onAfterLockError: (err, c) => log('error', 'leaderboard week_start snapshot failed (lock committed)', { ...c, error: String(err) }),
  });
  const scoring = createScoringStore(db, { afterFreeze: leaderboardHooks.afterFreeze });
  const leaderboard = createLeaderboardService({ db, redis: deps.redis, namespace: deps.namespace, log });
  const burnDeps = { ...burnStore, getServerTime: now, log };

  async function rebuildBoards() {
    try {
      await leaderboard.rebuild(season, now());
    } catch (err) {
      log('warn', 'leaderboard cache rebuild failed (Postgres stays authoritative)', { error: String(err) });
    }
  }

  /** Weeks worth polling: any week with a locked window, or a window that started in the last 4 days. */
  async function activeWeeks(): Promise<number[]> {
    const rows = await db.query<{ week: number }>(
      `SELECT DISTINCT week FROM game_windows
        WHERE season = $1 AND (status = 'locked' OR (scheduled_et <= $2 AND scheduled_et > $2::timestamptz - interval '4 days'))
        ORDER BY week`,
      [season, now()]
    );
    return rows.map((r) => r.week);
  }

  async function currentWeek(): Promise<number | null> {
    const [r] = await db.query<{ week: number }>(
      `SELECT week FROM game_windows WHERE season = $1 AND status = 'pending' ORDER BY scheduled_et LIMIT 1`,
      [season]
    );
    return r?.week ?? null;
  }

  const jobs: Record<JobName, () => Promise<object>> = {
    async locks() {
      const fired = await evaluateAndFireLocks(burnDeps);
      if (fired.length) await rebuildBoards();
      return { windowsLocked: fired.length };
    },

    async payments() {
      const r = await deps.payments.runJobs();
      return { poolsClosed: r.closed.length };
    },

    async scoring() {
      const out: Array<{ week: number; burns: number; windowsFinal: number }> = [];
      for (const week of await activeWeeks()) {
        const games = parseGames(await deps.msf.get(`${season}/week/${week}/games.json`));
        const gamelogs = parseGamelogs(await deps.msf.get(`${season}/week/${week}/player_gamelogs.json`));
        await scoring.ingest({ season, games: games.games, gamelogs, serverNow: now() });
        // Burn every locked window whose games are all Final (PRD-001 §5).
        const windows = await db.query<{ id: string; finals: string[] }>(
          `SELECT w.id::text AS id, array_agg(g.msf_game_id) FILTER (WHERE g.is_final) AS finals
             FROM game_windows w JOIN nfl_games g ON g.game_window_id = w.id
            WHERE w.season = $1 AND w.week = $2 AND w.status = 'locked'
            GROUP BY w.id HAVING bool_and(g.is_final)`,
          [season, week]
        );
        let burns = 0;
        for (const w of windows) {
          const r = await evaluateAndCommitBurns({ gameWindowId: w.id, finalMsfGameIds: w.finals ?? [] }, burnDeps);
          burns += r.burnsCreated;
        }
        out.push({ week, burns, windowsFinal: windows.length });
      }
      const frozen = await scoring.freezeDueWeeks(season, now());
      await rebuildBoards();
      return { weeks: out, weeksFrozen: frozen.map((f) => f.week) };
    },

    async roster() {
      // `players` may not be in the subscription (403): fall back to seasonal player stats (same player objects).
      let raw: unknown;
      let source = 'players';
      try {
        raw = await deps.msf.get('players.json'); // current rosters; a season parameter returned 403 (2026-10-27)
      } catch (err) {
        if (!(err instanceof MsfHttpError && err.status === 403)) throw err;
        source = 'player_stats_totals';
        raw = await deps.msf.get(`${season}/player_stats_totals.json?position=QB,RB,FB,WR,TE,K`);
      }
      const feed = parsePlayers(raw);
      const sync = await syncPlayers(deps.apiContext, feed.players, { complete: source === 'players' });
      const week = await currentWeek();
      const reresolve = week ? await reresolveSubmissions(deps.apiContext, season, week) : null;
      // The stats fallback only lists players with stats, so it can't be treated as a complete roster.
      return { source, ...sync, week, reresolve };
    },

    /** Injury reports (Tech Summary §5): light feed, every 15 minutes Wednesday–Sunday. */
    async injuries() {
      const feed = parsePlayers(await deps.msf.get('injuries.json'));
      const sync = await syncInjuries(deps.apiContext, feed.players);
      const week = await currentWeek();
      const reresolve = week ? await reresolveSubmissions(deps.apiContext, season, week) : null;
      return { ...sync, week, reresolve };
    },
  };

  /** Runs one job under its advisory lock. Returns null if another worker holds it. */
  async function run(name: JobName): Promise<object | null> {
    const started = Date.now();
    try {
      const result = await db.transaction(async (tx) => {
        const [{ ok }] = await tx.query<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok`, [`burnout:job:${name}`]);
        if (!ok) return null;
        return jobs[name]();
      });
      log('info', `job ${name}`, { job: name, ms: Date.now() - started, result: result ?? 'skipped (held elsewhere)' });
      return result;
    } catch (err) {
      log('error', `job ${name} failed`, { job: name, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  return { run, jobs, activeWeeks, currentWeek };
}

// ── schedule ────────────────────────────────────────────────────────────────

function etParts(d: Date): { weekday: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { weekday: get('weekday'), hour: Number(get('hour')) % 24, minute: Number(get('minute')) };
}

/** Which jobs are due at this minute (§11). */
export function dueJobs(at: Date, opts: { windowsActive: boolean }): JobName[] {
  const due: JobName[] = ['locks', 'payments'];
  const et = etParts(at);
  if (opts.windowsActive ? et.minute % 15 === 0 : et.minute === 0) due.push('scoring');
  if ((et.hour === 3 && et.minute === 0) || (et.weekday === 'Tue' && et.hour === 23 && et.minute === 59)) due.push('roster');
  if (['Wed', 'Thu', 'Fri', 'Sat', 'Sun'].includes(et.weekday) && et.minute % 15 === 0) due.push('injuries'); // Tech Summary §5
  return due;
}
