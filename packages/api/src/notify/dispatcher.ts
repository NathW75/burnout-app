/**
 * The notification sender (PRD-008 §7): turns queued notices into email.
 *
 * Each run claims what's due (FOR UPDATE SKIP LOCKED plus a claim time, so
 * two workers never take the same row), drops what shouldn't go (too late,
 * turned off, account not usable), sends one email per user, and records the
 * result. The send happens before the row is marked: a crash in between can
 * send a duplicate, never lose a notice.
 */
import type { ApiContext } from '../context';
import { MailSendError } from '../mailer';
import { EMAIL_KINDS, IMMEDIATE_KINDS } from './kinds';
import { emailEnabled } from './preferences';
import { renderEmail, type BurnText, type Lookup, type PlayerText, type QueuedNotice } from './templates';
import { unsubscribeToken } from './unsubscribe';

export interface NotifyConfig {
  /** Notices for one user that arrive within this many seconds go out together (PRD-008 §12.1). */
  groupSeconds: number;
  /** Users per run. */
  batchUsers: number;
  maxAttempts: number;
  /** Wait before retry n (1-based); the last value repeats. */
  backoffMinutes: number[];
  /** A claim older than this is abandoned (a crashed worker) and taken again. */
  claimTimeoutMs: number;
  /** Public API origin, for the one-click unsubscribe URL. */
  apiBaseUrl: string;
  /** Pending this long = the sender looks stalled: logged as an error. */
  stalledAfterMs: number;
}

export const DEFAULT_NOTIFY_CONFIG: NotifyConfig = {
  groupSeconds: 120,
  batchUsers: 50,
  maxAttempts: 5,
  backoffMinutes: [1, 5, 15],
  claimTimeoutMs: 5 * 60_000,
  apiBaseUrl: 'https://api.burnoutfantasy.com',
  stalledAfterMs: 10 * 60_000,
};

export interface NotifyResult {
  users: number;
  sent: number;
  noticesSent: number;
  skipped: Record<string, number>;
  retrying: number;
  failed: number;
}

interface Row {
  id: string;
  user_id: string;
  kind: string;
  payload: Record<string, unknown>;
  created_at: Date;
  dispatch_attempts: number;
}

interface UserRow {
  id: string;
  email: string;
  verified: boolean;
  status: string;
  email_notifications: 'on' | 'off';
}

export type SkipReason = 'stale' | 'preference' | 'unsubscribed' | 'account' | 'unsupported';

/** Why a notice won't be emailed, or null if it should be (pure; PRD-008 §4, §6). */
export function skipReason(n: { kind: string; created_at: Date }, user: UserRow | undefined, stored: ReadonlyMap<string, boolean>, now: Date): SkipReason | null {
  const k = EMAIL_KINDS[n.kind];
  if (!k) return 'unsupported';
  if (now.getTime() - n.created_at.getTime() > k.staleHours * 3600_000) return 'stale';
  if (!user || !user.verified || user.status !== 'active') return 'account';
  if (!k.required && user.email_notifications === 'off') return 'unsubscribed';
  if (!emailEnabled(n.kind, stored)) return 'preference';
  return null;
}

