/**
 * Push devices (PRD-008 §9): one row per browser that allowed notifications.
 * Only endpoints on known push services are accepted.
 */
import type { ApiContext } from '../context';
import { HttpError } from '../errors';
import { isAllowedPushEndpoint } from './push';

export interface NewSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Saves this browser for the user. A browser that switches accounts moves to the new one. */
export async function saveSubscription(ctx: ApiContext, userId: string, sub: NewSubscription, userAgent: string | undefined): Promise<void> {
  if (!isAllowedPushEndpoint(sub.endpoint)) throw new HttpError(400, 'PUSH_ENDPOINT_NOT_ALLOWED', 'That push service isn’t supported');
  await ctx.db.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
       user_agent = EXCLUDED.user_agent, revoked_at = NULL, created_at = EXCLUDED.created_at`,
    [userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent?.slice(0, 300) ?? null, ctx.now()]
  );
}

/** Turns push off for this browser. Only the owner can remove it. */
export async function removeSubscription(ctx: ApiContext, userId: string, endpoint: string): Promise<boolean> {
  const rows = await ctx.db.query(
    `UPDATE push_subscriptions SET revoked_at = $3 WHERE user_id = $1::uuid AND endpoint = $2 AND revoked_at IS NULL RETURNING 1`,
    [userId, endpoint, ctx.now()]
  );
  return rows.length > 0;
}

export async function countDevices(ctx: ApiContext, userId: string): Promise<number> {
  const [r] = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1::uuid AND revoked_at IS NULL`, [userId]);
  return r?.n ?? 0;
}
