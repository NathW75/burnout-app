/**
 * Handle rules — PRD-003 §7. Format and reserved words are checked here;
 * the change limit (2 per season) and the 30-day reservation are enforced by
 * the database (leaderboard guards migration), so no code path can skip them.
 */

export const HANDLE_PATTERN = /^[A-Za-z0-9_]{3,20}$/;

/** Words a handle may not contain (case-insensitive substring match). */
export const RESERVED_HANDLE_WORDS: ReadonlyArray<string> = ['burnout', 'admin', 'official', 'support', 'corewright', 'moderator', 'staff'];

export class HandleError extends Error {
  constructor(readonly code: 'HANDLE_FORMAT' | 'HANDLE_RESERVED_WORD' | 'HANDLE_BLOCKED' | 'HANDLE_TAKEN' | 'HANDLE_CHANGE_LIMIT', message: string) {
    super(message);
    this.name = 'HandleError';
  }
}

/**
 * @param blocklist profanity / impersonation list supplied by the caller
 *        (maintained outside the codebase; open item before launch).
 */
export function validateHandle(handle: string, blocklist: ReadonlyArray<string> = []): void {
  if (!HANDLE_PATTERN.test(handle)) {
    throw new HandleError('HANDLE_FORMAT', 'Handles are 3–20 characters: letters, numbers and underscores.');
  }
  const lower = handle.toLowerCase();
  if (RESERVED_HANDLE_WORDS.some((w) => lower.includes(w))) {
    throw new HandleError('HANDLE_RESERVED_WORD', 'That handle uses a reserved word.');
  }
  if (blocklist.some((w) => w && lower.includes(w.toLowerCase()))) {
    throw new HandleError('HANDLE_BLOCKED', 'That handle is not allowed.');
  }
}
