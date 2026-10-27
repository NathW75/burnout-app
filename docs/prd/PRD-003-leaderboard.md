# PRD-003 — Leaderboard
**Burnout League · packages/leaderboard**
Version 1.4 · 2026-10-27
Status: APPROVED — implement against this spec (v1.4 changes: see change log)

---

## 1. Purpose

The leaderboard ranks every entry in a season-long contest pool against the whole field, live during games and officially once a week freezes. It also serves the post-lock reveal: after a game window locks, managers in the same pool can see each other's locked players for that window.

This package reads; it never computes points. Points come only from the scoring engine (PRD-002). Prize amounts, the cash line and payouts belong to PRD-004.

This PRD is the single source of truth for ranking and reveal behavior. Code that conflicts with it is wrong.

---

## 2. Definitions

| Term | Definition |
|------|-----------|
| **Contest pool** | One prize pool: a season, a kind (season-long open; closed league is P3) and a buy-in tier. Each tier is its own pool. |
| **Contest entry** | A user's participation in one pool. One per verified user per pool. |
| **Standing** | An entry's season total (PRD-002 user season total) and its rank within the pool. |
| **Rank** | Standard competition ranking on exact centipoints: 1, 2, 2, 4. |
| **Week rank** | Rank within the pool on a single week's score. |
| **Baseline rank** | An entry's rank when the week's first game window locks. |
| **Projected rank** | An entry's rank right now, with this week's scores as they currently stand. |
| **Movement** | Baseline rank minus projected rank: positive = moved up. |
| **Reveal** | Showing another manager's players after their game window has locked. |
| **Handle** | A user's public name. The only identity shown to other users. |

---

## 3. Pools and Entries (LOCKED)

**Decision 2026-10-26:** a user has **one** season-long lineup and **one** burn pool (PRD-001), no matter how many tiers they enter. Entering more tiers adds more pools that the same lineup is ranked in. Points are identical in every pool the user is in; only the field differs.

- A user may hold at most one entry per pool (decision log: one entry per verified person per buy-in tier).
- **Late entry (locked 2026-10-27, revised same day):** season-long entry closes at the **Week 3 lock** (the pool's `entry_closes_at` is set to the first Week 3 game window's `scheduled_et`). No entry may be created after that. A late payer misses at most Weeks 1–2 and plays the remaining 16, so the gap stays recoverable.
- **Prize standings start the week a user pays.** `contest_entries.scoring_from_week` is set by the database on insert: one more than the last week that had any game window lock at or before `entered_at` (1 for anyone entering before Week 1). Points from weeks already under way at entry stay on the user's record but **never count** in pool standings, snapshots or settlement. This prevents buying in after seeing a hot start.
- **Free play:** anyone may submit lineups without paying, but free players are in no pool and can't win prizes. Free play ends at the same cutoff (PRD-006 §9.0).
- Entries are created by the payment flow (PRD-004) only after the entry fee is captured. This package reads entries; it does not create them.
- Every entry is ranked from Week 1, including entries that never score (they rank at the bottom, tied at 0.00).

---

## 4. Ranking Rules

1. **Order:** season total descending, compared in exact integer centipoints (PRD-002 §3.3). No floating point anywhere in ranking.
2. **Ties share a rank** with competition ranking: two entries tied for 2nd are both 2nd, and the next entry is 4th. This matches the locked prize-split rule (PRD-002 §9): ties are resolved by money, not by a tiebreaker.
3. **Display order within a tie** is by handle, alphabetically. It has no competitive meaning and must not be presented as one.
4. **Week rank** uses the same rules on that week's score.
5. **Standing status**, shown on every leaderboard:

| Status | Condition |
|--------|-----------|
| LIVE | The current week still has game windows in progress or still to be played |
| PROVISIONAL | Current week's games all Final, but the week has not frozen (stat corrections still possible) |
| OFFICIAL | Every week counted so far is frozen (PRD-002 §7) |

6. **Final standings** for a pool are the OFFICIAL standings after Week 18 freezes. That snapshot is the only input PRD-004 uses to settle the pool.

### 4.1 Projected movement (LOCKED 2026-10-26)

Modeled on the PGA Tour's FedEx Cup projected standings: every row shows where the entry started the week and where it is projected to finish it.

