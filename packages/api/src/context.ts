/**
 * API context and configuration — PRD-006 §13
 */
import type { Redis } from 'ioredis';
import type { createLeaderboardService } from '@burnout/leaderboard';
import type { PaymentsService } from '@burnout/payments';
import type { SecretBox } from './auth/crypto';
import type { RateLimiter } from './auth/rate-limit';
import type { TurnstileVerifier } from './auth/turnstile';
import type { Mailer } from './mailer';
import type { SqlDatabase } from './sql';

export interface ApiConfig {
  bcryptCost: number;
  /** Requests per minute from one client IP, across the whole API (PRD-006 §10). */
  ipRateLimitPerMinute: number;
  sessionIdleMs: number;
  sessionMaxMs: number;
  pendingMfaMs: number;
  touchIntervalMs: number;
  sessionCacheSeconds: number;
  stepUpMaxAgeMs: number;
  confirmationTtlMs: number;
  emailVerifyTtlMs: number;
  passwordResetTtlMs: number;
  cookieName: string;
  cookieSecure: boolean;
  corsOrigins: string[];
  appBaseUrl: string;
  /** Trusted edge headers for checkout geolocation (§10.4). */
  geoRegionHeader: string;
  geoCountryHeader: string;
  /** Number of proxies in front of the app (for req.ip). */
  trustProxy: number;
  /**
   * Shared secret Cloudflare adds to every proxied request (§10.4). Only a
   * request that carries it may use the cf-* location and client-IP headers;
   * otherwise they are dropped, so checkout sees an unknown region (blocked).
   * '' = nothing is trusted. null = no edge in front (local and tests only).
   */
  edgeSecret: string | null;
  currentSeason: string;
  /** Cloudflare Turnstile secret for sign-up (PRD-007 §8.4). null = not checked (local and tests only). */
  turnstileSecret: string | null;
  /** Sign-up needs a single-use invite code (PRD-006 §6.10). SIGNUP_INVITE_ONLY=on. */
  signupInviteOnly: boolean;
  /** Web push public key (PRD-008 §9); null = push is off (NOTIFY_PUSH isn't on). */
  vapidPublicKey: string | null;
}

export const DEFAULT_API_CONFIG: ApiConfig = {
  bcryptCost: 12,
  ipRateLimitPerMinute: 300,
  // Signed in until you sign out (Nath, 2026-10-28; PRD-006 D1 v1.13): 90 days idle, each visit restarts it; 1-year hard limit.
  // Money, security changes and admin still ask for a fresh code (step-up).
  sessionIdleMs: 90 * 24 * 3600_000,
  sessionMaxMs: 365 * 24 * 3600_000,
  pendingMfaMs: 5 * 60_000,
  touchIntervalMs: 5 * 60_000,
  sessionCacheSeconds: 60,
  stepUpMaxAgeMs: 5 * 60_000,
  confirmationTtlMs: 10 * 60_000,
  emailVerifyTtlMs: 48 * 3600_000,
  passwordResetTtlMs: 3600_000,
  cookieName: 'bl_session',
  cookieSecure: true,
  corsOrigins: [],
  appBaseUrl: 'https://burnoutfantasy.com',
  geoRegionHeader: 'cf-region-code',
  geoCountryHeader: 'cf-ipcountry',
  trustProxy: 1,
  edgeSecret: null,
  currentSeason: '2026-2027-regular',
  turnstileSecret: null,
  signupInviteOnly: false,
  vapidPublicKey: null,
};

export type Log = (level: 'info' | 'warn' | 'error', message: string, meta?: object) => void;

export type LeaderboardService = ReturnType<typeof createLeaderboardService>;

export interface ApiContext {
  db: SqlDatabase;
  redis?: Redis;
  /** Redis key prefix (tests use a unique one per suite). */
  ns: string;
  now: () => Date;
  log: Log;
  config: ApiConfig;
  secretBox: SecretBox;
  limiter: RateLimiter;
  mailer: Mailer;
  leaderboard: LeaderboardService;
  payments: PaymentsService;
  /** Set when turnstileSecret is configured; sign-up then requires a passing token. */
  verifyTurnstile: TurnstileVerifier | null;
  /** Signs one-click unsubscribe tokens (PRD-008 §6); derived from the TOTP key, never stored. */
  notifyKey: Buffer;
}

/** The all-zero UUID records system actions in security_audit_log (§6.8). */
export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
