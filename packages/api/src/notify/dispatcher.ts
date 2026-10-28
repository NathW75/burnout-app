/**
 * The notification sender (PRD-008 §7, §9): turns queued notices into email
 * and web push. Each channel delivers a notice on its own, with its own
 * columns, so an email outage never holds up push and the reverse.
 *
 * Each run claims what's due (FOR UPDATE SKIP LOCKED plus a claim time, so
 * two workers never take the same row), drops what shouldn't go (too late,
 * turned off, account not usable, no device), sends one message per user,
 * and records the result. The send happens before the row is marked: a crash
 * in between can send a duplicate, never lose a notice.
 */
import type { ApiContext } from '../context';
import { MailSendError } from '../mailer';
import { EMAIL_KINDS, IMMEDIATE_KINDS } from './kinds';
import { emailEnabled } from './preferences';
import { PushSendError, type PushSender, type PushSubscriptionKeys } from './push';
import { renderEmail, renderPush, type BurnText, type Lookup, type PlayerText, type QueuedNotice } from './templates';
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

export type Channel = 'email' | 'push';

export interface NotifyResult {
  users: number;
  sent: number;
  noticesSent: number;
  skipped: Record<string, number>;
  retrying: number;
  failed: number;
}

interface Cols {
  dispatched: string;
  claimed: string;
  attempts: string;
  next: string;
  result: string;
  ref: string | null;
}

/** Column names are fixed here, never from input. */
const COLS: Record<Channel, Cols> = {
  email: { dispatched: 'dispatched_at', claimed: 'dispatch_claimed_at', attempts: 'dispatch_attempts', next: 'dispatch_next_at', result: 'dispatch_result', ref: 'dispatch_ref' },
  push: { dispatched: 'push_dispatched_at', claimed: 'push_claimed_at', attempts: 'push_attempts', next: 'push_next_at', result: 'push_result', ref: null },
};

interface Row {
  id: string;
  user_id: string;
  kind: string;
  payload: Record<string, unknown>;
  created_at: Date;
  attempts: number;
}

interface UserRow {
  id: string;
  email: string;
  verified: boolean;
  status: string;
  email_notifications: 'on' | 'off';
}

export type SkipReason = 'stale' | 'preference' | 'unsubscribed' | 'account' | 'unsupported' | 'no_device';

/** Why a notice won't go on this channel, or null if it should (pure; PRD-008 §4, §6, §9). */
export function skipReason(
  n: { kind: string; created_at: Date },
  user: UserRow | undefined,
  stored: ReadonlyMap<string, boolean>,
  now: Date,
  channel: Channel = 'email'
): SkipReason | null {
  const k = EMAIL_KINDS[n.kind];
  if (!k) return 'unsupported';
  if (now.getTime() - n.created_at.getTime() > k.staleHours * 3600_000) return 'stale';
  if (!user || !user.verified || user.status !== 'active') return 'account';
  // "Email me nothing optional" is about email; push is turned off per device or per group.
  if (channel === 'email' && !k.required && user.email_notifications === 'off') return 'unsubscribed';
  if (!emailEnabled(n.kind, stored)) return 'preference'; // push defaults match email (decided 2026-10-28)
  return null;
}

/** What delivering one user's batch did. Throwing means "try again later" unless permanent. */
type Delivery = { kind: 'sent'; ref: string | null } | { kind: 'skipped'; reason: SkipReason };

class DeliveryError extends Error {
  constructor(readonly status: number, readonly permanent: boolean, cause?: unknown) {
    super(cause instanceof Error ? cause.message : `delivery failed: ${status}`);
  }
}

type Deliver = (user: UserRow, notices: QueuedNotice[], lookup: Lookup, ids: string[]) => Promise<Delivery>;

