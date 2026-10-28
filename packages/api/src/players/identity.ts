/**
 * Player identity — PRD-006 §7.5, PRD-001 §5.4
 *
 * MySportsFeeds sometimes lists one person under two IDs (2026-10-28: Brandon
 * Smith, WR PIT, as 30297 and 112299). Each ID would otherwise be a separate
 * player, so a manager could burn one and still play the other.
 *
 * One ID per person is kept (nfl_players.canonical_id IS NULL); every other
 * ID for that person is an alias pointing at it. Aliases never appear in the
 * player pool, the database refuses a lineup row that names one, burns follow
 * the person, and stats posted under an alias are scored under the kept ID.
 *
 * Same person =
 *   • same name and same birth date; or
 *   • same name, team and position where a birth date is missing, as long as
 *     no two of them have different birth dates (these go on a review list).
 * Different birth dates are never merged. The birth date is used here in
 * memory only and is never stored.
 */
import { audit } from '../auth/audit';
import type { ApiContext } from '../context';
import { conflict, notFound } from '../errors';
import type { SqlRunner } from '../sql';
import type { ParsedPlayer } from './msf-players';
import type { SessionInfo } from '../auth/sessions';

// ── matching (pure) ─────────────────────────────────────────────────────────

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

/** "Brian Thomas Jr." and "brian thomas" → "brian|thomas". Accents, punctuation and suffixes ignored. */
export function normalizeName(first: string, last: string): string {
  const clean = (s: string) =>
    s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z\s-]/g, '').split(/[\s-]+/).filter(Boolean);
  const lastParts = clean(last);
  while (lastParts.length > 1 && SUFFIXES.has(lastParts.at(-1)!)) lastParts.pop();
  return `${clean(first).join('')}|${lastParts.join('')}`;
}

export interface DuplicateGroup {
  ids: string[];
  /** Merged without a birth date match: an admin should confirm. */
  review: boolean;
}

/** Groups the feed's records that are the same person. Only groups of two or more are returned. */
export function duplicateGroups(players: ReadonlyArray<Pick<ParsedPlayer, 'msfPlayerId' | 'firstName' | 'lastName' | 'position' | 'team' | 'birthDate'>>): DuplicateGroup[] {
  const parent = new Map<string, string>();
  const dobs = new Map<string, Set<string>>(); // root → birth dates in the component
  const review = new Set<string>(); // roots joined without a birth date match
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string, viaReview: boolean): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    const merged = new Set([...dobs.get(ra)!, ...dobs.get(rb)!]);
    if (merged.size > 1) return; // two different birth dates: different people
    parent.set(rb, ra);
    dobs.set(ra, merged);
    if (viaReview || review.has(rb)) review.add(ra);
  };
  const byId = new Map(players.map((p) => [p.msfPlayerId, p]));
  for (const p of byId.values()) {
    parent.set(p.msfPlayerId, p.msfPlayerId);
    dobs.set(p.msfPlayerId, new Set(p.birthDate ? [p.birthDate] : []));
  }
  const bucket = (key: (p: ParsedPlayer | (typeof players)[number]) => string | null) => {
    const m = new Map<string, string[]>();
    for (const p of byId.values()) {
      const k = key(p);
      if (k) m.set(k, [...(m.get(k) ?? []), p.msfPlayerId]);
    }
    return [...m.values()].filter((ids) => ids.length > 1);
  };
  // 1. Same name and birth date.
  for (const ids of bucket((p) => (p.birthDate ? `${normalizeName(p.firstName, p.lastName)}|${p.birthDate}` : null))) {
    for (const id of ids.slice(1)) union(ids[0], id, false);
  }
  // 2. Same name, team and position, where a birth date is missing.
  for (const ids of bucket((p) => (p.team ? `${normalizeName(p.firstName, p.lastName)}|${p.team}|${p.position}` : null))) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = byId.get(ids[i])!;
        const b = byId.get(ids[j])!;
        if (!a.birthDate || !b.birthDate) union(a.msfPlayerId, b.msfPlayerId, true);
      }
    }
  }
  const groups = new Map<string, string[]>();
  for (const id of byId.keys()) {
    const r = find(id);
    groups.set(r, [...(groups.get(r) ?? []), id]);
  }
  return [...groups.entries()].filter(([, ids]) => ids.length > 1).map(([root, ids]) => ({ ids: ids.sort(compareIds), review: review.has(root) }));
}

