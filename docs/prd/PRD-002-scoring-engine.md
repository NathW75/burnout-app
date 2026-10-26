# PRD-002 — Scoring Engine
**Burnout League · packages/scoring-engine**
Version 1.0 · 2026-10-26
Status: DRAFT — decisions in §3, §7 and §9 locked 2026-10-26; full document pending review

---

## 1. Purpose

The scoring engine turns MySportsFeeds (MSF) player stats into fantasy points and rolls them up into each user's slot, week and season totals. The leaderboard (PRD-003) displays these totals and payouts (PRD-004) settle on them. Nothing else in the platform computes fantasy points.

Scoring is independent of the burn. PRD-001 decides *whether* a player is burned; this PRD decides *how many points* a locked player earned. Neither system reads the other's output to make its own decision.

This PRD is the single source of truth for scoring. Code that conflicts with it is wrong.

---

## 2. Definitions

| Term | Definition |
|------|-----------|
| **Stat line** | One player's normalized stats for one NFL game, as ingested from MSF. |
| **Player game score** | Fantasy points for one stat line under the season's scoring rules. |
| **Slot score** | The player game score of the player locked in a lineup slot. 0 if the slot is empty or voided. |
| **Week score** | Sum of a user's 9 slot scores for one NFL week (season-long competition). |
| **Season total** | Sum of a user's week scores across Weeks 1–18. |
| **Score status** | `provisional` (game in progress), `final` (game Final, corrections still accepted), `frozen` (correction window closed; permanent). |
| **Stat correction** | A change MSF reports to a stat line after the game reached Final. |
| **Correction window** | From a game's Final until the week freezes (§7). |
| **Centipoints** | Points × 100, stored as an integer. 12.48 points = 1248 centipoints. |

---

## 3. Scoring Rules (LOCKED)

