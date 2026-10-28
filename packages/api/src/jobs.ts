/**
 * Scheduled jobs — PRD-006 §11
 *
 * Each job runs under a Postgres advisory lock (two workers never run the
 * same job at once), logs one JSON line, and never takes another job down.
 */
import { createPostgresBurnStore, evaluateAndCommitBurns, evaluateAndFireLocks } from '@burnout/burn-engine';
import { createLeaderboardService, leaderboardHooks } from '@burnout/leaderboard';
import type { PaymentsService } from '@burnout/payments';
import { createScoringStore, parseGamelogs, parseGames, type GameStatus } from '@burnout/scoring-engine';
import type { Redis } from 'ioredis';
import type { ApiContext, Log } from './context';
import { alertAdmins, classifyPending, type FeedbackClassifier } from './feedback/service';
import { checkStalled, runNotify, runPush, type NotifyConfig } from './notify/dispatcher';
import type { PushSender } from './notify/push';
import { aliasMap, normalizeStatLines, resolveIdentities } from './players/identity';
import { parsePlayers } from './players/msf-players';
import { aggregate, clearStatsMemo, FROZEN_WEEK_TTL, OPEN_WEEK_TTL, parseGameLines, STATS_TTL, statsKey, weekLinesKey, type GameLine } from './players/stats';
import { reresolveSubmissions, syncInjuries, syncPlayers } from './players/roster';
import { importSchedule } from './schedule/import';
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
  /** Tags feedback (PRD-007 §10). Absent when ANTHROPIC_API_KEY isn't set: feedback stays untagged. */
  classifier?: FeedbackClassifier;
  /** Pause before the one retry of a refused MSF read (403/429/5xx). Default 2 s; tests pass 0. */
  msfRetryDelayMs?: number;
  /** Email delivery (PRD-008). Absent = NOTIFY_EMAIL is off: notices stay in the inbox only. */
  notify?: NotifyConfig;
  /** Web push (PRD-008 §9). Absent = NOTIFY_PUSH is off. */
  push?: { config: NotifyConfig; sender: PushSender };
}

/** MSF answers worth one more try: throttling shows up as 403 or 429, and a 5xx is on their side. */
export function msfRetryable(err: unknown): boolean {
  return err instanceof MsfHttpError && (err.status === 403 || err.status === 429 || err.status >= 500);
}

export type JobName = 'locks' | 'payments' | 'scoring' | 'roster' | 'injuries' | 'schedule' | 'feedback' | 'notify' | 'push' | 'stats';

/** Nothing tagged and nothing alerted: the 15-second loop stays quiet. */
function feedbackIdle(result: object): boolean {
  const r = result as { tagging?: { claimed?: number; skipped?: string }; alerts?: { items?: number } };
  return (r.tagging?.skipped !== undefined || r.tagging?.claimed === 0) && r.alerts?.items === 0;
}

/** Regular-season weeks, for the week-by-week schedule fallback. */
export const REGULAR_SEASON_WEEKS = 18;

