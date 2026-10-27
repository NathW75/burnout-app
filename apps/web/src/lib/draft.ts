/**
 * The lineup draft (PRD-007 §6.3): unconfirmed changes, saved per week in
 * browser storage as a convenience only. The server always wins: a slot it
 * reports as locked drops out of the draft, and so does a draft value that
 * the server has since voided.
 */
import type { Lineup, SlotKey, Slots } from '../api/types';
import { SLOT_ORDER } from './slots';

/** Only the slots the user changed. null = cleared (empty). */
export type Draft = Partial<Record<SlotKey, string | null>>;

const key = (userId: string, season: string, week: number) => `bl:draft:${userId}:${season}:${week}`;

export function loadDraft(userId: string, season: string, week: number): Draft {
  try {
    const raw = window.localStorage.getItem(key(userId, season, week));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Draft = {};
    for (const slot of SLOT_ORDER) {
      const v = (parsed as Record<string, unknown>)[slot];
      if (v === null || (typeof v === 'string' && v.length > 0 && v.length <= 50)) out[slot] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveDraft(userId: string, season: string, week: number, draft: Draft): void {
  try {
    if (Object.keys(draft).length === 0) window.localStorage.removeItem(key(userId, season, week));
    else window.localStorage.setItem(key(userId, season, week), JSON.stringify(draft));
  } catch {
    /* storage unavailable: the draft lives in memory only */
  }
}

export function clearDraft(userId: string, season: string, week: number): void {
  saveDraft(userId, season, week, {});
}

/**
 * Reconciles a draft with the server's lineup:
 * - locked slots can't change: their draft entries go;
 * - a draft value equal to the server's value is no change;
 * - a draft value equal to a player the server voided is dropped (he was
 *   voided after the draft was made, so the slot is open again).
 */
export function reconcile(draft: Draft, lineup: Lineup): Draft {
  const out: Draft = {};
  for (const s of lineup.slots) {
    if (!(s.slot in draft)) continue;
    const want = draft[s.slot] ?? null;
    if (s.locked && s.voidReason === null) continue;
    if (s.voidReason !== null && want === s.playerId) continue;
    const serverValue = s.voidReason !== null ? null : s.playerId;
    if (want === serverValue) continue;
    out[s.slot] = want;
  }
  return out;
}

/** The lineup to submit: the server's slots with the draft on top. Voided slots count as empty. */
export function effectiveSlots(lineup: Lineup, draft: Draft): Slots {
  const out = Object.fromEntries(SLOT_ORDER.map((s) => [s, null])) as Slots;
  for (const s of lineup.slots) out[s.slot] = s.voidReason !== null ? null : s.playerId;
  for (const slot of SLOT_ORDER) if (slot in draft) out[slot] = draft[slot] ?? null;
  return out;
}

export const changeCount = (draft: Draft) => Object.keys(draft).length;
