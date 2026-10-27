/**
 * Leaderboard cache — PRD-003 §5 (v1.2)
 *
 * Stores a copy of the board exactly as Postgres ranked it:
 *   {ns}lb:{poolId}:order  LIST  entry IDs in display order
 *   {ns}lb:{poolId}:rows   HASH  entryId → row JSON (rank, baseline, points…)
 *   {ns}lb:{poolId}:info   STRING board JSON header (version, status, field size…)
 *
 * Ranks are never computed in Redis, so the cache cannot disagree with
 * Postgres on rank or tie order. A rebuild writes temporary keys and swaps all
 * three in one MULTI/EXEC, so readers see the whole old board or the whole new
 * one, never a mix. Redis is never authoritative (PRD-003 §5).
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Board, BoardRow, StandingStatus } from './board';

export interface BoardInfo {
  poolId: string;
  season: string;
  currentWeek: number;
  status: StandingStatus;
  fieldSize: number;
  version: string;
  asOf: string;
}

const keys = (ns: string, poolId: string) => ({
  order: `${ns}lb:${poolId}:order`,
  rows: `${ns}lb:${poolId}:rows`,
  info: `${ns}lb:${poolId}:info`,
});

/** Content hash: changes exactly when anything visible on the board changes. */
export function boardVersion(board: Board): string {
  return createHash('sha256')
    .update(JSON.stringify([board.status, board.currentWeek, board.rows]))
    .digest('hex')
    .slice(0, 16);
}

export async function writeBoard(redis: Redis, ns: string, board: Board, asOf: Date): Promise<BoardInfo> {
  const k = keys(ns, board.poolId);
  const tmp = randomUUID();
  const t = { order: `${k.order}:tmp:${tmp}`, rows: `${k.rows}:tmp:${tmp}`, info: `${k.info}:tmp:${tmp}` };
  const info: BoardInfo = {
    poolId: board.poolId,
    season: board.season,
    currentWeek: board.currentWeek,
    status: board.status,
    fieldSize: board.fieldSize,
    version: boardVersion(board),
    asOf: asOf.toISOString(),
  };

  const build = redis.multi();
  if (board.rows.length) {
    build.rpush(t.order, ...board.rows.map((r) => r.entryId));
    build.hset(t.rows, Object.fromEntries(board.rows.map((r) => [r.entryId, JSON.stringify(r)])));
  }
  build.set(t.info, JSON.stringify(info));
  await build.exec();

  // Atomic swap. An empty board has no order/rows keys, so drop the live ones instead.
  const swap = redis.multi();
  if (board.rows.length) {
    swap.rename(t.order, k.order);
    swap.rename(t.rows, k.rows);
  } else {
    swap.del(k.order, k.rows);
  }
  swap.rename(t.info, k.info);
  const results = await swap.exec();
  const failed = results?.find(([err]) => err);
  if (failed) throw failed[0];
  return info;
}

export async function readInfo(redis: Redis, ns: string, poolId: string): Promise<BoardInfo | null> {
  const raw = await redis.get(keys(ns, poolId).info);
  return raw ? (JSON.parse(raw) as BoardInfo) : null;
}

/**
 * Atomic read: header, one page of the order, and the page's rows plus any
 * extra rows (e.g. the viewer's), all from the same board version. Redis runs
 * a Lua script without interleaving, so a concurrent swap can't split it.
 */
const READ_PAGE_LUA = `
local info = redis.call('GET', KEYS[1])
if not info then return nil end
local ids = redis.call('LRANGE', KEYS[2], tonumber(ARGV[1]), tonumber(ARGV[2]))
local wanted = {}
for i, id in ipairs(ids) do wanted[#wanted + 1] = id end
for i = 3, #ARGV do wanted[#wanted + 1] = ARGV[i] end
local rows = {}
if #wanted > 0 then rows = redis.call('HMGET', KEYS[3], unpack(wanted)) end
return {info, ids, rows}
`;

export async function readPage(
  redis: Redis,
  ns: string,
  poolId: string,
  offset: number,
  limit: number,
  extraEntryIds: string[] = []
): Promise<{ info: BoardInfo; rows: BoardRow[]; extra: Map<string, BoardRow> } | null> {
  const k = keys(ns, poolId);
  const res = (await redis.eval(
    READ_PAGE_LUA, 3, k.info, k.order, k.rows, String(offset), String(offset + limit - 1), ...extraEntryIds
  )) as [string, string[], Array<string | null>] | null;
  if (!res) return null;
  const [infoRaw, ids, values] = res;
  const parsed = values.map((v) => (v ? (JSON.parse(v) as BoardRow) : null));
  const extra = new Map<string, BoardRow>();
  extraEntryIds.forEach((id, i) => {
    const row = parsed[ids.length + i];
    if (row) extra.set(id, row);
  });
  return { info: JSON.parse(infoRaw) as BoardInfo, rows: parsed.slice(0, ids.length) as BoardRow[], extra };
}