**Decision 2026-10-26:** Yahoo Fantasy default scoring, half-PPR, with fractional yardage and negative points enabled. Source: [Yahoo — Default league settings in Fantasy Football](https://help.yahoo.com/kb/default-league-settings-scoring-stats-fantasy-football-sln6489.html). Ruleset identifier: `yahoo-half-ppr-v1`.

### 3.1 Offensive players (QB, RB, WR, TE)

| Stat | Points | Centipoints |
|------|--------|-------------|
| Passing yard | 0.04 (1 per 25) | 4 per yard |
| Passing TD | 4 | 400 |
| Interception thrown | −1 | −100 |
| Rushing yard | 0.1 (1 per 10) | 10 per yard |
| Rushing TD | 6 | 600 |
| Reception | 0.5 | 50 |
| Receiving yard | 0.1 (1 per 10) | 10 per yard |
| Receiving TD | 6 | 600 |
| Kick or punt return TD | 6 | 600 |
| Fumble recovery TD (offensive player) | 6 | 600 |
| Fumble lost | −2 | −200 |
| Two-point conversion (passing, rushing or receiving) | 2 | 200 |

### 3.2 Kickers (K)

| Stat | Points | Centipoints |
|------|--------|-------------|
| Field goal made, 0–39 yards | 3 | 300 |
| Field goal made, 40–49 yards | 4 | 400 |
| Field goal made, 50+ yards | 5 | 500 |
| Extra point made | 1 | 100 |
| Field goal or extra point missed | 0 | 0 |

The Yahoo default page does not list a value for misses; this PRD locks them at 0.

### 3.3 Arithmetic

- **Fractional, not floored.** 287 passing yards = 11.48 points, not 11. Negative yardage produces negative points (−3 rushing yards = −0.30).
- **Integer centipoints everywhere.** Every rule above is a whole number of centipoints, so all scoring is exact integer math. Points are never stored or summed as floating point. Display divides by 100 and shows two decimals.
- **No caps, no bonuses.** No yardage milestone bonuses, no long-TD bonuses, no per-carry or per-target points.

### 3.4 Rules are fixed for the season

The ruleset is set before the season and cannot change once the Week 1 lock fires. Every score row records its `rules_version`. A season mixing rule versions is a data integrity violation. There is no commissioner override and no mid-season "fairness" adjustment.

### 3.5 Out of scope: DEF

Team defense is a P2 slot (PRD-001 §2) and is scored by the DEF PRD, not this one. Weekly contests that include DEF (Best Dog) cannot launch until that PRD lands.

---

## 4. Data Source

### 4.1 MSF ingestion

- Stats come from MSF v2.1 per-game player stat feeds, called only by the backend worker (one authenticated client; PRD-001 constraints apply).
- An MSF adapter maps feed fields into the normalized stat line (§8.1). **Field mapping must be verified against the live feed** (MSF key lives in Railway env vars only) and captured as recorded fixtures before this ships. Specifically confirm: two-point conversion credit for passer, rusher and receiver; kick/punt return TDs; offensive fumble recovery TDs; field goals made by distance bucket so they map onto the three Yahoo tiers.
- The adapter is the only code that knows MSF field names. The scoring function never sees raw MSF payloads.

### 4.2 Ingestion cadence

| Situation | Cadence |
|-----------|---------|
| Any game in a locked, non-Final window | Every 15 minutes (Tech Summary §5), configurable |
| Game Final, week not frozen (correction sweep) | Hourly |
| Week frozen | Never; frozen weeks are not re-polled |

The worker reuses the PRD-001 server clock dependency. Client time is never used.

---

## 5. Score Computation

### 5.1 Player game score

`score(statLine, rulesVersion) → centipoints` is a **pure function**: same stat line and ruleset always produce the same result, with no I/O. Every stored score can be recomputed from its stored stat line, and the integrity job (§10) does exactly that.

### 5.2 Which players score (season-long)

A slot scores only if a `season_submissions` row for that slot has `locked_at IS NOT NULL` and `void_reason IS NULL`. Then the slot score is the player game score from **the game in that submission's game window**.

| Situation | Slot score |
|-----------|-----------|
| Locked player, game in progress | Provisional player game score (live) |
| Locked player, game Final | Final player game score |
| Locked player active but recorded no stats | 0.00 (a real score of zero) |
| Locked player does not appear in that game (inactive, scratched) | 0.00 |
| Empty slot (PRD-001 §4.5) | 0.00 |
| Voided slot after cancellation, not reassigned (PRD-001 §6.1) | 0.00 |
| Voided slot reassigned and locked in a later window | The reassigned player's score |
| Game suspended, not yet resumed | Provisional points so far; final when the game reaches Final |
| Game moved to a different week | Treated as canceled for the original week: 0.00 |

Scoring never waits for the whole game window. Each player's score goes final when **his own game** is Final, unlike burns, which commit per window (PRD-001 implementation note).

### 5.3 Burn isolation

`weekly_submissions` never contribute to season-long week scores or season totals. Weekly contest rollups reuse the player game scores from this PRD but live in the weekly contests PRD.

### 5.4 Rollups

- Week score = sum of the 9 slot scores, in centipoints.
- Season total = sum of week scores, Weeks 1–18.
- A user's week score is recomputed whenever any of their slot scores changes, in the **same transaction** as the player score change, so a reader never sees a player score that disagrees with the week total.

---

## 6. Score Lifecycle

```
(no row) → PROVISIONAL   first stats ingested while the game is in progress
PROVISIONAL → FINAL      MSF reports the game Final
FINAL → FINAL            stat correction applied (inside the correction window)
FINAL → FROZEN           week freezes (§7); terminal
```

- Live updates overwrite provisional scores freely; provisional changes are not corrections and are not audited.
- Every change to a `final` score is a stat correction and writes a `score_corrections` row (§8.3).
- `frozen` is terminal. No code path changes a frozen score.

---

## 7. Stat Corrections and Freezing (LOCKED)

**Decision 2026-10-26:** Stat corrections apply until the weekly payout cutoff, then the week is frozen permanently.

- **Freeze time** for an NFL week = the moment the **last** game of that week reached Final + **48 hours**, by the server clock. This matches the weekly contest payout timing in the T&C framework (§5.6).
- Example: MNF reaches Final Tuesday 12:10 AM ET → the week freezes Thursday 12:10 AM ET.
- Before freeze, every correction from the hourly sweep is applied: player score updated, `score_corrections` row written, week score and season total updated, all in one transaction.
- After freeze, corrections are **not applied**. They are still recorded in `score_corrections` with `applied = false` so the gap between official stats and platform scores stays auditable.
- A week with any game not yet Final (suspended, delayed) **does not freeze**; the 48-hour clock starts only when the last game is Final. Payouts for that week hold (PRD-001 §6.2).
- Season-long payout (T&C §5.6: within 5 business days of the last regular-season game's Final) waits for Week 18 to freeze.
- Freezing writes one `week_freezes` row and flips every score for that week to `frozen` in a single transaction.

---

## 8. Database Schema — Scoring Tables

### 8.1 Stat lines

```sql
CREATE TABLE player_game_stats (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season            VARCHAR(20) NOT NULL,
  week              SMALLINT NOT NULL,
  msf_game_id       VARCHAR(50) NOT NULL,
  player_id         VARCHAR(50) NOT NULL,          -- MSF player ID
  game_window_id    UUID NOT NULL REFERENCES game_windows(id),
  pass_yds          INTEGER NOT NULL DEFAULT 0,
  pass_td           SMALLINT NOT NULL DEFAULT 0,
  pass_int          SMALLINT NOT NULL DEFAULT 0,
  rush_yds          INTEGER NOT NULL DEFAULT 0,
  rush_td           SMALLINT NOT NULL DEFAULT 0,
  receptions        SMALLINT NOT NULL DEFAULT 0,
  rec_yds           INTEGER NOT NULL DEFAULT 0,
  rec_td            SMALLINT NOT NULL DEFAULT 0,
  return_td         SMALLINT NOT NULL DEFAULT 0,
  fumble_rec_td     SMALLINT NOT NULL DEFAULT 0,
  fumbles_lost      SMALLINT NOT NULL DEFAULT 0,
  two_pt            SMALLINT NOT NULL DEFAULT 0,
  fg_made_0_39      SMALLINT NOT NULL DEFAULT 0,
  fg_made_40_49     SMALLINT NOT NULL DEFAULT 0,
  fg_made_50_plus   SMALLINT NOT NULL DEFAULT 0,
  fg_missed         SMALLINT NOT NULL DEFAULT 0,
  xp_made           SMALLINT NOT NULL DEFAULT 0,
  xp_missed         SMALLINT NOT NULL DEFAULT 0,
  stat_hash         CHAR(64) NOT NULL,             -- SHA-256 of the normalized stat line
  source_updated_at TIMESTAMPTZ NOT NULL,          -- MSF's lastUpdatedOn for the feed
  ingested_at       TIMESTAMPTZ NOT NULL,
  UNIQUE (season, msf_game_id, player_id)
);
```

Yardage columns allow negatives. Count columns are non-negative (CHECK constraints in the migration).

### 8.2 Player game scores

```sql
CREATE TABLE player_game_scores (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stats_id          UUID NOT NULL UNIQUE REFERENCES player_game_stats(id),
  season            VARCHAR(20) NOT NULL,
  week              SMALLINT NOT NULL,
  msf_game_id       VARCHAR(50) NOT NULL,
  player_id         VARCHAR(50) NOT NULL,
  game_window_id    UUID NOT NULL REFERENCES game_windows(id),
  points_x100       INTEGER NOT NULL,              -- centipoints
  status            VARCHAR(12) NOT NULL,          -- provisional | final | frozen
  rules_version     VARCHAR(40) NOT NULL,          -- 'yahoo-half-ppr-v1'
  computed_at       TIMESTAMPTZ NOT NULL,
  UNIQUE (season, msf_game_id, player_id),
  CHECK (status IN ('provisional','final','frozen'))
);
CREATE INDEX idx_pgs_player_week ON player_game_scores (season, week, player_id);
```

DB trigger: UPDATE is rejected when `OLD.status = 'frozen'`; DELETE is always rejected.

### 8.3 Corrections audit (append-only)

```sql
CREATE TABLE score_corrections (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  score_id          UUID NOT NULL REFERENCES player_game_scores(id),
  detected_at       TIMESTAMPTZ NOT NULL,
  points_before_x100 INTEGER NOT NULL,
  points_after_x100  INTEGER NOT NULL,
  stats_before      JSONB NOT NULL,
  stats_after       JSONB NOT NULL,
  applied           BOOLEAN NOT NULL,              -- false = arrived after freeze
  reason            VARCHAR(30) NOT NULL           -- STAT_CORRECTION | AFTER_FREEZE
);
```

DB trigger: UPDATE and DELETE always rejected.

### 8.4 User rollups

```sql
CREATE TABLE user_week_scores (
  user_id           UUID NOT NULL REFERENCES users(id),
  season            VARCHAR(20) NOT NULL,
  week              SMALLINT NOT NULL,
  points_x100       INTEGER NOT NULL DEFAULT 0,
  slots_scored      SMALLINT NOT NULL DEFAULT 0,   -- locked, non-voided slots counted
  status            VARCHAR(12) NOT NULL,          -- provisional | final | frozen
  updated_at        TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, season, week)
);

CREATE VIEW user_season_totals AS
  SELECT user_id, season, SUM(points_x100)::bigint AS points_x100
    FROM user_week_scores
   GROUP BY user_id, season;

CREATE TABLE week_freezes (
  season            VARCHAR(20) NOT NULL,
  week              SMALLINT NOT NULL,
  last_final_at     TIMESTAMPTZ NOT NULL,
  frozen_at         TIMESTAMPTZ NOT NULL,
  scores_frozen     INTEGER NOT NULL,
  PRIMARY KEY (season, week)
);
```

A `user_week_scores` row is `final` when every locked slot's score is final, and `frozen` when its week is in `week_freezes`. PRD-003 decides whether season totals also need a cache (Redis) for leaderboard reads.

---

## 9. Ranking and Ties (LOCKED)

**Decision 2026-10-26:** Ties at a paying position split the tied prizes.

- Users are ranked by season total, descending, compared in exact centipoints.
- Equal totals share a rank, with standard competition ranking: 1, 2, 2, 4.
- Prize split: tied users share the **combined** prizes of the positions they occupy, evenly. Example: two users tied for 2nd split the 2nd + 3rd prizes.
- Rank computation belongs to PRD-003; split and cent-rounding math belongs to PRD-004. This PRD guarantees exact, comparable totals so ties are real ties, not floating-point artifacts.

---

## 10. Processing Jobs

| Job | Trigger | Does |
|-----|---------|------|
| Live ingest | Every 15 min while any game in a locked window is not Final | Fetch stats; upsert `player_game_stats` only when `stat_hash` changed; recompute affected scores and user week scores in one transaction |
| Finalize | MSF reports a game Final | Ingest final stats; set those scores `final` |
| Correction sweep | Hourly for Final games in non-frozen weeks | Re-fetch; apply changes per §7 |
| Freeze | Server clock passes last Final + 48h for a week | One transaction: insert `week_freezes`, set all week scores and user week scores `frozen` |
| Integrity check | After each freeze | Recompute every frozen score from its stat line with the pure function; any mismatch halts payouts for that week (Tech Summary §7.3) |

After any job changes scores, it emits a `SCORES_UPDATED {season, week}` event for the leaderboard (PRD-003). Scoring jobs are idempotent: re-running with an unchanged feed writes nothing.

---

## 11. Acceptance Criteria

1. **Yahoo half-PPR parity.** Given these stat lines, scores are exactly:
   - QB: 287 pass yds, 2 pass TD, 1 INT, 18 rush yds, 1 fumble lost → **18.28** (1828)
   - RB: −3 rush yds, 5 receptions, 41 rec yds, 1 rec TD → **12.30** (1230)
   - K: FGs of 38, 44 and 52 yds, 1 FG missed, 3 XP made → **15.00** (1500)
   - WR active with no stats → **0.00**, stored as a real score row.
   Also verified: the computed scores for one full 2025 MSF week match Yahoo's published default-scoring totals for a sample of at least 50 players.
2. **Exact arithmetic.** All points are stored and summed as integer centipoints. A week score always equals the sum of its displayed slot scores, to the cent.
3. **Only locked slots score.** Empty and voided slots score 0. A player in `weekly_submissions` adds nothing to the season-long week score or season total.
4. **Lifecycle.** Live ingests update provisional scores. Final sets status `final` for that player's game even if other games in the window are still live.
5. **Correction applied before freeze.** A changed stat line after Final updates the score, writes `score_corrections` with `applied = true`, and updates the user week score and season total in the same transaction.
6. **Correction ignored after freeze.** A changed stat line after freeze leaves every score and total unchanged and writes `score_corrections` with `applied = false`.
7. **Freeze timing.** A week freezes exactly at last Final + 48h by the server clock, not one second earlier. A week with any game not Final never freezes.
8. **Frozen is permanent.** UPDATE on a frozen `player_game_scores` row and any UPDATE or DELETE on `score_corrections` are rejected at the database.
9. **Determinism and idempotency.** Re-ingesting an unchanged feed writes no rows. Recomputing every frozen score from its stat line reproduces the stored value.
10. **Ties are exact.** Two users with equal centipoint totals share a rank; users 0.01 apart do not.
11. **Rules fixed for the season.** After the Week 1 lock fires, attempting to score with a different `rules_version` for that season is rejected.

---

## 12. Out of Scope for PRD-002

- Leaderboard ranking, display, real-time push (PRD-003)
- Prize split arithmetic, cent rounding, payout execution (PRD-004)
- Team defense scoring (DEF PRD, P2)
- Pri/Alt substitutions (PRD-005, P2)
- Weekly contest rollups and contest-specific slots (weekly contests PRD)
- Ownership percentages (ownership analytics PRD)

---

## 13. Open Questions

1. **MSF field mapping.** Confirm against the live feed and record fixtures (§4.1), especially two-point conversion crediting and FG distance buckets.
2. **Mid-week trades.** A player traded after a user locked him for his old team's game, who then plays for his new team in a different window: this PRD scores only the game in the submission's window, so he scores 0. Confirm that policy and state it in T&C.
3. **Correction notifications.** Should users be told when a correction changes their week score or rank? Suggested: in-app only, no push.
4. **Push provider.** PRD-001 names Expo push; the Tech Summary and stack list name OneSignal. The `notification_queue` outbox is provider-agnostic, but the dispatcher needs one answer.

---

*This PRD is authoritative once approved. Disputes between this document and earlier design docs: this document wins.*