export function createJobs(deps: JobsDeps) {
  const { db, season, now, log } = deps;
  const burnStore = createPostgresBurnStore(db, {
    afterLock: leaderboardHooks.afterLock,
    onAfterLockError: (err, c) => log('error', 'leaderboard week_start snapshot failed (lock committed)', { ...c, error: String(err) }),
  });
  const scoring = createScoringStore(db, { afterFreeze: leaderboardHooks.afterFreeze });
  const leaderboard = createLeaderboardService({ db, redis: deps.redis, namespace: deps.namespace, log });
  const burnDeps = { ...burnStore, getServerTime: now, log };
  const retryDelayMs = deps.msfRetryDelayMs ?? 2000;

  /** One MSF read, retried once after a refusal that may be temporary. */
  async function msfGet(path: string): Promise<unknown> {
    try {
      return await deps.msf.get(path);
    } catch (err) {
      if (!msfRetryable(err)) throw err;
      if (retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs));
      return deps.msf.get(path);
    }
  }

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

  /**
   * The season schedule (§11.6). Without the season-wide games feed (403),
   * falls back to the 18 weekly feeds; a week the feed doesn't have (404) is
   * skipped.
   */
  async function fetchSchedule(): Promise<{ source: string; games: GameStatus[] }> {
    try {
      return { source: 'season', games: parseGames(await deps.msf.get(`${season}/games.json`)).games };
    } catch (err) {
      if (!(err instanceof MsfHttpError && err.status === 403)) throw err;
    }
    const games: GameStatus[] = [];
    for (let week = 1; week <= REGULAR_SEASON_WEEKS; week++) {
      try {
        games.push(...parseGames(await deps.msf.get(`${season}/week/${week}/games.json`)).games);
      } catch (err) {
        if (!(err instanceof MsfHttpError && err.status === 404)) throw err;
      }
    }
    return { source: 'weekly', games };
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
      const out: Array<{ week: number; burns: number; windowsFinal: number } | { week: number; failed: string }> = [];
      // Newest week first, and one week's feed failing never holds up another week: a refused read
      // of last week's feed (MSF answers 403 when it throttles) must not delay tonight's burns.
      for (const week of [...(await activeWeeks())].reverse()) {
        let games: ReturnType<typeof parseGames>;
        let parsed: ReturnType<typeof parseGamelogs>;
        try {
          games = parseGames(await msfGet(`${season}/week/${week}/games.json`));
          parsed = parseGamelogs(await msfGet(`${season}/week/${week}/player_gamelogs.json`));
        } catch (err) {
          if (!(err instanceof MsfHttpError)) throw err;
          log('error', 'scoring: MSF feed refused, week skipped this run', { job: 'scoring', week, status: err.status, error: err.message });
          out.push({ week, failed: `MSF HTTP ${err.status}` });
          continue;
        }
        // Stats posted under another MSF ID for the same person are scored under the kept ID (PRD-006 §7.5).
        const gamelogs = { ...parsed, lines: normalizeStatLines(parsed.lines, await aliasMap(db)) };
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

    /**
     * Picker stats (PRD-007 §8.7): every started week's game logs, cached per
     * week (a frozen week is fetched once), averaged per player into one blob
     * the API reads. Runs every 30 minutes and at worker start.
     */
    async stats() {
      const redis = deps.apiContext.redis ?? deps.redis;
      if (!redis) return { skipped: 'NO_REDIS' };
      const ns = deps.apiContext.ns;
      const weeks = (await db.query<{ week: number }>(
        `SELECT DISTINCT week FROM nfl_games WHERE season = $1 AND scheduled_start <= $2 ORDER BY week`, [season, now()]
      )).map((r) => r.week);
      const frozen = new Set((await db.query<{ week: number }>(`SELECT week FROM week_freezes WHERE season = $1`, [season])).map((r) => r.week));
      const lines: GameLine[] = [];
      const fetched: number[] = [];
      const cached: number[] = [];
      const failed: number[] = [];
      for (const week of weeks) {
        const key = weekLinesKey(ns, season, week);
        let have: GameLine[] | null = null;
        try {
          const raw = await redis.get(key);
          have = raw ? (JSON.parse(raw) as GameLine[]) : null;
        } catch {
          have = null;
        }
        if (have && frozen.has(week)) {
          lines.push(...have);
          cached.push(week);
          continue;
        }
        try {
          const fresh = parseGameLines(await msfGet(`${season}/week/${week}/player_gamelogs.json`));
          await redis.set(key, JSON.stringify(fresh), 'EX', frozen.has(week) ? FROZEN_WEEK_TTL : OPEN_WEEK_TTL);
          lines.push(...fresh);
          fetched.push(week);
        } catch (err) {
          if (!(err instanceof MsfHttpError)) throw err;
          log('warn', 'stats: MSF game logs refused, using the last copy', { job: 'stats', week, status: err.status, hadCopy: !!have });
          if (have) lines.push(...have);
          failed.push(week);
        }
      }
      const positions = new Map((await db.query<{ id: string; position: string }>(`SELECT msf_player_id AS id, position FROM nfl_players WHERE canonical_id IS NULL`)).map((r) => [r.id, r.position]));
      const players = aggregate(lines, await aliasMap(db), positions);
      await redis.set(statsKey(ns, season), JSON.stringify({ season, asOf: now().toISOString(), weeks, players }), 'EX', STATS_TTL);
      clearStatsMemo();
      return { weeks: weeks.length, fetched, cached, failed, players: Object.keys(players).length };
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
      // One person, one player: other MSF IDs for the same person become aliases (§7.5).
      const identity = await resolveIdentities(deps.apiContext, feed.players);
      const week = await currentWeek();
      const reresolve = week ? await reresolveSubmissions(deps.apiContext, season, week) : null;
      // The stats fallback only lists players with stats, so it can't be treated as a complete roster.
      return { source, ...sync, identity, week, reresolve };
    },

    /** Injury reports (Tech Summary §5): light feed, every 15 minutes Wednesday–Sunday. */
    async injuries() {
      const feed = parsePlayers(await deps.msf.get('injuries.json'));
      const sync = await syncInjuries(deps.apiContext, feed.players);
      const week = await currentWeek();
      const reresolve = week ? await reresolveSubmissions(deps.apiContext, season, week) : null;
      return { ...sync, week, reresolve };
    },

    async schedule() {
      const { source, games } = await fetchSchedule();
      if (games.length === 0) return { source, skipped: 'EMPTY_FEED' }; // never act on an empty feed
      const r = await importSchedule(deps.apiContext, season, games);
      if (r.windowsCreated || r.windowsRemoved || r.windowsPostponed) await rebuildBoards();
      return { source, ...r, review: r.review.length };
    },

    /** Runs on its own 30-second loop in the worker when NOTIFY_EMAIL=on (PRD-008 §7). */
    async notify() {
      if (!deps.notify) return { skipped: 'NOTIFY_EMAIL_OFF' };
      const r = await runNotify(deps.apiContext, deps.notify);
      await checkStalled(deps.apiContext, deps.notify);
      return r;
    },

    /** Web push, on the same 30-second loop as email when NOTIFY_PUSH=on (PRD-008 §9). */
    async push() {
      if (!deps.push) return { skipped: 'NOTIFY_PUSH_OFF' };
      const r = await runPush(deps.apiContext, deps.push.config, deps.push.sender);
      await checkStalled(deps.apiContext, deps.push.config, 'push');
      return r;
    },

    /** Runs on its own 15-second loop in the worker, so tags land within 30 seconds (feedback spec AC4). */
    /** Tags new feedback (when ANTHROPIC_API_KEY is set), then emails admins about it (PRD-007 §10.1). */
    async feedback() {
      const tagging = deps.classifier ? await classifyPending(db, deps.classifier, now, log) : { skipped: 'NO_CLASSIFIER' };
      const alerts = await alertAdmins(db, deps.apiContext.mailer, { now, log, appBaseUrl: deps.apiContext.config.appBaseUrl, tagging: !!deps.classifier });
      return { tagging, alerts };
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
      // The 15-second feedback loop stays quiet when there was nothing to tag.
      const idle =
        (name === 'feedback' && result !== null && feedbackIdle(result)) ||
        ((name === 'notify' || name === 'push') && result !== null && (result as { users?: number }).users === 0 && Object.keys((result as { skipped?: object }).skipped ?? {}).length === 0);
      if (!idle) log('info', `job ${name}`, { job: name, ms: Date.now() - started, result: result ?? 'skipped (held elsewhere)' });
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
  if (et.minute === 5 || et.minute === 35) due.push('stats'); // picker stats (PRD-007 §8.7)
  if (et.minute === 30) due.push('schedule'); // hourly: flexes and same-week moves (§11.6); the worker also runs it at startup
  return due;
}
