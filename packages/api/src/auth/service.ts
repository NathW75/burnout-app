/**
 * Accounts, second factors and step-up — PRD-006 §6
 */
import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import { validateHandle, HandleError } from '@burnout/leaderboard';
import type { ApiContext } from '../context';
import { conflict, forbidden, HttpError, tooMany, unauthorized } from '../errors';
import type { SqlRunner } from '../sql';
import { audit } from './audit';
import { randomToken, sha256Hex } from './crypto';
import { createSession, invalidateUserSessions, revokeSessions, updateSession, type SessionInfo } from './sessions';
import { newTotpSecret, otpauthUrl, verifyTotp } from './totp';

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;
const LOGIN_EMAIL_LIMIT = 5;
const LOGIN_IP_LIMIT = 20;
const LOGIN_WINDOW_S = 15 * 60;
const CODE_ATTEMPT_LIMIT = 5;

export const normalizeEmail = (e: string) => e.trim().toLowerCase();

export function checkPassword(pw: string): void {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN || pw.length > PASSWORD_MAX) {
    throw new HttpError(400, 'WEAK_PASSWORD', `Password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters`);
  }
}

let dummyHash: string | null = null;
async function dummy(ctx: ApiContext): Promise<string> {
  dummyHash ??= await bcrypt.hash(randomToken(), ctx.config.bcryptCost);
  return dummyHash;
}

const hashPassword = (ctx: ApiContext, pw: string) => bcrypt.hash(pw, ctx.config.bcryptCost);

interface Client {
  client: 'web' | 'mobile';
  ip?: string;
  userAgent?: string;
}

// ── signup and email verification (§6.1) ────────────────────────────────────

async function issueToken(q: SqlRunner, ctx: ApiContext, userId: string, purpose: 'email_verify' | 'password_reset'): Promise<string> {
  const token = randomToken();
  const now = ctx.now();
  const ttl = purpose === 'email_verify' ? ctx.config.emailVerifyTtlMs : ctx.config.passwordResetTtlMs;
  await q.query(
    `INSERT INTO auth_tokens (user_id, purpose, token_hash, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)`,
    [userId, purpose, sha256Hex(token), now, new Date(now.getTime() + ttl)]
  );
  return token;
}

/**
 * Same 202 response whether or not the email exists (no enumeration). A new
 * account gets a verification email; an existing one gets an "account exists"
 * email. The client signs in with /auth/login afterwards.
 */
