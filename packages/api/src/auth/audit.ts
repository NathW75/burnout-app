/**
 * security_audit_log writer — PRD-006 §6.8 (the table is append-only).
 */
import { SYSTEM_USER_ID } from '../context';
import type { SqlRunner } from '../sql';

export type AuditEvent =
  | 'LOGIN' | 'LOGIN_FAILED' | 'LOGOUT' | 'SESSIONS_REVOKED' | 'PASSWORD_CHANGED' | 'PASSWORD_RESET'
  | 'TOTP_ENROLLED' | 'BACKUP_CODES_REGENERATED' | 'BACKUP_CODE_USED' | 'STEP_UP' | 'STEP_UP_FAILED'
  | 'LINEUP_CONFIRMED' | 'SUBMISSION_REPOINTED' | 'SUBMISSION_VOIDED' | 'ADMIN_ACTION' | 'EMAIL_VERIFIED' | 'MFA_RESET'
  | 'PLAYER_MERGED' | 'MCP_TOKEN_CREATED' | 'MCP_TOKEN_REVOKED';

export async function audit(
  q: SqlRunner,
  e: { event: AuditEvent; userId?: string | null; performedBy?: string | null; at: Date; metadata?: object; slotKey?: string; gameId?: string }
): Promise<void> {
  await q.query(
    `INSERT INTO security_audit_log (event_type, user_id, performed_by, performed_at, metadata, slot_key, game_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [e.event, e.userId ?? null, e.performedBy ?? e.userId ?? SYSTEM_USER_ID, e.at, JSON.stringify(e.metadata ?? {}), e.slotKey ?? null, e.gameId ?? null]
  );
}
