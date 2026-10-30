/** API error codes in plain words, with what to do next (PRD-007 §9). */
import { ApiError, NetworkError } from '../api/client';
import type { ValidationIssue } from '../api/types';
import { SLOT_LABEL } from './slots';

const MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: 'That email and password don’t match.',
  RATE_LIMITED: 'Too many tries. Wait a few minutes and try again.',
  WEAK_PASSWORD: 'Use a password of 12 to 128 characters.',
  HANDLE_TAKEN: 'That handle is taken. Try another.',
  HANDLE_FORMAT: 'Handles are 3–20 letters, numbers or underscores.',
  HANDLE_BLOCKED: 'That handle isn’t allowed. Try another.',
  HANDLE_RESERVED: 'That handle is reserved. Try another.',
  HANDLE_RESERVED_WORD: 'That handle isn’t allowed. Try another.',
  HANDLE_CHANGE_LIMIT: 'You’ve used both handle changes for this season.',
  INVITE_INVALID: 'That invite code isn’t valid. Check it, or ask for a new one. Each code works once.',
  TURNSTILE_FAILED: 'We couldn’t confirm you’re human. Complete the check and try again.',
  INVALID_CODE: 'That code didn’t work. Codes change every 30 seconds; use the current one.',
  MFA_NOT_PENDING: 'Your sign-in timed out. Start again.',
  NO_PENDING_FACTOR: 'Start the authenticator setup again.',
  TOKEN_INVALID: 'That link is invalid or has expired. Ask for a new one.',
  EMAIL_UNVERIFIED: 'Verify your email first: check your inbox for the link.',
  MFA_ENROLLMENT_REQUIRED: 'Set up your authenticator to continue.',
  STEP_UP_REQUIRED: 'Confirm with a code from your authenticator.',
  WEEK_CLOSED: 'Every game window this week has locked. The next week opens once this week’s last game is final.',
  WEEK_NOT_OPEN: 'That week isn’t open yet. It opens once this week’s last game is final.',
  PAID_ENTRY_REQUIRED: 'Lineups are closed for the rest of this season.',
  LINEUP_EMPTY: 'Pick at least one player to confirm a lineup.',
  SEASON_CLOSED: 'Lineups are only open for the current season.',
  CONFIRMATION_EXPIRED: 'Your review expired. Review your lineup again.',
  GATE_ORDER: 'This confirmation is out of date. Review your lineup again.',
  ACKNOWLEDGEMENT_REQUIRED: 'Tick all three boxes to continue.',
  CSRF: 'Your browser blocked that request. Reload the page and try again.',
  UNAUTHENTICATED: 'You’ve been signed out. Sign in again.',
  INTERNAL: 'Something went wrong on our side. Try again in a moment.',
};

const ISSUE_TEXT: Record<string, string> = {
  SLOT_LOCKED: 'has locked and can’t change',
  GAME_WINDOW_LOCKED: 'locked before you confirmed',
  PLAYER_BURNED_OR_UNAVAILABLE: 'is burned or not available',
  PLAYER_NOT_FOUND: 'isn’t on a current roster',
  PLAYER_INACTIVE: 'is listed Out or IR',
  PLAYER_ON_BYE: 'has no game this week',
  POSITION_INELIGIBLE: 'can’t play that slot',
  DUPLICATE_PLAYER: 'is already in another slot',
};

export function issueText(i: ValidationIssue): string {
  const slot = i.slot ? SLOT_LABEL[i.slot] : 'A slot';
  const what = ISSUE_TEXT[i.code];
  return what ? `${slot}: this player ${what}.` : `${slot}: ${i.message}`;
}

export function issuesOf(err: unknown): ValidationIssue[] {
  if (err instanceof ApiError && err.code === 'LINEUP_INVALID' && Array.isArray(err.body?.errors)) {
    return err.body.errors as ValidationIssue[];
  }
  return [];
}

export function errorText(err: unknown): string {
  if (err instanceof NetworkError) return 'Can’t reach Burnout League. Check your connection and try again.';
  if (err instanceof ApiError) {
    const issues = issuesOf(err);
    if (issues.length) return issues.map(issueText).join(' ');
    if (err.code === 'VALIDATION') return 'Check the form and try again.';
    return MESSAGES[err.code] ?? err.message;
  }
  return 'Something went wrong. Try again.';
}

export const isNotFound = (err: unknown): boolean => err instanceof ApiError && err.status === 404;