export async function signup(ctx: ApiContext, req: { email: string; password: string; handle: string }): Promise<void> {
  checkPassword(req.password);
  try {
    validateHandle(req.handle);
  } catch (err) {
    if (err instanceof HandleError) throw new HttpError(400, err.code, err.message);
    throw err;
  }
  const email = normalizeEmail(req.email);
  const hash = await hashPassword(ctx, req.password); // always hash: same work either way
  const now = ctx.now();
  // Handles are public, so saying one is taken reveals nothing about any email.
  const [taken] = await ctx.db.query(
    `SELECT 1 FROM user_handle_history WHERE lower(handle) = lower($1) AND (valid_to IS NULL OR valid_to > $2::timestamptz - interval '30 days')`,
    [req.handle, now]
  );
  if (taken) throw new HttpError(409, 'HANDLE_TAKEN', 'That handle is taken.');
  const [existing] = await ctx.db.query<{ id: string }>(`SELECT id::text AS id FROM users WHERE email = $1`, [email]);
  if (existing) {
    await ctx.mailer.send({ to: email, template: 'account_exists', data: { link: `${ctx.config.appBaseUrl}/reset-password` } });
    return;
  }
  const userId = await ctx.db.transaction(async (tx) => {
    const [u] = await tx.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name, updated_at, password_changed_at)
       VALUES ($1, $2, $3, $4, $4) ON CONFLICT (email) DO NOTHING RETURNING id::text AS id`,
      [email, hash, req.handle, now]
    );
    return u?.id ?? null;
  });
  if (!userId) return; // lost a race with an identical signup
  try {
    await ctx.leaderboard.setHandle(userId, req.handle, ctx.config.currentSeason, now);
  } catch (err) {
    // Lost a race for the handle after the pre-check: the account stands, and the user picks a handle after signing in.
    if (!(err instanceof HandleError)) throw err;
    ctx.log('warn', 'signup handle lost a race; account created without a handle', { userId });
  }
  const token = await issueToken(ctx.db, ctx, userId, 'email_verify');
  await ctx.mailer.send({ to: email, template: 'verify_email', data: { link: `${ctx.config.appBaseUrl}/verify-email?token=${token}` } });
}

async function consumeToken(q: SqlRunner, ctx: ApiContext, token: string, purpose: 'email_verify' | 'password_reset'): Promise<string> {
  const [t] = await q.query<{ user_id: string }>(
    `UPDATE auth_tokens SET used_at = $3 WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > $3
     RETURNING user_id::text AS user_id`,
    [sha256Hex(token), purpose, ctx.now()]
  );
  if (!t) throw new HttpError(400, 'TOKEN_INVALID', 'This link is invalid or has expired');
  return t.user_id;
}

export async function verifyEmail(ctx: ApiContext, token: string): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const userId = await consumeToken(tx, ctx, token, 'email_verify');
    await tx.query(`UPDATE users SET email_verified_at = COALESCE(email_verified_at, $2), updated_at = $2 WHERE id = $1::uuid`, [userId, ctx.now()]);
    await audit(tx, { event: 'EMAIL_VERIFIED', userId, at: ctx.now() });
    await invalidateUserSessions(ctx, tx, userId);
  });
}

export async function resendVerification(ctx: ApiContext, s: SessionInfo): Promise<void> {
  if (s.emailVerified) return;
  if (!(await ctx.limiter.hit(`verify-resend:${s.userId}`, 3, 3600))) throw tooMany();
  const token = await issueToken(ctx.db, ctx, s.userId, 'email_verify');
  await ctx.mailer.send({ to: s.email, template: 'verify_email', data: { link: `${ctx.config.appBaseUrl}/verify-email?token=${token}` } });
}

// ── sign-in (§6.2) ──────────────────────────────────────────────────────────

export interface LoginResult {
  token: string;
  mfaRequired: boolean;
}

export async function login(ctx: ApiContext, req: { email: string; password: string } & Client): Promise<LoginResult> {
  const email = normalizeEmail(req.email);
  const ipKey = `login:ip:${req.ip ?? 'unknown'}`;
  const emailKey = `login:email:${email}`;
  if ((await ctx.limiter.blocked(emailKey, LOGIN_EMAIL_LIMIT)) || (await ctx.limiter.blocked(ipKey, LOGIN_IP_LIMIT))) throw tooMany();

  const [u] = await ctx.db.query<{ id: string; password_hash: string; status: string; has_factor: boolean }>(
    `SELECT u.id::text AS id, u.password_hash, u.status,
            EXISTS (SELECT 1 FROM auth_factors f WHERE f.user_id = u.id AND f.confirmed_at IS NOT NULL AND f.disabled_at IS NULL) AS has_factor
       FROM users u WHERE u.email = $1`,
    [email]
  );
  const ok = await bcrypt.compare(req.password ?? '', u?.password_hash ?? (await dummy(ctx)));
  const now = ctx.now();
  if (!u || !ok || u.status !== 'active') {
    await ctx.limiter.hit(emailKey, LOGIN_EMAIL_LIMIT, LOGIN_WINDOW_S);
    await ctx.limiter.hit(ipKey, LOGIN_IP_LIMIT, LOGIN_WINDOW_S);
    if (u) await audit(ctx.db, { event: 'LOGIN_FAILED', userId: u.id, at: now, metadata: { ip: req.ip, suspended: u.status !== 'active' } });
    throw unauthorized('INVALID_CREDENTIALS', 'Email or password is incorrect');
  }
  await ctx.limiter.reset(emailKey);
  return ctx.db.transaction(async (tx) => {
    const { token } = await createSession(tx, ctx, { userId: u.id, client: req.client, ip: req.ip, userAgent: req.userAgent, mfaPending: u.has_factor });
    await tx.query(`UPDATE users SET last_login_at = $2 WHERE id = $1::uuid`, [u.id, now]);
    await audit(tx, { event: 'LOGIN', userId: u.id, at: now, metadata: { client: req.client, ip: req.ip, mfaPending: u.has_factor } });
    return { token, mfaRequired: u.has_factor };
  });
}

// ── second factors (§6.3) ───────────────────────────────────────────────────

const BACKUP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const normalizeBackup = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');

function newBackupCode(): string {
  let s = '';
  for (let i = 0; i < 10; i++) s += BACKUP_ALPHABET[randomInt(BACKUP_ALPHABET.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

async function issueBackupCodes(tx: SqlRunner, ctx: ApiContext, userId: string): Promise<string[]> {
  const now = ctx.now();
  await tx.query(`UPDATE backup_codes SET revoked_at = $2 WHERE user_id = $1::uuid AND used_at IS NULL AND revoked_at IS NULL`, [userId, now]);
  const codes = Array.from({ length: 10 }, newBackupCode);
  await tx.query(
    `INSERT INTO backup_codes (user_id, code_hash, created_at) SELECT $1::uuid, h, $3 FROM unnest($2::text[]) AS h`,
    [userId, codes.map((c) => sha256Hex(normalizeBackup(c))), now]
  );
  return codes;
}

/**
 * Checks a TOTP code (replay-protected via last_used_step) or a backup code
 * (single use). Consumes it on success.
 */
export async function consumeSecondFactor(tx: SqlRunner, ctx: ApiContext, userId: string, code: string): Promise<'totp' | 'backup' | null> {
  const now = ctx.now();
  const trimmed = String(code ?? '').trim();
  if (/^\d{6}$/.test(trimmed)) {
    const [f] = await tx.query<{ id: string; secret_ciphertext: string; last_used_step: string | null }>(
      `SELECT id::text AS id, secret_ciphertext, last_used_step::text AS last_used_step FROM auth_factors
        WHERE user_id = $1::uuid AND kind = 'totp' AND confirmed_at IS NOT NULL AND disabled_at IS NULL FOR UPDATE`,
      [userId]
    );
    if (!f) return null;
    const step = verifyTotp(ctx.secretBox.open(f.secret_ciphertext), trimmed, now);
    if (step === null || (f.last_used_step !== null && step <= BigInt(f.last_used_step))) return null;
    await tx.query(`UPDATE auth_factors SET last_used_step = $2 WHERE id = $1::uuid`, [f.id, step.toString()]);
    return 'totp';
  }
  const norm = normalizeBackup(trimmed);
  if (norm.length !== 10) return null;
  const [b] = await tx.query(
    `UPDATE backup_codes SET used_at = $3 WHERE user_id = $1::uuid AND code_hash = $2 AND used_at IS NULL AND revoked_at IS NULL RETURNING 1`,
    [userId, sha256Hex(norm), now]
  );
  if (!b) return null;
  await audit(tx, { event: 'BACKUP_CODE_USED', userId, at: now });
  return 'backup';
}

/** Pending session → full session with the second factor (§6.2). */
export async function completeMfaLogin(ctx: ApiContext, s: SessionInfo, code: string): Promise<void> {
  if (!s.mfaPending) throw conflict('MFA_NOT_PENDING', 'This session is already signed in');
  const ok = await ctx.db.transaction(async (tx) => {
    const kind = await consumeSecondFactor(tx, ctx, s.userId, code);
    const now = ctx.now();
    if (!kind) {
      const [r] = await tx.query<{ mfa_attempts: number }>(
        `UPDATE sessions SET mfa_attempts = mfa_attempts + 1 WHERE id = $1::uuid RETURNING mfa_attempts`,
        [s.id]
      );
      await audit(tx, { event: 'LOGIN_FAILED', userId: s.userId, at: now, metadata: { stage: 'mfa' } });
      if (r.mfa_attempts >= CODE_ATTEMPT_LIMIT) await revokeSessions(ctx, tx, { sessionId: s.id });
      return false;
    }
    // A fresh second-factor check: counts as step-up too.
    await updateSession(ctx, tx, s.id, { mfaPending: false, stepUpAt: now, expiresAt: new Date(now.getTime() + ctx.config.sessionMaxMs) });
    return true;
  });
  if (!ok) throw unauthorized('INVALID_CODE', 'That code is not valid');
}

async function verifyPasswordFor(ctx: ApiContext, userId: string, password: string): Promise<void> {
  const [u] = await ctx.db.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1::uuid`, [userId]);
  if (!u || !(await bcrypt.compare(password ?? '', u.password_hash))) throw unauthorized('INVALID_CREDENTIALS', 'Password is incorrect');
}

