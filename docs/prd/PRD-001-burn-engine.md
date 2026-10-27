# PRD-001 — Burn Engine
**Burnout League · packages/burn-engine**
Version 1.2 · 2026-10-27
Status: APPROVED — implement against this spec (v1.2 changes: see change log at end)

---

## 1. Purpose

The burn engine is the mechanical core of Burnout League. It determines when players are locked, when they are burned, and maintains the integrity of each user's available player pool for the duration of the NFL season. Every other system — lineup builder, scoring, leaderboard, notifications — depends on the authoritative state produced by this package.

This PRD is the single source of truth. Code that conflicts with it is wrong; this document is not wrong because code conflicts with it.

---

## 2. Definitions

| Term | Definition |
|------|-----------|
| **Burn** | A player is permanently removed from a user's available pool for the remainder of the NFL season. A burn is irreversible except in the case of game cancellation (see §6). |
| **Lock** | A player's game window has reached its scheduled kickoff time (per NFL published schedule). The user may no longer modify the slot. Lock is a necessary but not sufficient condition for a burn. |
| **Final** | The NFL has posted a Final status for the player's game. Final is a necessary but not sufficient condition for a burn. |
| **Two-part burn criterion** | A player is burned if and only if: (a) they were in the user's submitted lineup when their game window locked, AND (b) the NFL has posted Final status for their game. Both conditions must be simultaneously true. Neither alone is sufficient. |
| **Game window** | A grouping of NFL games sharing the same scheduled kickoff time block (e.g., Sunday 1:00 PM ET). |
| **Slot** | One of 9 roster positions in a user's lineup: QB, RB1, RB2, WR1, WR2, WR3, TE, FLEX, K. (DEF is a P2 addition.) |
| **Available pool** | The set of players a user has not yet burned, eligible for selection in future weeks. |
| **Pri/Alt** | Optional insurance mechanic (P2). Alt fires automatically on defined trigger events when all reassignment windows are closed. |

---

## 3. Roster Slot Specification

### 3.1 NFL Season — 9 slots (MVP)

| Slot key | Position | Eligible positions |
|----------|----------|--------------------|
| `qb` | Quarterback | QB |
| `rb1` | Running Back 1 | RB, FB |
| `rb2` | Running Back 2 | RB, FB |
| `wr1` | Wide Receiver 1 | WR |
| `wr2` | Wide Receiver 2 | WR |
| `wr3` | Wide Receiver 3 | WR |
| `te` | Tight End | TE |
| `flex` | Flex | RB, FB, WR, TE |
| `k` | Kicker | K |

### 3.1.1 Fullbacks and inactive players (locked 2026-10-27)

- **Fullbacks** (FB) are eligible at RB1, RB2 and FLEX.
- **Out and IR players are not selectable.** They are shown greyed out with their designation, but they are **not burned**: they stay in the user's pool and become selectable again when their designation clears. Questionable and Doubtful players remain selectable. Validation code: `PLAYER_INACTIVE`.
- A player who is **already in a confirmed lineup** and turns Out or IR **before his window locks** has his submission voided (`void_reason = 'PLAYER_INACTIVE'`), with an audit row and an email + in-app notice, exactly like §6.5. The slot is editable, the player is not locked or burned, and the slot scores 0 if it isn't refilled. A designation that arrives after the lock changes nothing: the lock stands.

### 3.2 One-per-franchise rule (weekly contests only)

In weekly micro-contests, no two slots may contain players from the same NFL franchise. This rule does NOT apply to season-long competition. Enforcement: application-level validation at submission, NOT database constraint (to allow draft saves without validation).

### 3.3 Burn isolation

Weekly contest submissions use a separate submission table (`weekly_submissions`). A player used in a weekly contest NEVER triggers a burn in the season-long competition. This is enforced at the database level by maintaining separate submission records, not by application logic alone.

---

## 4. Progressive Lock System

### 4.1 Authority

The server clock is the sole authoritative time reference. It is NTP-synchronized. The client clock is never trusted for lock decisions. Lock fires are evaluated against `scheduled_et` on the `game_windows` table.

### 4.2 Lock trigger