/** Numeric MSF IDs in numeric order (older first); anything else as text. */
export function compareIds(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface IdentityRow {
  id: string;
  canonicalId: string | null;
  source: 'auto' | 'manual' | null;
  team: string | null;
  statLines: number;
}

/**
 * The ID to keep for a group: the one already kept (never moved
 * automatically), else one on a team (the one people can pick), else the one
 * with game stats, else the oldest.
 */
export function chooseCanonical(rows: IdentityRow[]): string {
  const ids = new Set(rows.map((r) => r.id));
  const kept = rows.find((r) => r.canonicalId === null && rows.some((o) => o.canonicalId === r.id));
  if (kept) return kept.id;
  const pointedAt = rows.map((r) => r.canonicalId).find((c): c is string => !!c && ids.has(c));
  if (pointedAt) return pointedAt;
  return [...rows].sort((a, b) => Number(!!b.team) - Number(!!a.team) || b.statLines - a.statLines || compareIds(a.id, b.id))[0].id;
}

// ── database ────────────────────────────────────────────────────────────────

export interface IdentityResult {
  groups: number;
  merged: number;
  review: number;
  repointed: number;
  voided: number;
}

/**
 * Applies the feed's duplicate groups (run after every roster sync). New
 * aliases are recorded; a kept ID never changes automatically; anything an
 * admin decided (identity_source = 'manual') is left alone.
 */
export async function resolveIdentities(ctx: ApiContext, players: ParsedPlayer[]): Promise<IdentityResult> {
  const groups = duplicateGroups(players);
  const result: IdentityResult = { groups: groups.length, merged: 0, review: 0, repointed: 0, voided: 0 };
  if (!groups.length) return result;
  const now = ctx.now();
  const newAliases: Array<{ alias: string; canonical: string }> = [];
  await ctx.db.transaction(async (tx) => {
    const all = groups.flatMap((g) => g.ids);
    const rows = await tx.query<{ id: string; canonical_id: string | null; identity_source: 'auto' | 'manual' | null; team: string | null; stat_lines: number }>(
      `SELECT p.msf_player_id AS id, p.canonical_id, p.identity_source, p.team,
              (SELECT count(*)::int FROM player_game_stats s WHERE s.player_id = p.msf_player_id) AS stat_lines
         FROM nfl_players p WHERE p.msf_player_id = ANY ($1::text[]) FOR UPDATE`,
      [all]
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const g of groups) {
      const members = g.ids
        .map((id) => byId.get(id))
        .filter((r): r is NonNullable<typeof r> => !!r && r.identity_source !== 'manual')
        // An alias of someone outside this group stays as it is.
        .filter((r) => !r.canonical_id || g.ids.includes(r.canonical_id));
      if (members.length < 2) continue;
      const keep = chooseCanonical(members.map((r) => ({ id: r.id, canonicalId: r.canonical_id, source: r.identity_source, team: r.team, statLines: r.stat_lines })));
      for (const m of members) {
        if (m.id === keep || m.canonical_id === keep) continue;
        // Anything already pointing at m moves to the kept ID first (no chains).
        await tx.query(`UPDATE nfl_players SET canonical_id = $2, updated_at = $3 WHERE canonical_id = $1`, [m.id, keep, now]);
        await tx.query(
          `UPDATE nfl_players SET canonical_id = $2, identity_source = 'auto', identity_review = $3, updated_at = $4 WHERE msf_player_id = $1`,
          [m.id, keep, g.review, now]
        );
        await audit(tx, { event: 'PLAYER_MERGED', at: now, metadata: { alias: m.id, canonical: keep, review: g.review, source: 'roster_sync' } });
        newAliases.push({ alias: m.id, canonical: keep });
        result.merged++;
        if (g.review) result.review++;
      }
    }
  });
  for (const a of newAliases) {
    const r = await moveSubmissions(ctx, a.alias, a.canonical);
    result.repointed += r.repointed;
    result.voided += r.voided;
  }
  if (result.merged) ctx.log('warn', 'player IDs merged', { ...result, aliases: newAliases });
  return result;
}

/**
 * Open picks on an alias move to the kept ID. If the manager already has
 * that person in another slot the same week, the alias pick is voided
 * (PLAYER_MERGED): one person, one slot. Locked picks are never touched.
 */
export async function moveSubmissions(ctx: ApiContext, alias: string, canonical: string): Promise<{ repointed: number; voided: number }> {
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const subs = await tx.query<{ id: string; user_id: string; season: string; week: number; slot_key: string }>(
      `SELECT id::text AS id, user_id::text AS user_id, season, week, slot_key FROM season_submissions
        WHERE player_id = $1 AND locked_at IS NULL AND void_reason IS NULL FOR UPDATE`,
      [alias]
    );
    let repointed = 0;
    let voided = 0;
    for (const s of subs) {
      const [dup] = await tx.query<{ slot_key: string }>(
        `SELECT slot_key FROM season_submissions WHERE user_id = $1::uuid AND season = $2 AND week = $3 AND player_id = $4 AND void_reason IS NULL`,
        [s.user_id, s.season, s.week, canonical]
      );
      if (dup) {
        await tx.query(`UPDATE season_submissions SET void_reason = 'PLAYER_MERGED' WHERE id = $1::uuid`, [s.id]);
        await audit(tx, { event: 'SUBMISSION_VOIDED', userId: s.user_id, at: now, slotKey: s.slot_key, metadata: { submissionId: s.id, playerId: alias, canonical, reason: 'PLAYER_MERGED', alsoIn: dup.slot_key } });
        const [p] = await tx.query<{ name: string }>(`SELECT first_name || ' ' || last_name AS name FROM nfl_players WHERE msf_player_id = $1`, [canonical]);
        await tx.query(`INSERT INTO notification_queue (user_id, kind, payload) VALUES ($1, 'SUBMISSION_VOIDED', $2::jsonb)`, [
          s.user_id, JSON.stringify({ season: s.season, week: s.week, slot: s.slot_key, playerId: alias, playerName: p?.name, reason: 'PLAYER_MERGED', alsoIn: dup.slot_key }),
        ]);
        voided++;
      } else {
        await tx.query(`UPDATE season_submissions SET player_id = $2 WHERE id = $1::uuid`, [s.id, canonical]);
        await audit(tx, { event: 'SUBMISSION_REPOINTED', userId: s.user_id, at: now, slotKey: s.slot_key, metadata: { submissionId: s.id, fromPlayer: alias, toPlayer: canonical, reason: 'PLAYER_MERGED' } });
        repointed++;
      }
    }
    return { repointed, voided };
  });
}

