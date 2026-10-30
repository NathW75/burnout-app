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
import { invalidateUserSessions, type SessionInfo } from './sessions';

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
  /** Only when sending was asked for: whether the invite email went out. */
  emailed?: boolean;
}

const etDate = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export async function createInvite(ctx: ApiContext, admin: SessionInfo, opts: { email?: string | null; note?: string | null; expiresInDays?: number | null; send?: boolean }): Promise<CreatedInvite> {
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
  const link = `${ctx.config.appBaseUrl.replace(/\/$/, '')}/signup?invite=${code}`;
  const created: CreatedInvite = { id: out.id, code, link, email, note: opts.note ?? null, expiresAt };
  if (!opts.send || !email) return created;
  // The code exists only now (it's stored hashed), so this is the one chance to email it. A failed send keeps the
  // invite: the admin still sees the code and link to pass on another way.
  let emailed = false;
  try {
    await ctx.mailer.send({ to: email, template: 'invite', data: { link, code, expires: expiresAt ? `${etDate.format(expiresAt)} ET` : '' } });
    emailed = true;
  } catch (err) {
    ctx.log('warn', 'invite email failed', { inviteId: out.id, error: String(err) });
  }
  await audit(ctx.db, { event: 'ADMIN_ACTION', userId: admin.userId, at: ctx.now(), metadata: { action: emailed ? 'INVITE_EMAILED' : 'INVITE_EMAIL_FAILED', inviteId: out.id } });
  return { ...created, emailed };
}

/** An admin sees every invite and who made it; an invite helper sees only their own (their notes, their testers). */
export async function listInvites(ctx: ApiContext, viewer: SessionInfo) {
  const own = viewer.role !== 'admin';
  const rows = await ctx.db.query<{ id: string; email: string | null; note: string | null; created_at: Date; expires_at: Date | null; used_at: Date | null; revoked_at: Date | null; used_by_handle: string | null; made_by: string | null; mine: boolean }>(
    `SELECT i.id::text AS id, i.email, i.note, i.created_at, i.expires_at, i.used_at, i.revoked_at, u.handle AS used_by_handle,
            c.handle AS made_by, i.created_by = $1::uuid AS mine
       FROM invite_codes i LEFT JOIN users u ON u.id = i.used_by JOIN users c ON c.id = i.created_by
      WHERE NOT $2::boolean OR i.created_by = $1::uuid
      ORDER BY i.created_at DESC LIMIT 200`,
    [viewer.userId, own]
  );
  const now = ctx.now();
  return rows.map((r) => ({
    id: r.id, email: r.email, note: r.note, createdAt: r.created_at, expiresAt: r.expires_at, usedAt: r.used_at, usedBy: r.used_by_handle,
    status: r.used_at ? 'used' : r.revoked_at ? 'revoked' : r.expires_at && r.expires_at <= now ? 'expired' : 'active',
    madeBy: r.mine ? null : r.made_by, // only shown to an admin, for codes someone else made
  }));
}

export async function revokeInvite(ctx: ApiContext, admin: SessionInfo, id: string): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const rows = await tx.query(
      `UPDATE invite_codes SET revoked_at = $2 WHERE id = $1::uuid AND used_at IS NULL AND revoked_at IS NULL AND ($3::boolean OR created_by = $4::uuid) RETURNING 1`,
      [id, ctx.now(), admin.role === 'admin', admin.userId]
    );
    if (rows.length) await audit(tx, { event: 'ADMIN_ACTION', userId: admin.userId, at: ctx.now(), metadata: { action: 'INVITE_REVOKED', inviteId: id } });
    return rows.length > 0;
  });
}

// ── invite helpers (v1.21, Nath 2026-10-30) ──────────────────────────────────
// An admin lets a signed-up tester make sign-up codes too (role 'recruiter'),
// so new testers don't all come through the admin's inbox. A helper can make,
// list and revoke only their own codes; feedback and every other admin tool stay
// admin-only. The role is read with the session, so a change applies at once.

export interface Helper { id: string; email: string; handle: string | null }

export async function listHelpers(ctx: ApiContext): Promise<Helper[]> {
  return ctx.db.query<Helper>(`SELECT id::text AS id, email, handle FROM users WHERE role = 'recruiter' ORDER BY lower(coalesce(handle, email))`);
}

export async function addHelper(ctx: ApiContext, admin: SessionInfo, rawEmail: string): Promise<Helper> {
  const email = rawEmail.trim().toLowerCase();
  return ctx.db.transaction(async (tx) => {
    const [u] = await tx.query<Helper & { role: string; status: string }>(
      `SELECT id::text AS id, email, handle, role, status FROM users WHERE email = $1 FOR UPDATE`, [email]
    );
    if (!u) throw new HttpError(404, 'NO_ACCOUNT', 'No account with that email yet. They need to finish signing up first.');
    if (u.status !== 'active') throw new HttpError(409, 'ACCOUNT_SUSPENDED', 'That account is suspended');
    if (u.role === 'admin') throw new HttpError(409, 'ALREADY_ADMIN', 'That account is an admin: it can already make codes');
    if (u.role === 'user') {
      await tx.query(`UPDATE users SET role = 'recruiter', updated_at = $2 WHERE id = $1::uuid`, [u.id, ctx.now()]);
      await audit(tx, { event: 'ADMIN_ACTION', userId: u.id, performedBy: admin.userId, at: ctx.now(), metadata: { action: 'INVITE_HELPER_ADDED' } });
      await invalidateUserSessions(ctx, tx, u.id);
    }
    return { id: u.id, email: u.email, handle: u.handle };
  });
}

/** Their codes already sent stay valid: the people holding them did nothing wrong. Revoke them one by one if needed. */
export async function removeHelper(ctx: ApiContext, admin: SessionInfo, userId: string): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const rows = await tx.query(`UPDATE users SET role = 'user', updated_at = $2 WHERE id = $1::uuid AND role = 'recruiter' RETURNING 1`, [userId, ctx.now()]);
    if (!rows.length) return false;
    await audit(tx, { event: 'ADMIN_ACTION', userId, performedBy: admin.userId, at: ctx.now(), metadata: { action: 'INVITE_HELPER_REMOVED' } });
    await invalidateUserSessions(ctx, tx, userId);
    return true;
  });
}