- **Baseline** is captured once per week per pool, in the transaction that fires the week's first lock (PRD-001 §4.4), as a `week_start` snapshot. The snapshot runs inside a savepoint: if it fails, only the snapshot rolls back, the lock still commits on time, the failure is reported to the alerting logger, and the next lock that week writes the baseline. A leaderboard fault must never delay or block a lock.
- **Projected** is the live rank from the current standings.
- **Arrow:** green ▲ with places gained when movement > 0, red ▼ with places lost when movement < 0, a dash when unchanged. New entries have no arrow in their first week.
- While the standing status is LIVE or PROVISIONAL, the column is labeled **Projected**. When the week goes OFFICIAL, the arrow becomes that week's final movement and stays visible until the next week's first lock sets a new baseline.
- Movement is shown on the leaderboard rows and the viewer's own card. It is display only and never affects ranking or prizes.

---

## 5. Freshness and Caching

- **Source of truth:** `user_week_scores` and the `user_season_totals` view (PRD-002), joined to `contest_entries`. Ranks are computed in Postgres with `RANK()` on integer centipoints.
- **Cache (v1.2):** Redis holds a copy of each pool's ranked board exactly as Postgres computed it:
  - `lb:{poolId}:order`: list of entry IDs in display order
  - `lb:{poolId}:rows`: hash of entry ID → row (rank, baseline rank, points, week points, handle)
  - `lb:{poolId}:info`: board header (version, status, current week, field size, as-of)

  Ranks are never computed in Redis, so the cache cannot disagree with Postgres on rank or tie order. (v1.1 sketched a sorted set ranked at read time; Redis orders tied scores by member ID, which breaks the handle-order rule in §4.3 when paginating through a tie.)
- **Refresh:** on every `SCORES_UPDATED {season, week}` event (PRD-002 §10), every pool in that season is rebuilt from Postgres into temporary keys, then all three keys are swapped in one `MULTI/EXEC`.
- **Reads** run as one Lua script (header, page and rows together), so a concurrent swap can never split a read across two boards.
- **Version** is a hash of the board's visible content: it changes exactly when something on the board changes.
- **Bound:** a committed score change is visible on the leaderboard within 60 seconds (Tech Summary §3). Clients poll every 60 seconds with the board's `version`; an unchanged version returns 304.
- **Redis is never authoritative.** If Redis is empty, unreachable or errors, the API computes the board from Postgres. PRD-004 settles pools from Postgres snapshots only, never from Redis.
---

## 6. Post-Lock Reveal (LOCKED)

**Decision 2026-10-26:** after a game window locks, every manager **in the same pool** can see each other's locked players for that window.

| What the viewer sees for another manager's slot | When |
|---|---|
| Player (text name, team, position) and points so far | The slot's submission is locked (`locked_at IS NOT NULL`) |
| "Hidden" | The slot is not locked yet. Nothing else: not the player, not the window, not whether the slot is filled |
| "Reopened — game canceled" | The submission was voided (PRD-001 §6.1) and not yet reassigned |