export async function runNotify(ctx: ApiContext, cfg: NotifyConfig): Promise<NotifyResult> {
  const now = ctx.now();
  const out: NotifyResult = { users: 0, sent: 0, noticesSent: 0, skipped: {}, retrying: 0, failed: 0 };
  const claimable = `dispatched_at IS NULL
      AND (dispatch_next_at IS NULL OR dispatch_next_at <= $1)
      AND (dispatch_claimed_at IS NULL OR dispatch_claimed_at < $1::timestamptz - make_interval(secs => $2::double precision / 1000))`;

  // Users with something due: an immediate kind, or a notice that has waited out the grouping window.
  const due = await ctx.db.query<{ user_id: string }>(
    `SELECT user_id::text AS user_id FROM notification_queue
      WHERE ${claimable}
      GROUP BY user_id
     HAVING bool_or(kind = ANY ($3::text[])) OR min(created_at) <= $1::timestamptz - make_interval(secs => $4::double precision)
      ORDER BY min(created_at) LIMIT $5`,
    [now, cfg.claimTimeoutMs, IMMEDIATE_KINDS, cfg.groupSeconds, cfg.batchUsers]
  );
  if (!due.length) return out;
  const userIds = due.map((d) => d.user_id);

  // Claim every pending notice of those users, so one email carries all of them.
  const rows = await ctx.db.query<Row>(
    `UPDATE notification_queue q SET dispatch_claimed_at = $1
      WHERE q.id IN (SELECT id FROM notification_queue WHERE user_id = ANY ($3::uuid[]) AND ${claimable} FOR UPDATE SKIP LOCKED)
      RETURNING q.id::text AS id, q.user_id::text AS user_id, q.kind, q.payload, q.created_at, q.dispatch_attempts`,
    [now, cfg.claimTimeoutMs, userIds]
  );
  if (!rows.length) return out;

  const users = new Map(
    (
      await ctx.db.query<UserRow>(
        `SELECT id::text AS id, email, (email_verified_at IS NOT NULL) AS verified, status, email_notifications FROM users WHERE id = ANY ($1::uuid[])`,
        [userIds]
      )
    ).map((u) => [u.id, u])
  );
  const prefs = new Map<string, Map<string, boolean>>();
  for (const p of await ctx.db.query<{ user_id: string; kind: string; enabled: boolean }>(
    `SELECT user_id::text AS user_id, kind, enabled FROM notification_preferences WHERE channel = 'email' AND user_id = ANY ($1::uuid[])`,
    [userIds]
  )) {
    if (!prefs.has(p.user_id)) prefs.set(p.user_id, new Map());
    prefs.get(p.user_id)!.set(p.kind, p.enabled);
  }

  // Split into skipped and to-send.
  const byUser = new Map<string, Row[]>();
  const skipped = new Map<SkipReason, string[]>();
  for (const r of rows) {
    const why = skipReason(r, users.get(r.user_id), prefs.get(r.user_id) ?? new Map(), now);
    if (why) {
      skipped.set(why, [...(skipped.get(why) ?? []), r.id]);
      out.skipped[why] = (out.skipped[why] ?? 0) + 1;
    } else {
      byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r]);
    }
  }
  for (const [why, ids] of skipped) {
    await ctx.db.query(
      `UPDATE notification_queue SET dispatched_at = $2, dispatch_result = $3, dispatch_claimed_at = NULL WHERE id = ANY ($1::uuid[])`,
      [ids, now, `skipped:${why}`]
    );
  }
  if (!byUser.size) return out;

  const lookup = await loadLookup(ctx, [...byUser.values()].flat());
  const api = cfg.apiBaseUrl.replace(/\/$/, '');
  const app = ctx.config.appBaseUrl.replace(/\/$/, '');

  for (const [userId, list] of byUser) {
    out.users++;
    const user = users.get(userId)!;
    const ids = list.map((r) => r.id);
    const token = unsubscribeToken(ctx.notifyKey, userId);
    const notices: QueuedNotice[] = list
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
      .map((r) => ({ id: r.id, kind: r.kind, payload: r.payload, createdAt: r.created_at }));
    const email = renderEmail(notices, lookup, { appBaseUrl: app, unsubscribePageUrl: `${app}/unsubscribe?token=${token}` });
    if (!email) {
      await ctx.db.query(`UPDATE notification_queue SET dispatched_at = $2, dispatch_result = 'skipped:unsupported', dispatch_claimed_at = NULL WHERE id = ANY ($1::uuid[])`, [ids, now]);
      out.skipped.unsupported = (out.skipped.unsupported ?? 0) + ids.length;
      continue;
    }
    try {
      const sent = await ctx.mailer.sendNotice({
        to: user.email,
        ...email,
        unsubscribeUrl: `${api}/v1/notifications/unsubscribe?token=${token}`,
        noticeIds: ids,
      });
      await ctx.db.query(
        `UPDATE notification_queue SET dispatched_at = $2, dispatch_result = 'sent', dispatch_ref = $3, dispatch_claimed_at = NULL, dispatch_attempts = dispatch_attempts + 1
          WHERE id = ANY ($1::uuid[])`,
        [ids, ctx.now(), sent.id?.slice(0, 120) ?? null]
      );
      out.sent++;
      out.noticesSent += ids.length;
    } catch (err) {
      const status = err instanceof MailSendError ? err.status : 0;
      const permanent = err instanceof MailSendError && err.permanent;
      const attempts = Math.max(...list.map((r) => r.dispatch_attempts)) + 1;
      if (permanent || attempts >= cfg.maxAttempts) {
        await ctx.db.query(
          `UPDATE notification_queue SET dispatched_at = $2, dispatch_result = $3, dispatch_claimed_at = NULL, dispatch_attempts = $4 WHERE id = ANY ($1::uuid[])`,
          [ids, ctx.now(), `failed:${status || 'error'}`, attempts]
        );
        out.failed += ids.length;
        ctx.log('error', 'notify: email failed, giving up', { job: 'notify', notices: ids.length, status, attempts, error: err instanceof Error ? err.message : String(err) });
      } else {
        const wait = cfg.backoffMinutes[Math.min(attempts, cfg.backoffMinutes.length) - 1] ?? 15;
        await ctx.db.query(
          `UPDATE notification_queue SET dispatch_claimed_at = NULL, dispatch_attempts = $2, dispatch_next_at = $3 WHERE id = ANY ($1::uuid[])`,
          [ids, attempts, new Date(ctx.now().getTime() + wait * 60_000)]
        );
        out.retrying += ids.length;
        ctx.log('warn', 'notify: email failed, will retry', { job: 'notify', notices: ids.length, status, attempts, retryInMinutes: wait });
      }
    }
  }
  return out;
}