async function runChannel(ctx: ApiContext, cfg: NotifyConfig, channel: Channel, deliver: Deliver): Promise<NotifyResult> {
  const c = COLS[channel];
  const now = ctx.now();
  const out: NotifyResult = { users: 0, sent: 0, noticesSent: 0, skipped: {}, retrying: 0, failed: 0 };
  const claimable = `${c.dispatched} IS NULL
      AND (${c.next} IS NULL OR ${c.next} <= $1)
      AND (${c.claimed} IS NULL OR ${c.claimed} < $1::timestamptz - make_interval(secs => $2::double precision / 1000))`;

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

  // Claim every pending notice of those users, so one message carries all of them.
  const rows = await ctx.db.query<Row>(
    `UPDATE notification_queue q SET ${c.claimed} = $1
      WHERE q.id IN (SELECT id FROM notification_queue WHERE user_id = ANY ($3::uuid[]) AND ${claimable} FOR UPDATE SKIP LOCKED)
      RETURNING q.id::text AS id, q.user_id::text AS user_id, q.kind, q.payload, q.created_at, q.${c.attempts} AS attempts`,
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
    `SELECT user_id::text AS user_id, kind, enabled FROM notification_preferences WHERE channel = $2 AND user_id = ANY ($1::uuid[])`,
    [userIds, channel]
  )) {
    if (!prefs.has(p.user_id)) prefs.set(p.user_id, new Map());
    prefs.get(p.user_id)!.set(p.kind, p.enabled);
  }

  const mark = async (ids: string[], result: string, extra: { ref?: string | null; attempts?: number } = {}) => {
    const sets = [`${c.dispatched} = $2`, `${c.result} = $3`, `${c.claimed} = NULL`];
    const params: unknown[] = [ids, ctx.now(), result];
    if (extra.attempts !== undefined) {
      params.push(extra.attempts);
      sets.push(`${c.attempts} = $${params.length}`);
    }
    if (c.ref && extra.ref !== undefined) {
      params.push(extra.ref?.slice(0, 120) ?? null);
      sets.push(`${c.ref} = $${params.length}`);
    }
    await ctx.db.query(`UPDATE notification_queue SET ${sets.join(', ')} WHERE id = ANY ($1::uuid[])`, params);
  };

  // Split into skipped and to-send.
  const byUser = new Map<string, Row[]>();
  const skipped = new Map<SkipReason, string[]>();
  for (const r of rows) {
    const why = skipReason(r, users.get(r.user_id), prefs.get(r.user_id) ?? new Map(), now, channel);
    if (why) {
      skipped.set(why, [...(skipped.get(why) ?? []), r.id]);
      out.skipped[why] = (out.skipped[why] ?? 0) + 1;
    } else {
      byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r]);
    }
  }
  for (const [why, ids] of skipped) await mark(ids, `skipped:${why}`);
  if (!byUser.size) return out;

  const lookup = await loadLookup(ctx, [...byUser.values()].flat());

  for (const [userId, list] of byUser) {
    out.users++;
    const ids = list.map((r) => r.id);
    const notices: QueuedNotice[] = list
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
      .map((r) => ({ id: r.id, kind: r.kind, payload: r.payload, createdAt: r.created_at }));
    const attempts = Math.max(...list.map((r) => r.attempts)) + 1;
    try {
      const d = await deliver(users.get(userId)!, notices, lookup, ids);
      if (d.kind === 'skipped') {
        await mark(ids, `skipped:${d.reason}`);
        out.skipped[d.reason] = (out.skipped[d.reason] ?? 0) + ids.length;
        continue;
      }
      await mark(ids, 'sent', { ref: d.ref, attempts });
      out.sent++;
      out.noticesSent += ids.length;
    } catch (err) {
      const status = err instanceof DeliveryError ? err.status : 0;
      const permanent = err instanceof DeliveryError && err.permanent;
      if (permanent || attempts >= cfg.maxAttempts) {
        await mark(ids, `failed:${status || 'error'}`, { attempts });
        out.failed += ids.length;
        ctx.log('error', `notify: ${channel} failed, giving up`, { job: 'notify', channel, notices: ids.length, status, attempts, error: err instanceof Error ? err.message : String(err) });
      } else {
        const wait = cfg.backoffMinutes[Math.min(attempts, cfg.backoffMinutes.length) - 1] ?? 15;
        await ctx.db.query(
          `UPDATE notification_queue SET ${c.claimed} = NULL, ${c.attempts} = $2, ${c.next} = $3 WHERE id = ANY ($1::uuid[])`,
          [ids, attempts, new Date(ctx.now().getTime() + wait * 60_000)]
        );
        out.retrying += ids.length;
        ctx.log('warn', `notify: ${channel} failed, will retry`, { job: 'notify', channel, notices: ids.length, status, attempts, retryInMinutes: wait });
      }
    }
  }
  return out;
}