/** alias → kept ID, for the scoring job. */
export async function aliasMap(q: SqlRunner): Promise<Map<string, string>> {
  const rows = await q.query<{ id: string; canonical_id: string }>(`SELECT msf_player_id AS id, canonical_id FROM nfl_players WHERE canonical_id IS NOT NULL`);
  return new Map(rows.map((r) => [r.id, r.canonical_id]));
}

/**
 * Stats posted under an alias are scored under the kept ID. If the feed has
 * a line for both IDs in the same game, the kept ID's own line wins.
 */
export function normalizeStatLines<T extends { msfGameId: string; playerId: string }>(lines: T[], aliases: ReadonlyMap<string, string>): T[] {
  const out = new Map<string, T>();
  for (const line of lines) {
    const canonical = aliases.get(line.playerId);
    const mapped = canonical ? { ...line, playerId: canonical } : line;
    const key = `${line.msfGameId}|${mapped.playerId}`;
    if (!out.has(key) || !canonical) out.set(key, mapped);
  }
  return [...out.values()];
}

// ── admin (PRD-006 §7.5) ────────────────────────────────────────────────────

export async function listIdentities(ctx: ApiContext) {
  const rows = await ctx.db.query<{ id: string; name: string; position: string; team: string | null; canonical_id: string | null; identity_source: string | null; identity_review: boolean }>(
    `SELECT p.msf_player_id AS id, p.first_name || ' ' || p.last_name AS name, p.position, p.team, p.canonical_id, p.identity_source, p.identity_review
       FROM nfl_players p
      WHERE p.canonical_id IS NOT NULL OR p.identity_source IS NOT NULL
         OR EXISTS (SELECT 1 FROM nfl_players a WHERE a.canonical_id = p.msf_player_id)
      ORDER BY p.last_name, p.first_name, p.msf_player_id`
  );
  const view = (r: (typeof rows)[number]) => ({ id: r.id, name: r.name, position: r.position, team: r.team, source: r.identity_source, review: r.identity_review });
  const kept = rows.filter((r) => r.canonical_id === null);
  return {
    groups: kept
      .map((k) => ({ player: view(k), aliases: rows.filter((r) => r.canonical_id === k.id).map(view) }))
      .filter((g) => g.aliases.length > 0 || g.player.source === 'manual'),
    needsReview: rows.filter((r) => r.identity_review).length,
  };
}

