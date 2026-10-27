/**
 * Three-gate lineup submission — PRD-006 §9, PRD-001 §9
 *
 * Gate 1 review → Gate 2 acknowledge → Gate 3 confirm. Server timestamps are
 * the evidence. Confirm writes the week's submissions and an append-only
 * receipt in one transaction, holding a share lock on every game window it
 * touches so it serializes with the lock job.
 */
import { createHash } from 'node:crypto';
import { validateLineupDraft, type NFLPosition, type SlotKey, type SubmissionValidatorDependencies, type ValidationError } from '@burnout/burn-engine';
import { audit } from '../auth/audit';
import type { SessionInfo } from '../auth/sessions';
import type { ApiContext } from '../context';
import { conflict, HttpError, notFound } from '../errors';
import { availablePlayerIds } from '../players/pool';
import { playerWindow } from '../players/roster';
import type { SqlRunner } from '../sql';

export const SLOT_ORDER: SlotKey[] = ['qb', 'rb1', 'rb2', 'wr1', 'wr2', 'wr3', 'te', 'flex', 'k'];
export type Slots = Partial<Record<SlotKey, string | null>>;

export class LineupInvalidError extends HttpError {
  constructor(readonly errors: ValidationError[]) {
    super(422, 'LINEUP_INVALID', 'The lineup has problems', { errors });
  }
}

interface CurrentRow {
  id: string;
  slot_key: SlotKey;
  player_id: string;
  game_window_id: string;
  locked_at: Date | null;
  void_reason: string | null;
  scheduled_et: Date;
  window_status: string;
}

/** A slot is frozen once its submission locked, or its window's scheduled_et has passed (lock job may lag ≤1 min). */
const frozen = (r: CurrentRow, now: Date) => r.void_reason === null && (r.locked_at !== null || new Date(r.scheduled_et) <= now || r.window_status !== 'pending');

async function currentRows(q: SqlRunner, userId: string, season: string, week: number, lock = false): Promise<Map<SlotKey, CurrentRow>> {
  const rows = await q.query<CurrentRow>(
    `SELECT s.id::text AS id, s.slot_key, s.player_id, s.game_window_id::text AS game_window_id, s.locked_at, s.void_reason,
            w.scheduled_et, w.status AS window_status
       FROM season_submissions s JOIN game_windows w ON w.id = s.game_window_id
      WHERE s.user_id = $1::uuid AND s.season = $2 AND s.week = $3 ${lock ? 'FOR UPDATE OF s' : ''}`,
    [userId, season, week]
  );
  return new Map(rows.map((r) => [r.slot_key, r]));
}

function validatorDeps(q: SqlRunner, now: Date): SubmissionValidatorDependencies {
  return {
    getUserAvailablePool: (userId, season) => availablePlayerIds(q, userId, season),
    async getPlayerPosition(playerId) {
      const [p] = await q.query<{ position: string }>(`SELECT position FROM nfl_players WHERE msf_player_id = $1`, [playerId]);
      return (p?.position as NFLPosition) ?? null;
    },
    getPlayerGameWindowId: (playerId, week, season) => playerWindow(q, playerId, season, week),
    async getGameWindowStatus(id) {
      const [w] = await q.query<{ status: string; scheduled_et: Date }>(`SELECT status, scheduled_et FROM game_windows WHERE id = $1::uuid`, [id]);
      if (!w) return null;
      return w.status === 'pending' && new Date(w.scheduled_et) <= now ? 'locked' : w.status; // D9: scheduled_et, not the lock job
    },
  };
}

/**
 * Merges the requested slots with the frozen ones and validates the rest.
 * Returns the full 9-slot map and which slots are frozen.
 */
async function mergeAndValidate(q: SqlRunner, userId: string, season: string, week: number, requested: Slots, now: Date, lockRows = false) {
  const current = await currentRows(q, userId, season, week, lockRows);
  const merged: Record<SlotKey, string | null> = Object.fromEntries(SLOT_ORDER.map((s) => [s, null])) as Record<SlotKey, string | null>;
  const fixed: Partial<Record<SlotKey, string>> = {};
  const errors: ValidationError[] = [];
  for (const slot of SLOT_ORDER) {
    const row = current.get(slot);
    const want = requested[slot] ?? null;
    if (row && frozen(row, now)) {
      if (want !== null && want !== row.player_id) errors.push({ code: 'SLOT_LOCKED', message: `Slot ${slot} is locked`, slot, playerId: want });
      merged[slot] = row.player_id;
      fixed[slot] = row.player_id;
    } else {
      merged[slot] = want;
    }
  }
  if (errors.length) throw new LineupInvalidError(errors);

  const draftSlots = Object.fromEntries(SLOT_ORDER.filter((s) => merged[s] !== null).map((s) => [s, merged[s]])) as Partial<Record<SlotKey, string>>;
  const result = await validateLineupDraft(
    { userId, season, week, slots: draftSlots, savedAt: now, expiresAt: now },
    validatorDeps(q, now),
    { fixedSlots: fixed }
  );
  if (!result.valid) throw new LineupInvalidError(result.errors);
  return { merged, fixed, current };
}

