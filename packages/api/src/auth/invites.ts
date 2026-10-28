/**
 * Invite-only sign-up (PRD-006 §6.10, decided 2026-10-28): an admin makes a
 * single-use code per tester, optionally tied to their email. When
 * SIGNUP_INVITE_ONLY is on, sign-up needs a valid code, and the code is spent
 * in the same transaction that creates the account. Codes are stored hashed
 * and shown once.
 */
import { createHash, randomInt } from 'node:crypto';
import type { ApiContext } from '../context';
import { HttpError } from '../errors';
import type { SqlRunner } from '../sql';
import { audit } from './audit';
import type { SessionInfo } from './sessions';

/** Crockford base32 without I, L, O, U: no letters that read as digits. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** "7KX2M-QW9TD": 10 characters, 50 bits. */
export function newInviteCode(): string {
  const c = Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `${c.slice(0, 5)}-${c.slice(5)}`;
}

/** Forgiving input: case, spaces and dashes don't matter; O reads as 0 and I/L as 1. */
export function normalizeInviteCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

const hashCode = (raw: string) => createHash('sha256').update(normalizeInviteCode(raw)).digest('hex');

export const INVITE_INVALID = () => new HttpError(400, 'INVITE_INVALID', 'That invite code isn’t valid. Check it, or ask for a new one.');

interface InviteRow { id: string; email: string | null }

/** The usable invite for this code and email, or a 400. Doesn't spend it. */
export async function findInvite(q: SqlRunner, ctx: ApiContext, code: string | undefined, email: string): Promise<InviteRow> {
  if (!code || normalizeInviteCode(code).length !== 10) throw INVITE_INVALID();
  const [row] = await q.query<InviteRow>(
    `SELECT id::text AS id, email FROM invite_codes
      WHERE code_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)`,
    [hashCode(code), ctx.now()]
  );
  if (!row || (row.email && row.email !== email)) throw INVITE_INVALID();
  return row;
}

/** Spends the invite for the new account; a lost race is a 400 and the caller's transaction rolls back. */
export async function spendInvite(q: SqlRunner, ctx: ApiContext, inviteId: string, userId: string): Promise<void> {
  const rows = await q.query(`UPDATE invite_codes SET used_at = $3, used_by = $2::uuid WHERE id = $1::uuid AND used_at IS NULL AND revoked_at IS NULL RETURNING 1`, [inviteId, userId, ctx.now()]);
  if (!rows.length) throw INVITE_INVALID();
}

export interface CreatedInvite {
  id: string;
  code: string;
  link: string;
  email: string | null;
  note: string | null;
  expiresAt: Date | null;
}

export async function createInvite(ctx: ApiContext, admin: SessionInfo, opts: { email?: string | null; note?: string | null; expiresInDays?: number | null }): Promise<CreatedInvite> {
  const code = newInviteCode();
  const now = ctx.now();
  const expiresAt = opts.expiresInDays ? new Date(now.getTime() + opts.expiresInDays * 86_400_000) : null;
  const email = opts.email ? opts.email.trim().toLowerCase() : null;
  const out = await ctx.db.transaction(async (tx) => {
    const [r] = await tx.query<{ id: string }>(
      `INSERT INTO invite_codes (code_hash, email, note, created_by, created_at, expires_at) VALUES ($1, $2, $3, $4::uuid, $5, $6) RETURNING id::text AS id`,
      [hashCode(code), email, opts.note ?? null, admin.userId, now, expiresAt]
    );
    await audit(tx, { event: 'ADMIN_ACTION', userId: admin.userId, at: now, metadata: { action: 'INVITE_CREATED', inviteId: r.id, forEmail: !!email } });
    return r;
  });
  return { id: out.id, code, link: `${ctx.config.appBaseUrl.replace(/\/$/, '')}/signup?invite=${code}`, email, note: opts.note ?? null, expiresAt };
}

export async function listInvites(ctx: ApiContext) {
  const rows = await ctx.db.query<{ id: string; email: string | null; note: string | null; created_at: Date; expires_at: Date | null; used_at: Date | null; revoked_at: Date | null; used_by_handle: string | null }>(
    `SELECT i.id::text AS id, i.email, i.note, i.created_at, i.expires_at, i.used_at, i.revoked_at, u.handle AS used_by_handle
       FROM invite_codes i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created_at DESC LIMIT 200`
  );
  const now = ctx.now();
  return rows.map((r) => ({
    id: r.id, email: r.email, note: r.note, createdAt: r.created_at, expiresAt: r.expires_at, usedAt: r.used_at, usedBy: r.used_by_handle,
    status: r.used_at ? 'used' : r.revoked_at ? 'revoked' : r.expires_at && r.expires_at <= now ? 'expired' : 'active',
  }));
}

export async function revokeInvite(ctx: ApiContext, admin: SessionInfo, id: string): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const rows = await tx.query(`UPDATE invite_codes SET revoked_at = $2 WHERE id = $1::uuid AND used_at IS NULL AND revoked_at IS NULL RETURNING 1`, [id, ctx.now()]);
    if (rows.length) await audit(tx, { event: 'ADMIN_ACTION', userId: admin.userId, at: ctx.now(), metadata: { action: 'INVITE_REVOKED', inviteId: id } });
    return rows.length > 0;
  });
}