A lock fires at exactly `scheduled_et` for each game window, regardless of actual kickoff time. A game that starts 4 minutes late still locks at its scheduled time. This rule is non-negotiable and must be stated in T&C and displayed in UI.

### 4.3 Game window schedule (standard)

| Window | Scheduled lock time ET |
|--------|----------------------|
| Thursday Night Football | Thursday 8:15 PM |
| Friday (international/special) | Per NFL schedule |
| Saturday Early | Saturday ~1:00 PM (late season only, Weeks 15–17) |
| Saturday Late | Saturday ~4:30 PM (late season only) |
| Sunday Early | Sunday 1:00 PM |
| Sunday Late | Sunday 4:05 PM or 4:25 PM (varies by week) |
| Sunday Night Football | Sunday 8:20 PM |
| Monday Night Football | Monday 8:15 PM |

### 4.4 Lock implementation

The lock cron fires every minute. For each game window where `NOW() >= scheduled_et AND status = 'pending'`:

1. Set `game_windows.status = 'locked'`
2. For every `season_submissions` row where `player_game_window_id` matches this window AND `locked_at IS NULL`:
   - Set `locked_at = NOW()` (the server time of the cron fire, not `scheduled_et`)
3. Queue ONE lock notification per affected user, listing every player of theirs locked in this window (see §8.1). The notification_queue row is written in the same transaction; delivery happens only after commit
4. Log to `lock_events` table

**Critical**: The lock notification must fire as part of the same server event as the lock. It is not a follow-up. Users receive confirmation of the irrevocable lock at the same instant it occurs.

### 4.5 Empty slot rule

A user who fails to fill a slot by its game window lock receives 0 points for that slot that week. The empty slot does NOT trigger a burn. A player is burned only if they were submitted and in the lineup when the lock fired.

---

## 5. Two-Part Burn Criterion — Implementation

### 5.1 Burn state machine

```
AVAILABLE → LOCKED (lock fires; game_window.status = locked)
LOCKED → BURNED (NFL posts Final; both conditions now true)
LOCKED → AVAILABLE (game cancellation before any plays; slot reopens)
BURNED → [terminal; no further transitions except via sysadmin SLOT_REOPENED event]
```

### 5.2 Final status monitoring

The MySportsFeeds (MSF) API is polled for game Final status on the following schedule:

| Day/time | Poll interval |
|----------|---------------|
| Mon–Wed (no games) | 60 minutes |
| Thu (game day) | 5 minutes from 6 PM ET |
| Fri–Sat | 30 minutes; 5 min on game day from 2 hours before kickoff |
| Sun 12:00–8:00 PM ET | 5 minutes |
| Sun 8:00 PM – end | 2 minutes |
| Mon (MNF day) | 5 minutes from 6 PM ET; 2 min from kickoff to Final |

When MSF returns `final: true` for a game:

1. Fetch all `season_submissions` where `player_game_window_id` references that game AND `locked_at IS NOT NULL` AND `burned_at IS NULL`
2. For each matching submission:
   - Set `burned_at = NOW()`
   - Insert into `burn_records`: `user_id`, `player_id`, `week`, `game_id`, `locked_at`, `burned_at`
   - Remove player from user's `available_pool` (or mark `pool_entries.burned = true, burned_at = NOW()`)
3. Dispatch burn confirmation notification to affected users
4. Update leaderboard scores (trigger scoring engine)

### 5.3 Burn record immutability

`burn_records` is write-once. No application code path may update or delete a burn record. The only authorized exception is a sysadmin-initiated SLOT_REOPENED event (see §6).

---

## 6. Game Disruption Handling

### 6.1 Game canceled before any plays are run

**Policy**: Player is un-burned AND slot reopens for reassignment.

**Mechanism**:
1. Sysadmin sets `game_windows.status = 'canceled'` via admin tool (not direct SQL)
2. Automated job runs on status change:
   - Find all `season_submissions` for this game_window with `locked_at IS NOT NULL` AND `burned_at IS NULL` — delete lock record (or set `locked_at = NULL`, `void_reason = 'GAME_CANCELED'`)
   - Insert `security_audit_log` entry: `event_type = 'SLOT_REOPENED'`, `game_id`, `user_id`, `slot_key`, `authorization_reference`
   - Restore player to user's available pool
   - Re-open slot for lineup editing (set `slot.editable = true` for remaining unlocked windows this week)