async function describeSlots(q: SqlRunner, season: string, week: number, merged: Record<SlotKey, string | null>, fixed: Partial<Record<SlotKey, string>>) {
  const ids = SLOT_ORDER.map((s) => merged[s]).filter((p): p is string => !!p);
  const rows = await q.query<{ id: string; name: string; team: string | null; position: string; opponent: string | null; scheduled_et: Date | null; window_id: string | null }>(
    `SELECT p.msf_player_id AS id, p.first_name || ' ' || p.last_name AS name, p.team, p.position,
            CASE WHEN p.team = g.home_team THEN g.away_team ELSE g.home_team END AS opponent, w.scheduled_et, w.id::text AS window_id
       FROM nfl_players p
       LEFT JOIN nfl_games g ON g.season = $2 AND g.week = $3 AND p.team IN (g.home_team, g.away_team)
       LEFT JOIN game_windows w ON w.id = g.game_window_id
      WHERE p.msf_player_id = ANY ($1::text[])`,
    [ids, season, week]
  );
  const by = new Map(rows.map((r) => [r.id, r]));
  return SLOT_ORDER.map((slot) => {
    const id = merged[slot];
    const r = id ? by.get(id) : undefined;
    return {
      slot, playerId: id, name: r?.name ?? null, team: r?.team ?? null, position: r?.position ?? null,
      opponent: r?.opponent ?? null, scheduledEt: r?.scheduled_et ? new Date(r.scheduled_et).toISOString() : null,
      locked: Object.prototype.hasOwnProperty.call(fixed, slot),
    };
  });
}

function assertSeasonWeek(ctx: ApiContext, season: string, week: number): void {
  if (season !== ctx.config.currentSeason) throw new HttpError(400, 'SEASON_CLOSED', `Lineups are open for ${ctx.config.currentSeason} only`);
  if (!Number.isInteger(week) || week < 1 || week > 18) throw new HttpError(400, 'VALIDATION', 'week must be 1–18');
}

// ── reads ───────────────────────────────────────────────────────────────────

export async function getLineup(ctx: ApiContext, userId: string, season: string, week: number) {
  const now = ctx.now();
  const current = await currentRows(ctx.db, userId, season, week);
  const merged = Object.fromEntries(SLOT_ORDER.map((s) => [s, current.get(s)?.player_id ?? null])) as Record<SlotKey, string | null>;
  const fixed = Object.fromEntries([...current.values()].filter((r) => frozen(r, now)).map((r) => [r.slot_key, r.player_id]));
  const slots = await describeSlots(ctx.db, season, week, merged, fixed);
  return {
    season, week,
    slots: slots.map((s) => {
      const row = current.get(s.slot);
      return { ...s, voidReason: row?.void_reason ?? null, lockedAt: row?.locked_at ?? null };
    }),
  };
}

// ── Gate 1 ──────────────────────────────────────────────────────────────────