/** Email (PRD-008 Phase 1). */
export async function runNotify(ctx: ApiContext, cfg: NotifyConfig): Promise<NotifyResult> {
  const api = cfg.apiBaseUrl.replace(/\/$/, '');
  const app = ctx.config.appBaseUrl.replace(/\/$/, '');
  return runChannel(ctx, cfg, 'email', async (user, notices, lookup, ids) => {
    const token = unsubscribeToken(ctx.notifyKey, user.id);
    const email = renderEmail(notices, lookup, { appBaseUrl: app, unsubscribePageUrl: `${app}/unsubscribe?token=${token}` });
    if (!email) return { kind: 'skipped', reason: 'unsupported' };
    try {
      const sent = await ctx.mailer.sendNotice({ to: user.email, ...email, unsubscribeUrl: `${api}/v1/notifications/unsubscribe?token=${token}`, noticeIds: ids });
      return { kind: 'sent', ref: sent.id };
    } catch (err) {
      if (err instanceof MailSendError) throw new DeliveryError(err.status, err.permanent, err);
      throw err;
    }
  });
}

/**
 * Web push (PRD-008 Phase 2): the same batch to each of the user's devices.
 * A device the push service says is gone (404/410) is removed; the batch
 * counts as sent if any device took it.
 */
export async function runPush(ctx: ApiContext, cfg: NotifyConfig, sender: PushSender): Promise<NotifyResult> {
  const app = ctx.config.appBaseUrl.replace(/\/$/, '');
  return runChannel(ctx, cfg, 'push', async (user, notices, lookup) => {
    const subs = await ctx.db.query<PushSubscriptionKeys & { id: string }>(
      `SELECT id::text AS id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1::uuid AND revoked_at IS NULL`,
      [user.id]
    );
    if (!subs.length) return { kind: 'skipped', reason: 'no_device' };
    const msg = renderPush(notices, lookup, app);
    if (!msg) return { kind: 'skipped', reason: 'unsupported' };
    const payload = JSON.stringify(msg);
    let delivered = 0;
    let lastStatus = 0;
    let transient = 0;
    for (const s of subs) {
      try {
        await sender.send(s, payload);
        delivered++;
        await ctx.db.query(`UPDATE push_subscriptions SET last_ok_at = $2 WHERE id = $1::uuid`, [s.id, ctx.now()]);
      } catch (err) {
        lastStatus = err instanceof PushSendError ? err.status : 0;
        if (err instanceof PushSendError && err.gone) {
          await ctx.db.query(`UPDATE push_subscriptions SET revoked_at = $2 WHERE id = $1::uuid AND revoked_at IS NULL`, [s.id, ctx.now()]);
        } else {
          transient++;
        }
      }
    }
    if (delivered) return { kind: 'sent', ref: null };
    if (!transient) return { kind: 'skipped', reason: 'no_device' }; // every device is gone
    throw new DeliveryError(lastStatus, false);
  });
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

/** Ops view (PRD-008 §8): last 24 hours by kind and result per channel, and the oldest pending notice. */
export async function notifyStats(ctx: ApiContext) {
  const now = ctx.now();
  const byKind = await ctx.db.query<{ kind: string; result: string; n: number }>(
    `SELECT kind, COALESCE(dispatch_result, 'pending') AS result, count(*)::int AS n FROM notification_queue
      WHERE created_at > $1::timestamptz - interval '24 hours' GROUP BY 1, 2 ORDER BY 1, 2`,
    [now]
  );
  const pushByKind = await ctx.db.query<{ kind: string; result: string; n: number }>(
    `SELECT kind, COALESCE(push_result, 'pending') AS result, count(*)::int AS n FROM notification_queue
      WHERE created_at > $1::timestamptz - interval '24 hours' GROUP BY 1, 2 ORDER BY 1, 2`,
    [now]
  );
  const [oldest] = await ctx.db.query<{ at: Date | null }>(`SELECT min(created_at) AS at FROM notification_queue WHERE dispatched_at IS NULL`);
  const [devices] = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM push_subscriptions WHERE revoked_at IS NULL`);
  return { since: new Date(now.getTime() - 24 * 3600_000), byKind, pushByKind, oldestPendingAt: oldest?.at ?? null, pushDevices: devices?.n ?? 0 };
}

/** Logs an error when the oldest undelivered notice on a channel has waited too long (a stalled sender is visible in the logs). */
export async function checkStalled(ctx: ApiContext, cfg: NotifyConfig, channel: Channel = 'email'): Promise<number | null> {
  const [r] = await ctx.db.query<{ at: Date | null }>(`SELECT min(created_at) AS at FROM notification_queue WHERE ${COLS[channel].dispatched} IS NULL`);
  if (!r?.at) return null;
  const age = ctx.now().getTime() - r.at.getTime();
  if (age > cfg.stalledAfterMs) ctx.log('error', 'notify: oldest pending notice is overdue', { job: 'notify', channel, ageSeconds: Math.round(age / 1000) });
  return age;
}
