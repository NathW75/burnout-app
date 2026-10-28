/**
 * AI connector credentials (PRD-011 §5). A personal token is `bl_mcp_` plus 64
 * hex characters, shown once; only its SHA-256 is stored, so the row is found
 * by hash. Read-only, bound to one user, revocable.
 */
import { createHash, randomBytes } from 'node:crypto';
import { audit } from '../auth/audit';
import type { ApiContext } from '../context';
import { HttpError, notFound } from '../errors';

export const PERSONAL_TOKEN_PREFIX = 'bl_mcp_';
export const PERSONAL_TOKEN_DAYS = 90;
export const MAX_ACTIVE_PERSONAL = 5;
/** last_used_at is written at most this often per credential (PRD-011 §9). */
export const TOUCH_EVERY_MS = 5 * 60_000;

const TOKEN_RE = /^bl_mcp_[0-9a-f]{64}$/;

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export interface McpPrincipal {
  credentialId: string;
  userId: string;
  kind: 'personal' | 'oauth_access';
  scope: string;
}

export interface CredentialView {
  id: string;
  kind: 'personal';
  label: string | null;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
}

export async function createPersonalToken(ctx: ApiContext, userId: string, label: string | null): Promise<{ token: string; credential: CredentialView }> {
  const now = ctx.now();
  const token = PERSONAL_TOKEN_PREFIX + randomBytes(32).toString('hex');
  const expires = new Date(now.getTime() + PERSONAL_TOKEN_DAYS * 86_400_000);
  const row = await ctx.db.transaction(async (tx) => {
    // Serialize per user so two creates can't both pass the cap.
    await tx.query(`SELECT 1 FROM users WHERE id = $1::uuid FOR UPDATE`, [userId]);
    const [{ n }] = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM mcp_credentials WHERE user_id = $1::uuid AND kind = 'personal' AND revoked_at IS NULL AND expires_at > $2`,
      [userId, now]
    );
    if (n >= MAX_ACTIVE_PERSONAL) throw new HttpError(409, 'MCP_TOKEN_LIMIT', `You can have up to ${MAX_ACTIVE_PERSONAL} active tokens. Revoke one first.`);
    const [r] = await tx.query<{ id: string }>(
      `INSERT INTO mcp_credentials (user_id, kind, token_hash, label, expires_at, created_at) VALUES ($1::uuid, 'personal', $2, $3, $4, $5) RETURNING id::text AS id`,
      [userId, hashToken(token), label, expires, now]
    );
    await audit(tx, { event: 'MCP_TOKEN_CREATED', userId, at: now, metadata: { credentialId: r.id } });
    return r;
  });
  return { token, credential: { id: row.id, kind: 'personal', label, createdAt: now, expiresAt: expires, lastUsedAt: null } };
}

/** Active personal tokens (newest first). OAuth connections join this list in part 2. */
export async function listCredentials(ctx: ApiContext, userId: string): Promise<{ tokens: CredentialView[]; maxTokens: number }> {
  const rows = await ctx.db.query<{ id: string; label: string | null; created_at: Date; expires_at: Date; last_used_at: Date | null }>(
    `SELECT id::text AS id, label, created_at, expires_at, last_used_at FROM mcp_credentials
      WHERE user_id = $1::uuid AND kind = 'personal' AND revoked_at IS NULL AND expires_at > $2
      ORDER BY created_at DESC, id`,
    [userId, ctx.now()]
  );
  return {
    tokens: rows.map((r) => ({ id: r.id, kind: 'personal', label: r.label, createdAt: r.created_at, expiresAt: r.expires_at, lastUsedAt: r.last_used_at })),
    maxTokens: MAX_ACTIVE_PERSONAL,
  };
}

export async function revokePersonalToken(ctx: ApiContext, userId: string, id: string): Promise<void> {
  const now = ctx.now();
  await ctx.db.transaction(async (tx) => {
    const rows = await tx.query(
      `UPDATE mcp_credentials SET revoked_at = $3 WHERE id = $1::uuid AND user_id = $2::uuid AND kind = 'personal' AND revoked_at IS NULL RETURNING 1`,
      [id, userId, now]
    );
    if (!rows.length) throw notFound('No such token');
    await audit(tx, { event: 'MCP_TOKEN_REVOKED', userId, at: now, metadata: { credentialId: id } });
  });
}

/**
 * The credential behind an `Authorization: Bearer` value, or null. Only MCP
 * credentials are recognized here: session tokens never are (PRD-011 §5.4).
 */
export async function verifyBearer(ctx: ApiContext, header: string | undefined): Promise<McpPrincipal | null> {
  const token = /^Bearer\s+(\S+)$/i.exec(header ?? '')?.[1];
  if (!token || !TOKEN_RE.test(token)) return null;
  const now = ctx.now();
  const [r] = await ctx.db.query<{ id: string; user_id: string; kind: 'personal' | 'oauth_access'; scope: string; last_used_at: Date | null }>(
    `SELECT c.id::text AS id, c.user_id::text AS user_id, c.kind, c.scope, c.last_used_at
       FROM mcp_credentials c JOIN users u ON u.id = c.user_id
      WHERE c.token_hash = $1 AND c.kind IN ('personal', 'oauth_access') AND c.revoked_at IS NULL AND c.expires_at > $2 AND u.status = 'active'`,
    [hashToken(token), now]
  );
  if (!r) return null;
  if (!r.last_used_at || now.getTime() - new Date(r.last_used_at).getTime() >= TOUCH_EVERY_MS) {
    await ctx.db.query(`UPDATE mcp_credentials SET last_used_at = $2 WHERE id = $1::uuid`, [r.id, now]);
  }
  return { credentialId: r.id, userId: r.user_id, kind: r.kind, scope: r.scope };
}
