/**
 * Which notices go by email, how, and by default (PRD-008 §4).
 */
export type PreferenceGroup = 'locks_burns' | 'lineup_changes' | 'receipts';

export interface EmailKind {
  /** The Account → Notifications switch that controls it; null = not configurable. */
  group: PreferenceGroup | null;
  /** Sent when the user has no stored choice. */
  default: boolean;
  /** Skips the grouping wait: the player may still need to act. */
  immediate: boolean;
  /** Transactional: sent even after "email me nothing optional". */
  required: boolean;
  /** Older than this when first seen = not sent. */
  staleHours: number;
}

const optional = (group: PreferenceGroup | null, def: boolean, immediate = false): EmailKind => ({ group, default: def, immediate, required: false, staleHours: 6 });
const required: EmailKind = { group: null, default: true, immediate: false, required: true, staleHours: 24 };

export const EMAIL_KINDS: Readonly<Record<string, EmailKind>> = {
  SUBMISSION_VOIDED: optional('lineup_changes', true, true),
  SUBMISSION_REPOINTED: optional('lineup_changes', true, true),
  SLOT_REOPENED: optional('lineup_changes', true, true),
  LOCK: optional('locks_burns', true),
  BURN: optional('locks_burns', true),
  LINEUP_RECEIPT: optional('receipts', true),
  SCORE_CORRECTION: optional(null, false), // in-app only until the weekly recap (PRD-008 §3)
  ENTRY_RECEIPT: required,
  REFUND: required,
  POOL_CANCELLED: required,
  PAYOUT_BLOCKED: required,
  PAYOUT_SENT: required,
  PAYOUT_FAILED: required,
};

export const GROUP_KINDS: Readonly<Record<PreferenceGroup, readonly string[]>> = {
  locks_burns: ['LOCK', 'BURN'],
  lineup_changes: ['SUBMISSION_VOIDED', 'SUBMISSION_REPOINTED', 'SLOT_REOPENED'],
  receipts: ['LINEUP_RECEIPT'],
};

export const IMMEDIATE_KINDS = Object.entries(EMAIL_KINDS).filter(([, k]) => k.immediate).map(([kind]) => kind);