3. Push notification to all affected users within 1 hour
4. Player scores 0 for that slot if not reassigned before all remaining windows lock

**Edge case — MNF cancellation after all other windows have locked**: Slot reopens but no eligible players remain for reassignment. Player is un-burned and available next week. The slot scores 0 for this week. This must be displayed in UI and stated in T&C.

### 6.2 Game suspended mid-play, resumed later

Two-part criterion handles automatically. No special intervention. Burn fires when NFL posts Final. Payouts for that week are held until all games reach Final. T&C must state this explicitly.

### 6.3 Game rescheduled to different week

Treated as cancellation for original week. Player un-burned. Fresh burn decision applies in rescheduled week.

### 6.4 Game rescheduled within same week

`game_windows.scheduled_et` is updated to new scheduled kickoff. Push notification immediately. User retains full swap rights until new lock time.

### 6.5 Player changes teams mid-week (trade, release, signing)

**Policy (locked 2026-10-26):** the submission and the burn are bound to the **player**, not the team. A player locks, scores and burns on the game he actually plays that week.

**Mechanism:**
1. A roster-change check runs every Tuesday at 11:59 PM ET, after the NFL trade deadline passes for that week. The same check also runs after every nightly roster sync (Tech Summary §5), because waiver claims and free-agent signings move players after Tuesday.
2. For every `season_submissions` row in the current week with `locked_at IS NULL` and `void_reason IS NULL` whose player's team has changed since submission:
   - **New team plays this week, window still pending:** re-point `game_window_id` to the new team's game window. The slot now locks at the new window's `scheduled_et`. If the new team plays in the same window, only the game changes and the lock time does not.
   - **New team does not play this week, player is unsigned, or the new window has already locked:** void the submission (`void_reason = 'PLAYER_NO_GAME'`). The slot is editable, the player is not locked, scores 0 if not reassigned, and is not burned.
   - Insert a `security_audit_log` row (`event_type = 'SUBMISSION_REPOINTED'` or `'SUBMISSION_VOIDED'`, performed by the system user) and queue an email + in-app notification to the user: player, old and new team, and the new lock time or the voided slot.
3. Submissions already locked are never re-pointed. The lock stands, and the player scores and burns on the game he was locked to.

`PLAYER_NO_GAME` and `PLAYER_INACTIVE` are in the `void_reason` domain (PRD-006 migrations).

---

## 7. Database Schema — Burn Engine Tables