/**
 * An admin decision, which the roster sync then leaves alone:
 *   canonicalId = an ID  → playerId is another ID for that person;
 *   canonicalId = null   → playerId is a separate person (split).
 */
export async function setIdentity(ctx: ApiContext, admin: SessionInfo, playerId: string, canonicalId: string | null, reason: string) {
  const now = ctx.now();
  await ctx.db.transaction(async (tx) => {
    const ids = canonicalId ? [playerId, canonicalId] : [playerId];
    const rows = await tx.query<{ id: string; canonical_id: string | null }>(
      `SELECT msf_player_id AS id, canonical_id FROM nfl_players WHERE msf_player_id = ANY ($1::text[]) FOR UPDATE`,
      [ids]
    );
    const me = rows.find((r) => r.id === playerId);
    if (!me) throw notFound('No such player');
    if (canonicalId) {
      const target = rows.find((r) => r.id === canonicalId);
      if (!target) throw notFound('No such player');
      if (canonicalId === playerId) throw conflict('IDENTITY_SELF', 'A player cannot be an alias of himself');
      if (target.canonical_id) throw conflict('IDENTITY_CHAIN', `${canonicalId} is itself an alias of ${target.canonical_id}`);
      // Anything pointing at playerId follows it to the kept ID.
      await tx.query(`UPDATE nfl_players SET canonical_id = $2, identity_source = 'manual', identity_review = false, updated_at = $3 WHERE canonical_id = $1`, [playerId, canonicalId, now]);
      await tx.query(`UPDATE nfl_players SET canonical_id = $2, identity_source = 'manual', identity_review = false, updated_at = $3 WHERE msf_player_id = $1`, [playerId, canonicalId, now]);
      await tx.query(`UPDATE nfl_players SET identity_source = 'manual', identity_review = false, updated_at = $2 WHERE msf_player_id = $1`, [canonicalId, now]);
    } else {
      const [{ n }] = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM nfl_players WHERE canonical_id = $1`, [playerId]);
      if (n > 0) throw conflict('IDENTITY_HAS_ALIASES', 'Split its aliases instead: this ID is the one kept for them');
      await tx.query(`UPDATE nfl_players SET canonical_id = NULL, identity_source = 'manual', identity_review = false, updated_at = $2 WHERE msf_player_id = $1`, [playerId, now]);
    }
    await audit(tx, { event: 'ADMIN_ACTION', performedBy: admin.userId, at: now, metadata: { action: canonicalId ? 'PLAYER_MERGED' : 'PLAYER_SPLIT', playerId, canonicalId, reason } });
  });
  const moved = canonicalId ? await moveSubmissions(ctx, playerId, canonicalId) : { repointed: 0, voided: 0 };
  return { playerId, canonicalId, ...moved };
}