export function hasFreshStepUp(ctx: ApiContext, s: SessionInfo): boolean {
  return !!s.stepUpAt && ctx.now().getTime() - s.stepUpAt.getTime() <= ctx.config.stepUpMaxAgeMs && s.stepUpAt <= ctx.now();
}

/** Starts TOTP enrolment. Replacing an active factor needs step-up. */
export async function totpSetup(ctx: ApiContext, s: SessionInfo, password: string): Promise<{ secret: string; otpauthUrl: string }> {
  await verifyPasswordFor(ctx, s.userId, password);
  if (s.hasFactor && !hasFreshStepUp(ctx, s)) throw forbidden('STEP_UP_REQUIRED', 'Confirm with your current second factor first');
  const secret = newTotpSecret();
  const now = ctx.now();
  await ctx.db.transaction(async (tx) => {
    await tx.query(`UPDATE auth_factors SET disabled_at = $2 WHERE user_id = $1::uuid AND kind = 'totp' AND confirmed_at IS NULL AND disabled_at IS NULL`, [s.userId, now]);
    await tx.query(
      `INSERT INTO auth_factors (user_id, kind, secret_ciphertext, created_at) VALUES ($1, 'totp', $2, $3)`,
      [s.userId, ctx.secretBox.seal(secret), now]
    );
  });
  return { secret, otpauthUrl: otpauthUrl(secret, s.email) };
}