```sql
-- Player pool state per user per season
CREATE TABLE pool_entries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id),
  player_id     VARCHAR(50) NOT NULL,  -- MSF player ID
  season        VARCHAR(20) NOT NULL,  -- e.g. '2026-2027-regular'
  burned        BOOLEAN NOT NULL DEFAULT false,
  burned_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, player_id, season)
);
CREATE INDEX idx_pool_entries_user_season ON pool_entries(user_id, season, burned);

-- Game windows (one row per kickoff time block per week)
CREATE TABLE game_windows (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week          SMALLINT NOT NULL,
  season        VARCHAR(20) NOT NULL,
  label         VARCHAR(50) NOT NULL,  -- e.g. 'Sunday Early'
  scheduled_et  TIMESTAMPTZ NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending',
    -- pending | locked | final | canceled | postponed
  msf_game_ids  TEXT[] NOT NULL DEFAULT '{}',  -- MSF game IDs in this window
  final_posted_at TIMESTAMPTZ,
  CHECK (status IN ('pending','locked','final','canceled','postponed'))
);
CREATE INDEX idx_game_windows_status ON game_windows(status, scheduled_et);

-- Season-long submissions (immutable after lock)
CREATE TABLE season_submissions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  week            SMALLINT NOT NULL,
  season          VARCHAR(20) NOT NULL,
  slot_key        VARCHAR(10) NOT NULL,  -- qb|rb1|rb2|wr1|wr2|wr3|te|flex|k
  player_id       VARCHAR(50) NOT NULL,
  game_window_id  UUID NOT NULL REFERENCES game_windows(id),
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at       TIMESTAMPTZ,  -- set when game_window locks; NULL = not yet locked
  void_reason     VARCHAR(50),  -- GAME_CANCELED | ADMIN_VOID
  UNIQUE(user_id, week, season, slot_key)
);
CREATE INDEX idx_season_submissions_window ON season_submissions(game_window_id, locked_at);

-- Burn records (write-once; immutable)
CREATE TABLE burn_records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  player_id       VARCHAR(50) NOT NULL,
  season          VARCHAR(20) NOT NULL,
  week            SMALLINT NOT NULL,
  game_window_id  UUID NOT NULL REFERENCES game_windows(id),
  submission_id   UUID NOT NULL REFERENCES season_submissions(id),
  locked_at       TIMESTAMPTZ NOT NULL,
  burned_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, player_id, season)  -- one burn per player per season per user
);

-- Lock events (audit log for all lock fires)
CREATE TABLE lock_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_window_id  UUID NOT NULL REFERENCES game_windows(id),
  fired_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submissions_locked INTEGER NOT NULL,
  notifications_queued INTEGER NOT NULL
);

-- Slot reopen events (sysadmin-only write path; security audit)
CREATE TABLE security_audit_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type      VARCHAR(50) NOT NULL,
  game_id         UUID,
  user_id         UUID,
  slot_key        VARCHAR(10),
  authorization_reference VARCHAR(255),
  performed_by    UUID NOT NULL REFERENCES users(id),  -- admin user
  performed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata        JSONB
);

-- Weekly contest submissions (separate; burn isolation enforced here)
CREATE TABLE weekly_submissions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  contest_id      UUID NOT NULL,
  week            SMALLINT NOT NULL,
  season          VARCHAR(20) NOT NULL,
  slot_key        VARCHAR(10) NOT NULL,
  player_id       VARCHAR(50) NOT NULL,
  game_window_id  UUID NOT NULL REFERENCES game_windows(id),
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at       TIMESTAMPTZ,
  -- NOTE: weekly_submissions NEVER reference burn_records or pool_entries.
  -- Burn isolation is architectural, not just enforced by application logic.
  UNIQUE(user_id, contest_id, slot_key)
);
```

---

## 8. Notification Requirements

### 8.1 Lock notification

- **Trigger**: queued inside the same server transaction as the lock (not a deferred job); delivered after commit
- **Granularity**: one notification per user per game window, listing all of that user's players locked in the window
- **Channel**: push (Expo Push on iOS/Android; standard Web Push in browsers) + in-app badge
- **Content**: "🔒 [N] players locked for [Window]: [Player Name], [Player Name]. When their games go Final, they're burned." (v1.0 said "If [Team] wins, he's burned" — wrong: the burn fires on Final regardless of the result.)
- **Timing**: simultaneous with lock — the user cannot beat this notification

### 8.2 Burn confirmation

- **Trigger**: after `burned_at` is set and committed
- **Granularity**: one notification per user per game window, listing every player burned
- **Channel**: push + in-app + email summary (weekly)
- **Content**: "[Player Name], [Player Name] burned for the season. Removed from your available pool."

### 8.3 Proactive international / unusual time game alert

- **Trigger**: 48 hours before any game window with `scheduled_et` before 12:00 PM ET or after 9:00 PM ET
- **Content**: "Heads up: [Game] kicks off at [time] ET — your lineup locks then."

### 8.4 Delivery providers (locked 2026-10-26)

| Channel | Provider |
|---------|----------|
| Mobile push (iOS, Android) | Expo Push Service |
| Browser push | Standard Web Push (VAPID), no vendor |
| Email | SendGrid (existing account, burnoutfantasy.com sending domain) |
| In-app | Platform API |

OneSignal is not used at MVP: its free tier caps mobile push at 1,000 MAU as of Oct 1, 2026, below the Year 1 user target. The `notification_queue` outbox is provider-agnostic, so a provider change only replaces the dispatcher.

Push delivery is best-effort with every provider. The evidentiary record of a lock is the committed lock transaction, its `lock_events` row and the emailed lineup receipt, never the push itself. T&C language must say so.

