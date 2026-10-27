/**
 * TOTP — RFC 6238 (HOTP RFC 4226 over 30-second steps) — PRD-006 §6.3
 *
 * SHA-1, 6 digits, 30 s step: what Google Authenticator, Authy and 1Password
 * expect. Verification accepts ±1 step of clock drift and returns the step
 * that matched, so callers can refuse replays (step ≤ last used step).
 */
import { createHmac, randomBytes } from 'node:crypto';
import { base32Decode, base32Encode, safeEqual } from './crypto';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20)); // 160 bits, as RFC 4226 recommends
}

export function hotp(key: Buffer, counter: bigint, digits = TOTP_DIGITS, algorithm: 'sha1' | 'sha256' | 'sha512' = 'sha1'): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const mac = createHmac(algorithm, key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const stepAt = (at: Date): bigint => BigInt(Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS));

export function totp(secretBase32: string, at: Date): string {
  return hotp(base32Decode(secretBase32), stepAt(at));
}

/** Returns the matching time step, or null. Window ±1 step. */
export function verifyTotp(secretBase32: string, code: string, at: Date): bigint | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secretBase32);
  const now = stepAt(at);
  let matched: bigint | null = null;
  for (const delta of [-1n, 0n, 1n]) {
    // Evaluate every candidate (no early exit) so timing doesn't reveal which step matched.
    if (safeEqual(hotp(key, now + delta), code) && matched === null) matched = now + delta;
  }
  return matched;
}

export function otpauthUrl(secretBase32: string, accountLabel: string, issuer = 'Burnout League'): string {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}