/** Activates the pending TOTP factor and returns 10 backup codes, shown once. */
export async function totpConfirm(ctx: ApiContext, s: SessionInfo, code: string): Promise<{ backupCodes: string[] }> {
  return ctx.db.transaction(async (tx) => {
    const now = ctx.now();
    const [f] = await tx.query<{ id: string; secret_ciphertext: string }>(
      `SELECT id::text AS id, secret_ciphertext FROM auth_factors
        WHERE user_id = $1::uuid AND kind = 'totp' AND confirmed_at IS NULL AND disabled_at IS NULL
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [s.userId]
    );
    if (!f) throw conflict('NO_PENDING_FACTOR', 'Start TOTP setup first');
    const step = verifyTotp(ctx.secretBox.open(f.secret_ciphertext), String(code ?? '').trim(), now);
    if (step === null) throw unauthorized('INVALID_CODE', 'That code is not valid');
    await tx.query(`UPDATE auth_factors SET disabled_at = $2 WHERE user_id = $1::uuid AND kind = 'totp' AND confirmed_at IS NOT NULL AND disabled_at IS NULL`, [s.userId, now]);
    await tx.query(`UPDATE auth_factors SET confirmed_at = $2, last_used_step = $3 WHERE id = $1::uuid`, [f.id, now, step.toString()]);
    const backupCodes = await issueBackupCodes(tx, ctx, s.userId);
    await audit(tx, { event: 'TOTP_ENROLLED', userId: s.userId, at: now, metadata: { replaced: s.hasFactor } });
    await invalidateUserSessions(ctx, tx, s.userId);
    return { backupCodes };
  });
}

export async function regenerateBackupCodes(ctx: ApiContext, s: SessionInfo): Promise<{ backupCodes: string[] }> {
  return ctx.db.transaction(async (tx) => {
    const backupCodes = await issueBackupCodes(tx, ctx, s.userId);
    await audit(tx, { event: 'BACKUP_CODES_REGENERATED', userId: s.userId, at: ctx.now() });
    return { backupCodes };
  });
}

// ── step-up (§6.5) ──────────────────────────────────────────────────────────

export async function stepUp(ctx: ApiContext, s: SessionInfo, code: string): Promise<{ stepUpUntil: Date }> {
  if (!s.hasFactor) throw forbidden('MFA_ENROLLMENT_REQUIRED', 'Set up two-factor authentication first');
  const key = `stepup:${s.id}`;
  if (await ctx.limiter.blocked(key, CODE_ATTEMPT_LIMIT)) throw tooMany();
  const now = ctx.now();
  const ok = await ctx.db.transaction(async (tx) => {
    const kind = await consumeSecondFactor(tx, ctx, s.userId, code);
    if (!kind) {
      await audit(tx, { event: 'STEP_UP_FAILED', userId: s.userId, at: now });
      return false;
    }
    await updateSession(ctx, tx, s.id, { stepUpAt: now });
    await audit(tx, { event: 'STEP_UP', userId: s.userId, at: now, metadata: { via: kind } });
    return true;
  });
  if (!ok) {
    await ctx.limiter.hit(key, CODE_ATTEMPT_LIMIT, 15 * 60);
    throw unauthorized('INVALID_CODE', 'That code is not valid');
  }
  await ctx.limiter.reset(key);
  return { stepUpUntil: new Date(now.getTime() + ctx.config.stepUpMaxAgeMs) };
}

// ── passwords (§6.6) ────────────────────────────────────────────────────────

export async function changePassword(ctx: ApiContext, s: SessionInfo, current: string, next: string): Promise<void> {
  checkPassword(next);
  await verifyPasswordFor(ctx, s.userId, current);
  const hash = await hashPassword(ctx, next);
  await ctx.db.transaction(async (tx) => {
    const now = ctx.now();
    await tx.query(`UPDATE users SET password_hash = $2, password_changed_at = $3, updated_at = $3 WHERE id = $1::uuid`, [s.userId, hash, now]);
    const n = await revokeSessions(ctx, tx, { userId: s.userId, exceptSessionId: s.id });
    await audit(tx, { event: 'PASSWORD_CHANGED', userId: s.userId, at: now, metadata: { sessionsRevoked: n } });
  });
}

/** Always succeeds from the caller's point of view (no enumeration). */
export async function requestPasswordReset(ctx: ApiContext, emailRaw: string): Promise<void> {
  const email = normalizeEmail(emailRaw);
  if (!(await ctx.limiter.hit(`reset:email:${email}`, 3, 3600))) return;
  const [u] = await ctx.db.query<{ id: string }>(`SELECT id::text AS id FROM users WHERE email = $1 AND status = 'active'`, [email]);
  if (!u) return;
  const token = await issueToken(ctx.db, ctx, u.id, 'password_reset');
  await ctx.mailer.send({ to: email, template: 'password_reset', data: { link: `${ctx.config.appBaseUrl}/reset-password?token=${token}` } });
}

export async function resetPassword(ctx: ApiContext, token: string, next: string): Promise<void> {
  checkPassword(next);
  const hash = await hashPassword(ctx, next);
  await ctx.db.transaction(async (tx) => {
    const userId = await consumeToken(tx, ctx, token, 'password_reset');
    const now = ctx.now();
    await tx.query(`UPDATE users SET password_hash = $2, password_changed_at = $3, updated_at = $3 WHERE id = $1::uuid`, [userId, hash, now]);
    const n = await revokeSessions(ctx, tx, { userId });
    await audit(tx, { event: 'PASSWORD_RESET', userId, at: now, metadata: { sessionsRevoked: n } });
  });
}

// ── sessions and suspension ─────────────────────────────────────────────────

export async function logout(ctx: ApiContext, s: SessionInfo): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    await revokeSessions(ctx, tx, { sessionId: s.id });
    await audit(tx, { event: 'LOGOUT', userId: s.userId, at: ctx.now() });
  });
}

export async function logoutAll(ctx: ApiContext, s: SessionInfo): Promise<number> {
  return ctx.db.transaction(async (tx) => {
    const n = await revokeSessions(ctx, tx, { userId: s.userId });
    await audit(tx, { event: 'SESSIONS_REVOKED', userId: s.userId, at: ctx.now(), metadata: { count: n, scope: 'all' } });
    return n;
  });
}

export async function listSessions(ctx: ApiContext, s: SessionInfo) {
  const rows = await ctx.db.query<{ id: string; client: string; ip_address: string | null; user_agent: string | null; created_at: Date; last_seen_at: Date }>(
    `SELECT id::text AS id, client, ip_address, user_agent, created_at, last_seen_at FROM sessions
      WHERE user_id = $1::uuid AND revoked_at IS NULL AND expires_at > $2 AND mfa_pending = false ORDER BY last_seen_at DESC`,
    [s.userId, ctx.now()]
  );
  return rows.map((r) => ({ id: r.id, client: r.client, ip: r.ip_address, userAgent: r.user_agent, createdAt: r.created_at, lastSeenAt: r.last_seen_at, current: r.id === s.id }));
}

export async function revokeOwnSession(ctx: ApiContext, s: SessionInfo, sessionId: string): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const n = await revokeSessions(ctx, tx, { sessionId, userId: s.userId });
    if (n) await audit(tx, { event: 'SESSIONS_REVOKED', userId: s.userId, at: ctx.now(), metadata: { sessionId } });
    return n > 0;
  });
}

export async function suspendUser(ctx: ApiContext, admin: SessionInfo, userId: string, reason: string): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const now = ctx.now();
    const [u] = await tx.query(`UPDATE users SET status = 'suspended', updated_at = $2 WHERE id = $1::uuid RETURNING 1`, [userId, now]);
    if (!u) throw new HttpError(404, 'NOT_FOUND', 'No such user');
    await invalidateUserSessions(ctx, tx, userId);
    const n = await revokeSessions(ctx, tx, { userId });
    await audit(tx, { event: 'ADMIN_ACTION', userId, performedBy: admin.userId, at: now, metadata: { action: 'suspend', reason, sessionsRevoked: n } });
  });
}
