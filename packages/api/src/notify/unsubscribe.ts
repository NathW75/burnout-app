/**
 * One-click unsubscribe tokens (PRD-008 §5–§6, RFC 8058). The token names the
 * user and is signed with a key derived from the TOTP key. It does one thing:
 * turn optional email off. It never signs anyone in.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const b64 = (b: Buffer) => b.toString('base64url');

function mac(key: Buffer, userId: string): string {
  return b64(createHmac('sha256', key).update(`unsubscribe:${userId}`).digest()).slice(0, 27);
}

export function unsubscribeToken(key: Buffer, userId: string): string {
  return `${b64(Buffer.from(userId.replace(/-/g, ''), 'hex'))}.${mac(key, userId)}`;
}

/** The user id, or null if the token is malformed or forged. */
export function verifyUnsubscribeToken(key: Buffer, token: string): string | null {
  const m = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{27})$/.exec(token);
  if (!m) return null;
  const hex = Buffer.from(m[1], 'base64url').toString('hex');
  if (hex.length !== 32) return null;
  const userId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const want = Buffer.from(mac(key, userId));
  const got = Buffer.from(m[2]);
  return want.length === got.length && timingSafeEqual(want, got) ? userId : null;
}