- A manager always sees their own full lineup.
- Past weeks are fully visible to the pool (every slot has locked or been voided).
- The viewer must hold an entry in the pool, and so must the manager being viewed. Anyone else gets 403.
- The rule is enforced in the server query (`locked_at IS NOT NULL` for any lineup that is not the viewer's own), never by the client hiding data. T&C §11.2 makes pre-lock anonymity a legal commitment.
- Text only, no headshots or logos (NIL).
- Weekly contest lineups are not part of this reveal.

---

## 7. Identity (LOCKED)

**Decision 2026-10-26:** users appear only by a user-chosen **handle**. Real names are never shown to other users (T&C §9.3).

- `users.handle`: 3–20 characters, letters, digits and underscore, unique case-insensitively.
- Set at signup. Handles containing reserved words (`burnout`, `admin`, `official`, `support`, `corewright`, `moderator`, `staff`) or a word on the profanity/impersonation blocklist are rejected. The blocklist is supplied by configuration, not hard-coded.
- **Changes (LOCKED 2026-10-26):** a user may change their handle at most **2 times per season**. Every handle a user has held is kept in `user_handle_history`.
- A released handle is reserved for 30 days before anyone else can claim it, so nobody can take the name of the current leader the moment they rename.
- Links and API paths identify entries by entry ID, never by handle, so renames break nothing.
- Snapshots record the handle shown at the time, so a past week's official standings display as they did that week.
- No leaderboard or reveal response contains email, legal name, or any other personal field.

### 7.1 Visibility (LOCKED 2026-10-26)

The full leaderboard is visible only to signed-in users with an entry in that pool. Marketing uses anonymized top-10 exports (brand guide); no public leaderboard page shows handles.

---

## 8. Database Schema — Leaderboard Tables

```sql
ALTER TABLE users ADD COLUMN handle VARCHAR(20);
CREATE UNIQUE INDEX users_handle_lower_key ON users (lower(handle));
-- CHECK: handle ~ '^[A-Za-z0-9_]{3,20}$'

CREATE TABLE contest_pools (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season           VARCHAR(20) NOT NULL,
  kind             VARCHAR(20) NOT NULL,          -- season_open | season_closed (P3)
  buy_in_cents     INTEGER NOT NULL,
  name             VARCHAR(80) NOT NULL,           -- e.g. '$25 Open'
  entry_closes_at  TIMESTAMPTZ NOT NULL,           -- Week 1 first lock
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (season, kind, buy_in_cents)
);

CREATE TABLE contest_entries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id     UUID NOT NULL REFERENCES contest_pools(id),
  user_id     UUID NOT NULL REFERENCES users(id),
  entered_at  TIMESTAMPTZ NOT NULL,
  UNIQUE (pool_id, user_id)
);
-- DB trigger: reject INSERT when entered_at >= the pool's entry_closes_at.

CREATE TABLE leaderboard_snapshots (
  pool_id      UUID NOT NULL REFERENCES contest_pools(id),
  week         SMALLINT NOT NULL,
  kind         VARCHAR(12) NOT NULL,               -- week_start | official
  user_id      UUID NOT NULL REFERENCES users(id),
  handle       VARCHAR(20) NOT NULL,               -- as displayed at snapshot time
  rank         INTEGER NOT NULL,
  points_x100  BIGINT NOT NULL,
  taken_at     TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (pool_id, week, kind, user_id)
);
-- Append-only: UPDATE and DELETE rejected.

CREATE TABLE user_handle_history (
  user_id      UUID NOT NULL REFERENCES users(id),
  handle       VARCHAR(20) NOT NULL,
  season       VARCHAR(20) NOT NULL,
  is_change    BOOLEAN NOT NULL,                    -- false for the handle set at signup
  valid_from   TIMESTAMPTZ NOT NULL,
  valid_to     TIMESTAMPTZ,                         -- NULL = current
  PRIMARY KEY (user_id, valid_from)
);
-- DB triggers: reject a change when the user already has 2 changes in the season;
-- reject claiming a handle another user holds or released less than 30 days ago;
-- reject any users.handle value without an open history row (changes cannot bypass history).
```

- `week_start` snapshots are written in the transaction that fires each week's first lock (§4.1).
- `official` snapshots are written in the transaction that freezes a week (PRD-002 §7), for every pool in that season, so official standings and frozen scores always agree.

---

## 9. API (read-only)

All endpoints require a signed-in user with an entry in the pool.

| Endpoint | Returns |
|----------|---------|
| `GET /pools/:poolId/leaderboard?offset&limit` | `{ status, version, asOf, fieldSize, rows: [{ entryId, rank, baselineRank, movement, handle, pointsX100, weekPointsX100, isMe }] }` |
| `GET /pools/:poolId/leaderboard/me` | The viewer's card: rank, baseline rank and movement, field size, percentile, points behind the entry above, points ahead of the entry below, week score, week rank, field average and top score this week |
| `GET /pools/:poolId/leaderboard/week/:week` | Week ranks for that week |
| `GET /pools/:poolId/lineups/:entryId?week=N` | Revealed lineup per §6 |

`limit` is capped at 100. Points are returned as integer centipoints; clients format them (two decimals).

---

## 10. Notifications

- **No rank pushes.** Movement is communicated by the projected arrows (§4.1), not by push notifications. This supersedes the Tech Summary §10.2 "you just passed #3" push.
- **Weekly recap email** includes, per pool: official rank, the week's movement (start-of-week rank → finish), and week rank. The recap itself belongs to the notifications PRD; this package supplies the data.

---

## 11. Acceptance Criteria

1. **Pool scoping.** A user entered in the $25 and $100 pools appears in both with identical points; a user not entered in a pool never appears in it.
2. **Competition ranking.** Equal centipoint totals share a rank and the next rank skips (1, 2, 2, 4). Totals 0.02 apart do not share a rank.
3. **Zero scorers ranked.** An entry with no scores appears, tied at 0.00 at the bottom.
4. **Freshness.** After a `SCORES_UPDATED` event, the cached board equals the board computed from Postgres, and its `version` changes.
5. **Cache is not authority.** With the cache empty or unavailable, the API returns the same standings computed from Postgres.
6. **Atomic rebuild.** A reader during a rebuild sees either the complete old board or the complete new board, never a mix. Verified with concurrent readers across repeated rebuilds between two known boards: only those two boards are ever observed.
7. **Reveal.** Another manager's unlocked slots are never returned (player, window, or filled/empty state); locked slots are returned after their lock; a viewer outside the pool gets 403.
8. **Identity.** No leaderboard or reveal response contains email or real name.
9. **Snapshots.** The week's first lock writes a `week_start` snapshot, and freezing a week writes an `official` snapshot, each for every entry in every pool of that season, inside the lock and freeze transactions respectively. Snapshot rows record the handle shown at the time.
10. **Status.** LIVE, PROVISIONAL and OFFICIAL are derived as in §4.5.
11. **Entry close.** An entry created at or after the pool's `entry_closes_at` is rejected by the database.
12. **Projected movement.** Movement = baseline rank − projected rank; ▲ when positive, ▼ when negative, dash when zero, no arrow for an entry with no baseline. The label reads Projected until the week is OFFICIAL.
13. **Handle changes.** A third handle change in a season is rejected; a handle released less than 30 days ago cannot be claimed by another user; entry IDs and past snapshots are unaffected by a rename.
14. **Visibility.** A signed-in user without an entry in a pool gets 403 on that pool's leaderboard.

---

## 12. Out of Scope for PRD-003

- Prize amounts, cash line, payout execution (PRD-004). Once PRD-004 defines the payout table, the leaderboard adds an "in the money" marker from it.
- Weekly contest leaderboards (weekly contests PRD)
- Closed league commissioner tools (P3; the pool model already supports `season_closed`)
- Ownership %, Burned Roster, Regret Index (analytics PRDs)

---

## 13. Open Questions

1. **Handle blocklist.** The profanity/impersonation list needs an owner and a source before launch (§7).

Resolved 2026-10-26:
- **Handle changes:** allowed, at most 2 per season (§7).
- **Public visibility:** entrants only (§7.1).
- **Milestones:** replaced by FedEx Cup–style projected movement arrows (§4.1); no rank pushes (§10).

---

---

## Change log

**v1.4 — 2026-10-27**
- §3: free play shortened to two weeks; late entry closes at the **Week 3 lock** (was Week 4)

**v1.3 — 2026-10-27**
- §3: late entry through the Week 4 lock; prize standings count from `scoring_from_week` (weeks already under way at entry never count); free play noted

**v1.2 — 2026-10-26**
- Status: APPROVED
- §4.1: baseline snapshot isolated in a savepoint; a snapshot failure never blocks a lock
- §4.5: LIVE covers windows still to be played this week, not only games in progress
- §5: cache stores Postgres-ranked boards (list + hash + header), atomic swap and atomic Lua reads; replaces the sorted-set sketch
- §7, §8: blocklist via configuration; `user_handle_history.is_change`; history-only handle changes enforced by trigger
- AC6: verification method stated; §13: handle blocklist added

**v1.1 — 2026-10-26**
- §4.1: new — projected movement arrows (baseline at the week's first lock vs. live projected rank)
- §7: handle changes, 2 per season; history; 30-day reservation; entry IDs in links
- §7.1: entrants-only visibility
- §8: `leaderboard_snapshots.kind` (week_start | official) and `handle`; `user_handle_history`
- §10: rank pushes removed
- AC9 updated; AC12–AC14 added; §13 resolved

*This PRD is authoritative once approved. Disputes between this document and earlier design docs: this document wins.*