export async function review(ctx: ApiContext, s: SessionInfo, season: string, week: number, slots: Slots, client: { ip: string; userAgent: string }) {
  assertSeasonWeek(ctx, season, week);
  const now = ctx.now();
  const [open] = await ctx.db.query<{ open: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM game_windows WHERE season = $1 AND week = $2 AND status = 'pending' AND scheduled_et > $3) AS open`,
    [season, week, now]
  );
  if (!open.open) throw conflict('WEEK_CLOSED', 'Every game window this week has locked');
  const { merged, fixed } = await mergeAndValidate(ctx.db, s.userId, season, week, slots, now);
  const expiresAt = new Date(now.getTime() + ctx.config.confirmationTtlMs);
  const [c] = await ctx.db.query<{ id: string }>(
    `INSERT INTO lineup_confirmations (user_id, season, week, slots, status, gate1_at, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4::jsonb, 'reviewed', $5, $6, $7, $8) RETURNING id::text AS id`,
    [s.userId, season, week, JSON.stringify(merged), now, expiresAt, client.ip.slice(0, 45), client.userAgent.slice(0, 500)]
  );
  return { confirmationId: c.id, gate1At: now.toISOString(), expiresAt: expiresAt.toISOString(), slots: await describeSlots(ctx.db, season, week, merged, fixed) };
}

// ── Gate 2 ──────────────────────────────────────────────────────────────────

interface ConfirmationRow {
  id: string; user_id: string; season: string; week: number; slots: Record<SlotKey, string | null>;
  status: string; gate1_at: Date; gate2_at: Date | null; expires_at: Date; ip_address: string; user_agent: string;
}

async function loadConfirmation(q: SqlRunner, userId: string, id: string, lock: boolean): Promise<ConfirmationRow> {
  const [c] = await q.query<ConfirmationRow>(
    `SELECT id::text AS id, user_id::text AS user_id, season, week, slots, status, gate1_at, gate2_at, expires_at, ip_address, user_agent
       FROM lineup_confirmations WHERE id = $1::uuid AND user_id = $2::uuid ${lock ? 'FOR UPDATE' : ''}`,
    [id, userId]
  );
  if (!c) throw notFound('No such confirmation');
  return c;
}

export async function acknowledge(ctx: ApiContext, s: SessionInfo, id: string, acks: { burnRules: boolean; permanent: boolean; noRefund: boolean }) {
  if (acks.burnRules !== true || acks.permanent !== true || acks.noRefund !== true) {
    throw new HttpError(400, 'ACKNOWLEDGEMENT_REQUIRED', 'All three acknowledgements are required');
  }
  return ctx.db.transaction(async (tx) => {
    const c = await loadConfirmation(tx, s.userId, id, true);
    const now = ctx.now();
    if (c.status !== 'reviewed') throw conflict('GATE_ORDER', `This confirmation is already ${c.status}`);
    if (now > new Date(c.expires_at)) throw conflict('CONFIRMATION_EXPIRED', 'Review the lineup again');
    await tx.query(`UPDATE lineup_confirmations SET status = 'acknowledged', gate2_at = $2 WHERE id = $1::uuid`, [id, now]);
    return { confirmationId: id, gate2At: now.toISOString() };
  });
}

// ── Gate 3 ──────────────────────────────────────────────────────────────────

export function lineupChecksum(x: { userId: string; season: string; week: number; gate3At: Date; slots: Array<{ slot: SlotKey; playerId: string | null; gameWindowId: string | null; locked: boolean }> }): string {
  const canonical = JSON.stringify({
    userId: x.userId, season: x.season, week: x.week, gate3At: x.gate3At.toISOString(),
    slots: SLOT_ORDER.map((slot) => {
      const s = x.slots.find((y) => y.slot === slot)!;
      return { slot, playerId: s.playerId, gameWindowId: s.gameWindowId, locked: s.locked };
    }),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export async function confirm(ctx: ApiContext, s: SessionInfo, id: string) {
  const out = await ctx.db.transaction(async (tx) => {
    const c = await loadConfirmation(tx, s.userId, id, true);
    const now = ctx.now();
    if (c.status !== 'acknowledged') throw conflict('GATE_ORDER', c.status === 'confirmed' ? 'Already confirmed' : 'Acknowledge the rules first');
    if (now > new Date(c.expires_at)) throw conflict('CONFIRMATION_EXPIRED', 'Review the lineup again');

    // Revalidate at Gate 3 time, with the user's submissions locked for update.
    const { merged, fixed, current } = await mergeAndValidate(tx, s.userId, c.season, c.week, c.slots, now, true);

    // Resolve each changed slot's window and share-lock every window involved (old and new).
    const changes: Array<{ slot: SlotKey; playerId: string; windowId: string; row?: CurrentRow }> = [];
    for (const slot of SLOT_ORDER) {
      if (Object.prototype.hasOwnProperty.call(fixed, slot)) continue;
      const playerId = merged[slot]!;
      const row = current.get(slot);
      const windowId = (await playerWindow(tx, playerId, c.season, c.week))!;
      if (row && row.player_id === playerId && row.game_window_id === windowId && row.void_reason === null) continue; // unchanged
      changes.push({ slot, playerId, windowId, row });
    }
    const windowIds = [...new Set(changes.flatMap((ch) => [ch.windowId, ch.row?.game_window_id].filter((w): w is string => !!w)))];
    if (windowIds.length) {
      const ws = await tx.query<{ id: string; status: string; scheduled_et: Date }>(
        `SELECT id::text AS id, status, scheduled_et FROM game_windows WHERE id = ANY ($1::uuid[]) ORDER BY id FOR SHARE`,
        [windowIds]
      );
      const closed = ws.filter((w) => w.status !== 'pending' || new Date(w.scheduled_et) <= now);
      const touched = changes.filter((ch) => closed.some((w) => w.id === ch.windowId || (ch.row && ch.row.void_reason === null && w.id === ch.row.game_window_id)));
      if (touched.length) {
        throw new LineupInvalidError(touched.map((ch) => ({ code: 'GAME_WINDOW_LOCKED', message: `Slot ${ch.slot} locked before confirmation`, slot: ch.slot, playerId: ch.playerId })));
      }
    }

    const windowFor = new Map(changes.map((ch) => [ch.slot, ch.windowId]));
    const snapshot = SLOT_ORDER.map((slot) => ({
      slot,
      playerId: merged[slot],
      gameWindowId: windowFor.get(slot) ?? current.get(slot)?.game_window_id ?? null,
      locked: Object.prototype.hasOwnProperty.call(fixed, slot),
    }));
    const sha = lineupChecksum({ userId: s.userId, season: c.season, week: c.week, gate3At: now, slots: snapshot });

    const [receipt] = await tx.query<{ id: string }>(
      `INSERT INTO submission_receipts (user_id, week, season, lineup_snapshot, gate1_at, gate2_at, gate3_at, ip_address, user_agent, submission_id, lineup_sha256)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11) RETURNING id::text AS id`,
      [s.userId, c.week, c.season, JSON.stringify(snapshot), c.gate1_at, c.gate2_at, now, c.ip_address, c.user_agent, c.id, sha]
    );
    for (const ch of changes) {
      if (ch.row) {
        await tx.query(
          `UPDATE season_submissions SET player_id = $2, game_window_id = $3::uuid, submitted_at = $4, void_reason = NULL, receipt_id = $5::uuid
            WHERE id = $1::uuid AND locked_at IS NULL`,
          [ch.row.id, ch.playerId, ch.windowId, now, receipt.id]
        );
      } else {
        await tx.query(
          `INSERT INTO season_submissions (user_id, week, season, slot_key, player_id, game_window_id, submitted_at, receipt_id)
           VALUES ($1, $2, $3, $4, $5, $6::uuid, $7, $8::uuid)`,
          [s.userId, c.week, c.season, ch.slot, ch.playerId, ch.windowId, now, receipt.id]
        );
      }
    }
    if (changes.length) {
      await tx.query(
        `INSERT INTO pool_entries (user_id, player_id, season) SELECT $1::uuid, p, $2 FROM unnest($3::text[]) AS p
         ON CONFLICT (user_id, player_id, season) DO NOTHING`,
        [s.userId, c.season, changes.map((ch) => ch.playerId)]
      );
    }
    await tx.query(`UPDATE lineup_confirmations SET status = 'confirmed', gate3_at = $2 WHERE id = $1::uuid`, [id, now]);
    await audit(tx, { event: 'LINEUP_CONFIRMED', userId: s.userId, at: now, metadata: { receiptId: receipt.id, season: c.season, week: c.week, changed: changes.map((ch) => ch.slot), sha256: sha } });
    await tx.query(`INSERT INTO notification_queue (user_id, kind, payload) VALUES ($1, 'LINEUP_RECEIPT', $2::jsonb)`, [
      s.userId, JSON.stringify({ receiptId: receipt.id, season: c.season, week: c.week, sha256: sha, gate3At: now.toISOString(), slots: snapshot }),
    ]);
    return { receiptId: receipt.id, gate3At: now.toISOString(), sha256: sha, changedSlots: changes.map((ch) => ch.slot), slots: snapshot };
  });
  return out;
}

export async function getReceipt(ctx: ApiContext, userId: string, id: string) {
  const [r] = await ctx.db.query<Record<string, unknown>>(
    `SELECT id::text AS id, season, week, lineup_snapshot AS slots, gate1_at, gate2_at, gate3_at, lineup_sha256 AS sha256, submission_id::text AS confirmation_id
       FROM submission_receipts WHERE id = $1::uuid AND user_id = $2::uuid`,
    [id, userId]
  );
  if (!r) throw notFound('No such receipt');
  return r;
}