---

## 9. Three-Gate Confirmation Flow

All season-long submissions must complete a three-gate flow before `season_submissions` is written:

| Gate | Mechanism | Requirement |
|------|-----------|-------------|
| Gate 1 | Review screen | Full 9-slot lineup displayed; game times shown for each player |
| Gate 2 | Three checkboxes | User explicitly acknowledges: (1) burn rules, (2) permanent nature, (3) no-refund policy |
| Gate 3 | Slide-to-confirm (mobile) / Press-and-hold (web) | Server-side timestamped event is the evidentiary record, not the input method |

The confirmation generates a `submission_receipts` record containing: `user_id`, `week`, `lineup_snapshot` (JSONB), `gate1_at`, `gate2_at`, `gate3_at`, `ip_address`, `user_agent`. This is the dispute-resolution artifact.

---

## 10. Player Selection Display Requirements

Every player card in the selection pool must display:

- Player name (text only — no headshots, no likenesses; NIL compliance)
- Team abbreviation
- Position
- Opponent (home/away)
- Scheduled game time ET
- Injury status (from MSF: Active / Questionable / Doubtful / Out / IR / PUP)
- Projected points
- Current week ownership % (from Redis cache; max 5-minute staleness)
- Season ownership % (how many users have burned this player this season)

---

## 11. Acceptance Criteria

An implementation is correct when all of the following are true:

1. **Lock fires at scheduled_et regardless of actual kickoff.** Verified by: set scheduled_et 1 minute in the future in test data; confirm lock fires; delay actual game start in mock MSF feed; confirm player remains locked.

2. **Burn requires both lock AND final.** Verified by: lock a player, confirm they are NOT burned; post Final in mock feed, confirm they ARE burned.

3. **Empty slot does not burn.** Verified by: leave a slot empty through a game window lock; confirm no burn_record is created for any player; confirm pool_entries unchanged.

4. **Weekly contest does not burn.** Verified by: submit a player in weekly_submissions for a game window; confirm no burn_record is created; confirm pool_entries unchanged.

5. **Game cancellation un-burns and reopens slot.** Verified by: submit player, fire lock, cancel game (before Final), confirm locked_at is voided, player returns to available pool, security_audit_log contains SLOT_REOPENED entry.

6. **burn_records is immutable.** Verified by: attempt UPDATE or DELETE via application layer; confirm rejection. No application-layer test path should be able to modify a burn_record without a corresponding security_audit_log entry.

7. **Lock notification fires in same transaction.** Verified by: confirm exactly one notification_queue entry per affected user, listing all their locked players, is created inside the lock transaction; confirm no orphaned notifications if transaction rolls back.

8. **Three-gate confirmation writes submission_receipts.** Verified by: complete a submission; confirm submission_receipts row exists with all three timestamps.

---

## 12. Out of Scope for PRD-001

- Scoring engine (PRD-002)
- Leaderboard (PRD-003)
- Payment processing / entry fees (PRD-004)
- Pri/Alt insurance mechanic (PRD-005 — P2)
- Standing markets / prediction exchange (PRD-010 — post-MVP)
- AI connector / MCP layer (PRD-011)
- Multi-sport (NBA/MLB/NHL) monthly burn (PRD-020 — Year 2)

---

*This PRD is authoritative. Implement against it exactly.*
*Disputes between this document and any earlier design doc: this document wins.*
*Last author: Burnout League engineering spec process, 2026-10-26*

---

## Change log

**v1.2 — 2026-10-27**
- §3.1, §3.1.1: FB eligible at RB/FLEX; Out and IR players unselectable (greyed, not burned); an Out/IR pick is voided before its lock
- §9 / AC8: resolved by PRD-006 — one receipt covers all nine rows via `season_submissions.receipt_id`

**v1.1 — 2026-10-26**
- §4.4, §8.1, §8.2: notifications batched to one per user per game window
- §8.1: corrected burn wording (burn fires on Final, not on a win)
- §6.5: new — player changes teams mid-week; submission and burn bound to the player
- §8.4: new — delivery providers (Expo Push, Web Push, SendGrid); OneSignal not used at MVP
- AC7: updated for per-user notifications