/** Names for every player the batch mentions, and slot and points for each burn (text only). */
async function loadLookup(ctx: ApiContext, rows: Row[]): Promise<Lookup> {
  const playerIds = new Set<string>();
  const burnIds = new Set<string>();
  for (const r of rows) {
    const p = r.payload;
    if (typeof p.playerId === 'string') playerIds.add(p.playerId);
    for (const list of [p.players, p.slots]) {
      if (!Array.isArray(list)) continue;
      for (const x of list as Array<Record<string, unknown>>) {
        if (typeof x?.playerId === 'string') playerIds.add(x.playerId);
        if (typeof x?.burnRecordId === 'string') burnIds.add(x.burnRecordId);
      }
    }
  }
  const players = new Map<string, PlayerText>();
  if (playerIds.size) {
    for (const p of await ctx.db.query<{ id: string; name: string; position: string; team: string | null }>(
      `SELECT msf_player_id AS id, first_name || ' ' || last_name AS name, position, team FROM nfl_players WHERE msf_player_id = ANY ($1::text[])`,
      [[...playerIds]]
    )) {
      players.set(p.id, { name: p.name, position: p.position, team: p.team });
    }
  }
  const burns = new Map<string, BurnText>();
  const uuids = [...burnIds].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (uuids.length) {
    for (const b of await ctx.db.query<{ id: string; slot_key: string | null; points_x100: number | null }>(
      `SELECT b.id::text AS id, s.slot_key, sc.points_x100
         FROM burn_records b
         LEFT JOIN season_submissions s ON s.id = b.submission_id
         LEFT JOIN player_game_scores sc ON sc.season = b.season AND sc.player_id = b.player_id AND sc.game_window_id = b.game_window_id
        WHERE b.id = ANY ($1::uuid[])`,
      [uuids]
    )) {
      burns.set(b.id, { slotKey: b.slot_key, pointsX100: b.points_x100 });
    }
  }
  return { players, burns };
}

/** Ops view (PRD-008 §8): last 24 hours by kind and result, and the oldest pending notice. */
export async function notifyStats(ctx: ApiContext) {
  const now = ctx.now();
  const byKind = await ctx.db.query<{ kind: string; result: string; n: number }>(
    `SELECT kind, COALESCE(dispatch_result, 'pending') AS result, count(*)::int AS n FROM notification_queue
      WHERE created_at > $1::timestamptz - interval '24 hours' GROUP BY 1, 2 ORDER BY 1, 2`,
    [now]
  );
  const [oldest] = await ctx.db.query<{ at: Date | null }>(`SELECT min(created_at) AS at FROM notification_queue WHERE dispatched_at IS NULL`);
  return { since: new Date(now.getTime() - 24 * 3600_000), byKind, oldestPendingAt: oldest?.at ?? null };
}

/** Logs an error when the oldest undispatched notice has waited too long (a stalled sender is visible in the logs). */
export async function checkStalled(ctx: ApiContext, cfg: NotifyConfig): Promise<number | null> {
  const [r] = await ctx.db.query<{ at: Date | null }>(`SELECT min(created_at) AS at FROM notification_queue WHERE dispatched_at IS NULL`);
  if (!r?.at) return null;
  const age = ctx.now().getTime() - r.at.getTime();
  if (age > cfg.stalledAfterMs) ctx.log('error', 'notify: oldest pending notice is overdue', { job: 'notify', ageSeconds: Math.round(age / 1000) });
  return age;
}
