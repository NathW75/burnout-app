# PRD-003 — Leaderboard
**Burnout League · packages/leaderboard**
Version 1.0 · 2026-10-26
Status: DRAFT — decisions in §3, §6 and §7 locked 2026-10-26; full document pending review

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
| **Movement** | Change from the entry's rank in the most recent official snapshot. |
| **Reveal** | Showing another manager's players after their game window has locked. |
| **Handle** | A user's public name. The only identity shown to other users. |

---

## 3. Pools and Entries (LOCKED)

**Decision 2026-10-26:** a user has **one** season-long lineup and **one** burn pool (PRD-001), no matter how many tiers they enter. Entering more tiers adds more pools that the same lineup is ranked in. Points are identical in every pool the user is in; only the field differs.

- A user may hold at most one entry per pool (decision log: one entry per verified person per buy-in tier).
- Season-long entry closes at the Week 1 lock: no entry may be created after the first Week 1 game window's `scheduled_et`. Late joiners play weekly contests only.
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
| LIVE | Any game in the current week is in progress |
| PROVISIONAL | Current week's games all Final, but the week has not frozen (stat corrections still possible) |
| OFFICIAL | Every week counted so far is frozen (PRD-002 §7) |

6. **Final standings** for a pool are the OFFICIAL standings after Week 18 freezes. That snapshot is the only input PRD-004 uses to settle the pool.

---

## 5. Freshness and Caching

- **Source of truth:** `user_week_scores` and the `user_season_totals` view (PRD-002), joined to `contest_entries`.
- **Cache:** one Redis sorted set per pool (`lb:{poolId}`), member = user ID, score = season total in centipoints. A competition rank is `1 + ZCOUNT(lb:{poolId}, (score, +inf)`.
- **Refresh:** on every `SCORES_UPDATED {season, week}` event (PRD-002 §10), the cache for every pool in that season is rebuilt from Postgres. Rebuild is a full replace, written to a temporary key and renamed atomically, so readers never see a half-built board.
- **Bound:** a committed score change is visible on the leaderboard within 60 seconds (Tech Summary §3). Clients poll every 60 seconds with the board's `version`; an unchanged version returns 304.
- **Redis is never authoritative.** If Redis is empty or unavailable, the API computes the board from Postgres. PRD-004 settles pools from Postgres snapshots only, never from Redis.

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
- Set at signup. Reserved words (e.g. `burnout`, `admin`, `official`, `support`, `corewright`) and a profanity list are rejected.
- No leaderboard or reveal response contains email, legal name, or any other personal field.

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

CREATE TABLE leaderboard_snapshots (             -- official standings, written at each week freeze
  pool_id      UUID NOT NULL REFERENCES contest_pools(id),
  week         SMALLINT NOT NULL,                  -- standings through this week
  user_id      UUID NOT NULL REFERENCES users(id),
  rank         INTEGER NOT NULL,
  points_x100  BIGINT NOT NULL,
  frozen_at    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (pool_id, week, user_id)
);
-- Append-only: UPDATE and DELETE rejected.
```

`leaderboard_snapshots` is written in the same transaction that freezes a week (PRD-002 §7), for every pool in that season, so official standings and frozen scores always agree.

---

## 9. API (read-only)

All endpoints require a signed-in user with an entry in the pool.

| Endpoint | Returns |
|----------|---------|
| `GET /pools/:poolId/leaderboard?offset&limit` | `{ status, version, asOf, fieldSize, rows: [{ rank, handle, pointsX100, weekPointsX100, movement, isMe }] }` |
| `GET /pools/:poolId/leaderboard/me` | The viewer's card: rank, field size, percentile, points behind the entry above, points ahead of the entry below, week score, week rank, field average and top score this week |
| `GET /pools/:poolId/leaderboard/week/:week` | Week ranks for that week |
| `GET /pools/:poolId/lineups/:handle?week=N` | Revealed lineup per §6 |

`limit` is capped at 100. Points are returned as integer centipoints; clients format them (two decimals).

---

## 10. Notifications

- **Rank milestone (push):** when a manager moves up into the top 10, top 3 or 1st in a pool. At most one milestone push per manager per game window, upward crossings only, so live swings don't spam (Tech Summary §10.2).
- **Weekly recap email** (Tech Summary §10.2) includes official rank, movement and week rank per pool. The recap itself belongs to the notifications PRD; this package supplies the data.

---

## 11. Acceptance Criteria

1. **Pool scoping.** A user entered in the $25 and $100 pools appears in both with identical points; a user not entered in a pool never appears in it.
2. **Competition ranking.** Equal centipoint totals share a rank and the next rank skips (1, 2, 2, 4). Totals 0.02 apart do not share a rank.
3. **Zero scorers ranked.** An entry with no scores appears, tied at 0.00 at the bottom.
4. **Freshness.** After a `SCORES_UPDATED` event, the cached board equals the board computed from Postgres, and its `version` changes.
5. **Cache is not authority.** With the cache empty or unavailable, the API returns the same standings computed from Postgres.
6. **Atomic rebuild.** A reader during a rebuild sees either the complete old board or the complete new board, never a mix.
7. **Reveal.** Another manager's unlocked slots are never returned (player, window, or filled/empty state); locked slots are returned after their lock; a viewer outside the pool gets 403.
8. **Identity.** No leaderboard or reveal response contains email or real name.
9. **Official snapshots.** Freezing a week writes a snapshot row for every entry in every pool of that season, in the freeze transaction; movement equals snapshot rank minus current rank.
10. **Status.** LIVE, PROVISIONAL and OFFICIAL are derived as in §4.5.
11. **Entry close.** An entry created at or after the pool's `entry_closes_at` is rejected by the database.

---

## 12. Out of Scope for PRD-003

- Prize amounts, cash line, payout execution (PRD-004). Once PRD-004 defines the payout table, the leaderboard adds an "in the money" marker from it.
- Weekly contest leaderboards (weekly contests PRD)
- Closed league commissioner tools (P3; the pool model already supports `season_closed`)
- Ownership %, Burned Roster, Regret Index (analytics PRDs)

---

## 13. Open Questions

1. **Handle changes mid-season.** Proposed: fixed for the season once the user's first lineup locks; changeable in the offseason.
2. **Public visibility.** Proposed: the full leaderboard is entrants-only; marketing uses anonymized top-10 exports (brand guide). Confirm.
3. **Milestone thresholds.** Top 10 / top 3 / 1st as proposed in §10, or different?

---

*This PRD is authoritative once approved. Disputes between this document and earlier design docs: this document wins.*
