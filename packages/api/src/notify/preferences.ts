/**
 * Notification preferences (PRD-008 §6): three email groups and the
 * unsubscribe switch. Stored per kind, shown per group.
 */
import type { ApiContext } from '../context';
import { EMAIL_KINDS, GROUP_KINDS, type PreferenceGroup } from './kinds';

export interface EmailPreferences {
  emailNotifications: 'on' | 'off';
  email: Record<PreferenceGroup, boolean>;
  /** Push (PRD-008 §9): same groups and defaults as email, applied to every device that allowed it. */
  push: Record<PreferenceGroup, boolean>;
}

type Channel = 'email' | 'push';

/** Stored choice, else the kind's default. */
export function emailEnabled(kind: string, stored: ReadonlyMap<string, boolean>): boolean {
  const k = EMAIL_KINDS[kind];
  if (!k) return false;
  if (k.required) return true;
  return stored.get(kind) ?? k.default;
}

export async function getPreferences(ctx: ApiContext, userId: string): Promise<EmailPreferences> {
  const [u] = await ctx.db.query<{ email_notifications: 'on' | 'off' }>(`SELECT email_notifications FROM users WHERE id = $1::uuid`, [userId]);
  const rows = await ctx.db.query<{ channel: Channel; kind: string; enabled: boolean }>(
    `SELECT channel, kind, enabled FROM notification_preferences WHERE user_id = $1::uuid`,
    [userId]
  );
  const groups = (channel: Channel) => {
    const stored = new Map(rows.filter((r) => r.channel === channel).map((r) => [r.kind, r.enabled]));
    const out = {} as Record<PreferenceGroup, boolean>;
    for (const [group, kinds] of Object.entries(GROUP_KINDS) as Array<[PreferenceGroup, readonly string[]]>) {
      out[group] = kinds.every((k) => emailEnabled(k, stored));
    }
    return out;
  };
  return { emailNotifications: u?.email_notifications ?? 'on', email: groups('email'), push: groups('push') };
}

export async function setPreferences(
  ctx: ApiContext,
  userId: string,
  change: { emailNotifications?: 'on' | 'off'; email?: Partial<Record<PreferenceGroup, boolean>>; push?: Partial<Record<PreferenceGroup, boolean>> }
): Promise<EmailPreferences> {
  await ctx.db.transaction(async (tx) => {
    const now = ctx.now();
    if (change.emailNotifications) {
      await tx.query(`UPDATE users SET email_notifications = $2, updated_at = $3 WHERE id = $1::uuid`, [userId, change.emailNotifications, now]);
    }
    for (const channel of ['email', 'push'] as const) {
      for (const [group, on] of Object.entries(change[channel] ?? {}) as Array<[PreferenceGroup, boolean | undefined]>) {
        if (on === undefined) continue;
        for (const kind of GROUP_KINDS[group]) {
          await tx.query(
            `INSERT INTO notification_preferences (user_id, channel, kind, enabled, updated_at) VALUES ($1::uuid, $5, $2, $3, $4)
             ON CONFLICT (user_id, channel, kind) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at`,
            [userId, kind, on, now, channel]
          );
        }
      }
    }
  });
  return getPreferences(ctx, userId);
}

/** One-click unsubscribe: optional email off. Returns false for an unknown user. */
export async function unsubscribe(ctx: ApiContext, userId: string): Promise<boolean> {
  const rows = await ctx.db.query(`UPDATE users SET email_notifications = 'off', updated_at = $2 WHERE id = $1::uuid RETURNING 1`, [userId, ctx.now()]);
  return rows.length > 0;
}
