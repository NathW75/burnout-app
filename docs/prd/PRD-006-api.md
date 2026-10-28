# PRD-006 — API, Accounts and Lineup Submission
**Burnout League · packages/api**
Version 1.12 · 2026-10-28
Status: APPROVED 2026-10-27 — scope and auth decisions locked by Nath (§3); rules calls Q1, Q2, Q4 resolved in v1.1

---

## 1. Purpose

This package is the HTTP API that the web portal and the mobile app call. It owns:

- accounts, sign-in, two-factor and step-up authentication;
- the NFL player table and roster sync from MySportsFeeds;
- the player pool and the three-gate lineup submission (PRD-001 §9);
- HTTP routes over the leaderboard (PRD-003) and payments (PRD-004);
- the worker that runs the scheduled jobs.

It computes no points, ranks or prizes. Those come from PRD-002, PRD-003 and PRD-004.

---

## 2. Definitions

| Term | Definition |
|------|-----------|
| **Session** | A random 256-bit token issued at sign-in. Only its SHA-256 hash is stored. It can be revoked at any time. |
| **Pending session** | A session where the password has been checked but the second factor hasn't been entered yet. It can only call the second-factor endpoint, and it expires after 5 minutes. |
| **Second factor** | A TOTP authenticator code, or a one-time backup code. SMS and passkeys come later (§6.4). |
| **Step-up** | A fresh second-factor check on the current session. It is required for every financial action and stays valid for 5 minutes (D15, PRD-004). |
| **Lineup confirmation** | One pass through the three gates. It produces a receipt and writes or updates the user's submissions for the week. |
| **Receipt** | The `submission_receipts` row for a confirmation: the full lineup, the server time of each gate, IP, user agent, and a SHA-256 checksum. |

---

## 3. Locked Decisions

| # | Decision | Source |
|---|----------|--------|
| D1 | **Revocable server-side sessions**, not JWTs. Idle timeout 24 h, hard limit 30 days. Logout, password change and suspension take effect at once. | Decision 2026-10-27 (supersedes Tech Summary §6.1 "JWT 24-hour") |
| D2 | Web sends the token as an httpOnly cookie. Mobile sends it as a bearer token. It is the same session either way. | Decision 2026-10-27 |
| D3 | ~~Signing up doesn't require two-factor.~~ **Amended by PRD-007 §8.6 (v1.6): every account needs a confirmed second factor to use the API.** Enrolment is part of sign-up; until it's done the session is enrollment-only (§6.9). | Decision 2026-10-27 |
| D4 | This build has TOTP plus backup codes. Twilio SMS and WebAuthn passkeys are specified behind the same factor interface and built later. | Decision 2026-10-27 |
| D5 | Scope is auth, the player table and roster sync, the player pool, the three-gate lineup flow, and leaderboard, payments and admin routes. | Decision 2026-10-27 |
| D6 | Passwords are hashed with bcrypt, cost 12. | Tech Summary §6.1 |
| D7 | Step-up is required for every financial action, whatever the session age. | T&C §3.3 |
| D8 | NIL: players are referenced in text only. No headshot, image or likeness field is ever stored or returned. | Build constraints |
| D9 | Lineups lock at `scheduled_et`, and actual kickoff is never used. A submission after `scheduled_et` is rejected even if the lock job hasn't run yet. | PRD-001 §4 |
| D10 | Every season-long submission goes through the three gates. The server's timestamps are the evidence. | PRD-001 §9 |
| D11 | Weekly-contest routes never touch season submissions (burn isolation). This build has no weekly-contest routes. | PRD-001 §3.3 |

---

## 4. Conventions

- **Base path and format:** all routes live under `/v1` and speak JSON. Money is in integer cents, times are ISO-8601 UTC, and IDs are UUIDs.
- **Validation:** every request body and parameter is checked with zod. A failure returns `400 { error: "VALIDATION", issues }`.
- **Errors:** responses look like `{ error: CODE, message }`. The status codes are:

| Status | Used for |
|--------|---------|
| 400 | Malformed request |
| 401 | Not signed in |
| 403 | Signed in but not allowed: `STEP_UP_REQUIRED`, `MFA_ENROLLMENT_REQUIRED`, `EMAIL_UNVERIFIED`, `FORBIDDEN`, `CSRF` |
| 404 | Not found, or not yours. The two are indistinguishable on purpose. |
| 409 | State conflict, such as a payments code or a gate out of order |
| 422 | Lineup validation failed. Each error carries its slot and code. |
| 429 | Rate limited |

- **Account enumeration:** sign-in failures and the password-reset request never reveal whether an email exists. Signup with an existing email returns the same response as a new signup and emails the owner instead.
- **Secret fields:** `password_hash`, factor secrets and session tokens never appear in a response. The one exception is the issuing response, which carries the token once. Logs follow the same rule.

---

## 5. Sessions (D1, D2)

1. **Issuing:** sign-in creates a `sessions` row holding the token's SHA-256 hash, `user_id`, `client` (web or mobile), IP, user agent, `created_at`, `last_seen_at`, `expires_at` (+30 days), `mfa_pending` and `step_up_at`.
2. **Web cookie:** named `bl_session`, with `HttpOnly`, `Secure` in production, `SameSite=Lax` and `Path=/`.
3. **Mobile:** the token comes back once in the response body and is sent as `Authorization: Bearer <token>`.
4. **Validity:** a session is valid when it isn't revoked, `now < expires_at`, `now − last_seen_at < 24 h`, and the user is `active`. `last_seen_at` is refreshed at most once every 5 minutes.
5. **Cache:** valid sessions are cached in Redis for up to 60 seconds, keyed by token hash. Revoking a session deletes its cache key in the same request, so revocation takes effect at once. When Redis is down, the API falls back to Postgres.
6. **Revocation:** these events revoke sessions:
   - logout (this session) and logout-all;
   - password change (every other session);
   - password reset (every session);
   - suspension (every session);
   - deleting a session from the session list.
7. **CSRF protection:** cookie-authenticated requests that change state (POST, PUT, PATCH, DELETE) must send `X-Burnout-CSRF: 1`. If they carry an `Origin` header, it must be on the CORS allowlist. Bearer requests are exempt, because the browser never sends them automatically.

---

## 6. Accounts and Second Factors

### 6.1 Signup and email

- **`POST /v1/auth/signup { email, password, handle, turnstileToken }`:**
  - With `TURNSTILE_SECRET_KEY` set, the Cloudflare Turnstile token is verified server-side first. A missing or failed token returns `400 TURNSTILE_FAILED` before anything is created; Cloudflare being unreachable also fails (closed). No secret means no check (local and tests). PRD-007 §8.4.
  - The email is stored lower-cased, and the password must be 12 to 128 characters.
  - The handle follows PRD-003 §7 and is recorded in handle history as the signup handle. A taken handle returns `409` (handles are public, so this reveals nothing about emails).
  - The response is **`202` whether or not the email already exists**, and it does not sign the user in. A new account gets a verification email; an existing one gets an "you already have an account" email. The client calls `/auth/login` next, and sign-in works before the email is verified. This is the only way the "same response" rule (§4) can hold, because a signed-in session can't be faked for an existing email.
- **Email verification:**
  - A single-use token is valid for 48 hours. Only its hash is stored.
  - It is sent by the `Mailer` after commit, and it is never written to the notification outbox.
- **A verified email is required** for checkout, payout setup and instant payouts.

### 6.2 Sign-in

- **`POST /v1/auth/login { email, password, client }`:**
  - Wrong email and wrong password give the same `401 INVALID_CREDENTIALS`.
  - With no factor enrolled, an **enrollment-only** session is issued and the response says `{ mfaEnrollmentRequired: true }` (§6.9).
  - With a factor enrolled, a *pending* session is issued and the response says `{ mfaRequired: true }`.
- **`POST /v1/auth/login/mfa { code }`** turns a pending session into a full one. Five wrong codes revoke the pending session. A correct code is a fresh second-factor check, so it also sets `step_up_at` (§6.5).
- **Rate limits** (Redis counters, all returning a generic `429`):
  - 5 failed sign-ins per email in 15 minutes;
  - 20 per IP in 15 minutes;
  - 5 wrong codes per step-up window.

### 6.3 TOTP (RFC 6238)

- **Algorithm:** SHA-1, 6 digits, 30-second step, accepting ±1 step of clock drift. It is implemented on Node `crypto` and verified against the RFC 6238 test vectors.
- **Setup:** `POST /v1/auth/mfa/totp/setup { password }` re-checks the password and creates an unconfirmed factor. It returns the base32 secret and an `otpauth://` URI for the QR code.
- **Confirm:** `POST /v1/auth/mfa/totp/confirm { code }` activates the factor and returns **10 backup codes, shown once**. Only their hashes are stored, and each works once.
- **Encryption at rest:** secrets are encrypted with AES-256-GCM using `TOTP_ENCRYPTION_KEY` (a Railway env var).
- **Replay protection:** the last accepted time step is stored, so a code can't be used twice, not even once for sign-in and again for step-up.
- **Setup needs a verified email** (`EMAIL_UNVERIFIED`), so sign-up runs: account → verify → authenticator → backup codes.
- **Changes:** replacing the factor or regenerating backup codes requires step-up. Removing the only factor isn't self-service; it is an admin reset (§6.7) after an identity check.

### 6.4 Later factors (specified, not built)

| Factor | Plan |
|--------|------|
| SMS | Twilio Verify, behind the same `SecondFactor` interface. Offered as a fallback, never as the only factor on an account with money on it. |
| Passkey | WebAuthn / FIDO2 for Face ID, Touch ID and device passkeys. Counts as a second factor for step-up. |

### 6.5 Step-up (D7)

- **`POST /v1/auth/step-up { code }`** takes a TOTP code or a backup code and sets `sessions.step_up_at`.
- **Financial routes check, in order:**
  1. email verified (`EMAIL_UNVERIFIED`);
  2. a factor enrolled (`MFA_ENROLLMENT_REQUIRED`);
  3. `now − step_up_at ≤ 5 min` (`STEP_UP_REQUIRED`).
- **Timestamp:** the session's `step_up_at` is what's passed to PRD-004 as `stepUpAt`.

### 6.6 Passwords

- `POST /v1/auth/password/change { currentPassword, newPassword }` revokes every other session.
- `POST /v1/auth/password/reset-request { email }` always returns `202`. A single-use reset token, valid for 1 hour, is sent by the `Mailer`.
- `POST /v1/auth/password/reset { token, newPassword }` revokes every session.

### 6.7 Roles and suspension

- `users.role` is `user` or `admin`. Admin routes require the admin role **and** step-up.
- `users.status` is `active` or `suspended`. A suspended user's sessions are refused.
- **Factor reset** (`POST /v1/admin/users/:id/factors/reset { reason }`, PRD-007 §8.6): disables the user's factors, revokes their backup codes and sessions, writes `MFA_RESET` with the admin's reason, and emails the user. Their next sign-in is enrollment-only. An admin can't reset their own factors (`409 SELF_RESET`).

### 6.8 Audit

`security_audit_log` (now append-only) gets one row for each of these events:

| Event |
|-------|
| `LOGIN` |
| `LOGIN_FAILED` |
| `LOGOUT` |
| `SESSIONS_REVOKED` |
| `PASSWORD_CHANGED` |
| `PASSWORD_RESET` |
| `TOTP_ENROLLED` |
| `BACKUP_CODES_REGENERATED` |
| `BACKUP_CODE_USED` |
| `STEP_UP` |
| `STEP_UP_FAILED` |
| `LINEUP_CONFIRMED` |
| `SUBMISSION_REPOINTED` |
| `SUBMISSION_VOIDED` |
| `ADMIN_ACTION` |
| `MFA_RESET` |
| `PLAYER_MERGED` |

Events with no known user are recorded under the system user (all-zero UUID).

### 6.9 A second factor for all use (PRD-007 §8.6)

- A signed-in session without a confirmed factor is **enrollment-only**. A router-level gate runs before every handler and answers it `403 MFA_ENROLLMENT_REQUIRED` (or `EMAIL_UNVERIFIED` first, while the email is unverified), except on the sign-up steps:
  - `POST /auth/signup`, `/auth/verify-email`, `/auth/verify-email/resend`, `/auth/login`, `/auth/login/mfa`, `/auth/logout`, `/auth/logout-all`, `/auth/password/reset-request`, `/auth/password/reset`, `/auth/mfa/totp/setup`, `/auth/mfa/totp/confirm`
  - `GET /me` (reports `mfaEnrolled: false`), `GET /time`, `POST /feedback`
- Confirming the factor unlocks the same session at once.
- The test suite enumerates every route from the router, so a new route can't skip the gate.

---


### 6.10 Invite-only sign-up (decided 2026-10-28)

While testing, sign-up can require a per-person, single-use invite code (Nath: "invite code to limit via allow list").

- **Setting:** `SIGNUP_INVITE_ONLY` (`on` in staging; production decided before launch). `GET /v1/auth/signup-config` (public) tells the form `{ inviteOnly }`.
- **Codes:** 10 characters from Crockford base32 (no I, L, O, U), shown as `7KX2M-QW9TD`, 50 bits. Stored only as a SHA-256 hash; the code is shown once, when made. Input is forgiving: case, spaces and dashes are ignored, O reads as 0 and I or L as 1.
- **Rules:** a code works once; it can be tied to one email (case-insensitive); it can expire (default 14 days, 1–90, or none) and be revoked while unused. A bad, used, expired, revoked or wrong-email code is `400 INVITE_INVALID`, decided before anything about the email, so it reveals nothing about accounts. An email that already has an account gets the usual "you already have an account" email and the code is **not** spent. The code is spent in the same transaction that creates the account; two sign-ups racing for one code create one account.
- **Admin:** `POST /v1/admin/invites { email?, note?, expiresInDays? }` → `{ id, code, link, email, expiresAt }` (the link is `/signup?invite=CODE`); `GET /v1/admin/invites` (no codes; status active, used, revoked or expired, and who used it); `POST /v1/admin/invites/:id/revoke`. Admin + step-up; creation and revocation are audited (`ADMIN_ACTION`).
- **Web:** the sign-up form shows an "Invite code" field when invite-only and fills it from the link; Account → Admin → Invites (admins only).

## 7. NFL Players and Roster Sync

### 7.1 `nfl_players`

| Column | Notes |
|--------|-------|
| `msf_player_id` | Primary key |
| `first_name`, `last_name` | |
| `position` | QB, RB, WR, TE, K or FB |
| `team` | Abbreviation, or null when unsigned |
| `roster_status` | |
| `injury_status` | Active, Questionable, Doubtful, Out, IR or PUP |
| `updated_at` | |

There are no image, headshot or URL columns, and a schema test enforces this (D8). The parser drops every other field the feed carries, image URLs included.

### 7.2 Games know their teams

`nfl_games` gains `home_team` and `away_team`, filled by the PRD-002 schedule ingest. A player's game window for a week is found from his current team, through that team's game that week, to its `game_window_id`. A player with no game that week is on bye.

### 7.3 Sync and re-resolve (PRD-001 §6.5)

**Sync:** `syncPlayers(feed)` upserts `nfl_players` from the MSF `players` feed (`players.json`, no season parameter: current rosters, about 10,000 players including free agents with no team). It runs nightly at 3:00 AM ET and at Tuesday 11:59 PM ET. Roster status `INJURY_LIST` maps to IR.

**Injuries:** `syncInjuries(feed)` applies the `injuries.json` feed every 15 minutes Wednesday–Sunday. That feed lists every currently injured player as flat player objects. Listed players take its designation; anyone else still marked injured has recovered and goes back to Active. An empty feed is treated as a glitch and changes nothing. Re-resolve runs after each injuries pass.

**Re-resolve:** `reresolveSubmissions(season, week)` then runs. For every submission this week that is not locked and not voided, it re-derives the player's window from his current team:

| Situation | Action |
|-----------|--------|
| Same window | Nothing |
| A different window that is still pending | Re-point `game_window_id`, write `SUBMISSION_REPOINTED` to the audit log, and notify the user |
| No game this week, unsigned, or the new window has locked | Void with `void_reason = 'PLAYER_NO_GAME'`, write `SUBMISSION_VOIDED` to the audit log, and notify the user |

Before the window check, a submission whose player is now **Out or IR** is voided with `PLAYER_INACTIVE` (PRD-001 §3.1.1), and the user is notified.

Locked submissions are never touched. The same re-resolve also covers a game moving to another window within the week (PRD-001 §6.4). With no schedule loaded for the week, only the Out/IR rule runs; nothing is voided for missing schedule data.

**Feed fallback:** if the subscription doesn't include the `players` feed (HTTP 403), the job reads `{season}/player_stats_totals.json`, which carries the same player objects. That feed only lists players with stats, so it is never treated as a complete roster: nobody is unrostered because they're missing from it.

### 7.4 MSF access

Only the worker calls MSF, with `MSF_API_KEY` from env using Basic auth (`key:MYSPORTSFEEDS`). The key is never logged.

### 7.5 One person, one player (decision 2026-10-28)

MySportsFeeds sometimes lists the same person under two IDs (on 2026-10-28: Brandon Smith, WR PIT, as 30297 and 112299, same birth date and college, different jersey numbers). Treated as two players, he could be burned under one ID and played again under the other. After every roster sync, and at worker startup:

- **Same person** = same name and same birth date. Also same name, team and position when a birth date is missing, as long as no two of them have different birth dates; these merges go on a review list. Different birth dates are never merged. Names compare without case, accents, punctuation or suffixes (Jr., Sr., II–V). The birth date is read from the feed for this check only and is **never stored**.
- **One ID is kept** (`nfl_players.canonical_id IS NULL`): the one already kept, else the one on a team, else the one with game stats, else the oldest. The rest become aliases (`canonical_id` → the kept ID). A kept ID never changes automatically.
- **Aliases never play:** they're left out of the player pool and of the lineup checks, and a database trigger refuses any `season_submissions` row (insert, or change of player) that names one. No chains: an alias points at a kept ID, and a kept ID with aliases can't become one.
- **Burns follow the person** (PRD-001 §5.4): a burn under any of a person's IDs makes him burned for that manager.
- **Open picks move:** an unlocked pick on a new alias moves to the kept ID. If the manager already has that person in another slot that week, the alias pick is voided (`PLAYER_MERGED`) and the manager is notified. Locked picks are never touched.
- **Stats follow the person:** the scoring job scores stats posted under an alias under the kept ID; if both IDs have a line for the same game, the kept ID's own line wins.
- **Admin:** `GET /v1/admin/players/identities` lists the merges and how many await review. `POST /v1/admin/players/:id/identity { canonicalId, reason }` merges a player into a kept ID by hand, or splits him out with `canonicalId: null`. Admin decisions (`identity_source = 'manual'`) are never changed by the sync. Every merge is audited (`PLAYER_MERGED`, or `ADMIN_ACTION` with the reason).

On the 2026-10-27 feed this merges 24 pairs. Six involve a rostered player: Brandon Smith (PIT), plus a rostered record and a stale free-agent copy for Jackson Acker (SEA), Mark Gronowski (HOU), Jackson Meeks (DET), Ted Hurst (TB) and Trent Sherfield (BUF).

---

## 8. Player Pool

`GET /v1/seasons/:season/weeks/:week/pool` returns one card per fantasy-eligible player (PRD-001 §10). The card fields:

| Field | Notes |
|-------|-------|
| `playerId`, `name`, `team`, `position` | Text only |
| `opponent`, `homeAway`, `scheduledEt` | Null on bye, with `bye: true` |
| `injuryStatus` | |
| `projectedPoints` | Null until a projections feed is chosen (§17) |
| `weekOwnershipPct`, `seasonOwnershipPct` | |
| `burnState` | `available`, `locked` (locked in the caller's lineup this week) or `burned` (by the caller this season) |
| `selectable`, `unavailableReason` | `false` → shown greyed out, with `BURNED`, `LOCKED`, `INACTIVE` (Out/IR: greyed but never burned), `BYE` or `WINDOW_CLOSED` |

**Ownership:**
- Week ownership is the share of this week's submitters who submitted the player.
- Season ownership is the share of users with any burn who have burned the player.
- Both are cached in Redis for 5 minutes (PRD-001 §10).

**Available pool:** eligible players minus the caller's burned players. A `pool_entries` row is created for a player the first time the user submits him, because the burn foreign key needs it.

---

## 9. Three-Gate Lineup Submission (PRD-001 §9)

### 9.0 Who may submit (locked 2026-10-27)

- **Free play:** anyone may submit lineups without paying. Free players can't win prizes.
- **Cutoff:** once a season has published paid pools, free play ends at the paid-entry cutoff (the earliest pool `entry_closes_at`, set to the **Week 3 lock**). A user without an active paid entry may submit only weeks **before** the cutoff week, so free play is Weeks 1–2. After that, review and confirm return `403 PAID_ENTRY_REQUIRED`. Both gates check it.
- **Late payers:** paying before the cutoff unblocks play and prize eligibility, with prize standings from the week of payment (PRD-003 §3).
- **No paid pools:** in a season without published paid pools (the 2026 test season), everyone plays free all season.
- `GET …/lineup` returns `eligibility: { prizeEligible, freePlayThroughWeek }` so clients can show it.

### 9.1 Gate 1 — Review

`POST /v1/seasons/:season/weeks/:week/lineup/review { slots }`:

1. **Merge:** the server merges in the user's **locked** slots, which can't change. Sending a different player for a locked slot returns `422 SLOT_LOCKED`.
2. **Validate:** it runs the PRD-001 validator (`validateLineupDraft`) on the unlocked slots, checking:
   - every slot filled (`SLOT_EMPTY`);
   - no duplicates (`DUPLICATE_PLAYER`);
   - the player isn't burned (`PLAYER_BURNED_OR_UNAVAILABLE`);
   - the player exists (`PLAYER_NOT_FOUND`);
   - the position fits the slot (`POSITION_INELIGIBLE`);
   - the player isn't listed Out or IR (`PLAYER_INACTIVE`; PRD-001 §3.1.1);
   - the player has a game this week (`PLAYER_ON_BYE`);
   - the window is still open (`GAME_WINDOW_LOCKED`). A window counts as locked once `now ≥ scheduled_et`.
3. **Empty slots:** a slot may be left empty only when it is empty now (for example, voided) and no window in the week is still pending.
4. **Create the confirmation:** it writes a `lineup_confirmations` row with `gate1_at = now`, which expires 10 minutes later.
5. **Response:** the review screen data, with each slot's player, team, opponent, scheduled time and locked flag.

### 9.2 Gate 2 — Acknowledge

`POST /v1/lineup-confirmations/:id/acknowledge { burnRules: true, permanent: true, noRefund: true }` requires all three acknowledgements to be true and sets `gate2_at`.

### 9.3 Gate 3 — Confirm

`POST /v1/lineup-confirmations/:id/confirm` sets `gate3_at = now`. In **one transaction**, it:

1. **Locks the windows:** it locks every game window involved (`FOR SHARE`), the windows of both the old and the new players. It then re-checks that each changed slot's window is still `pending` with `scheduled_et > now`. A concurrent lock job therefore either commits first, and the confirm is rejected, or waits and then locks the new rows.
2. **Writes the slots:** it inserts or updates each unlocked slot, setting player, window, `submitted_at`, `receipt_id`, and `void_reason = NULL`. Locked slots aren't written.
3. **Writes the receipt:** it inserts `submission_receipts` with:
   - `submission_id` = the confirmation ID;
   - `lineup_snapshot`;
   - `lineup_sha256`;
   - the three gate timestamps;
   - IP and user agent.
4. **Pool entries:** it upserts `pool_entries` for the submitted players.
5. **Audit:** it writes `LINEUP_CONFIRMED`.
6. **Receipt email:** it queues a `LINEUP_RECEIPT` notification carrying the checksum, to be emailed by SendGrid.

Gates must happen in order, once each, before expiry. Anything else returns `409`.

### 9.4 Checksum

`lineup_sha256` = SHA-256 of this canonical JSON (no spaces):

```
{"userId", "season", "week", "gate3At", "slots": [{"slot", "playerId", "gameWindowId", "locked"} in slot order qb, rb1, rb2, wr1, wr2, wr3, te, flex, k]}
```

The user can recompute it from their email.

### 9.5 Database guards

- `submission_receipts` is append-only.
- A **locked** `season_submissions` row rejects every UPDATE, except the PRD-001 §6.1 slot reopen (`locked_at → NULL` with a void reason, under its audit setting).
- `season_submissions.receipt_id` references the receipt that last wrote the row.
- This resolves PRD-001 AC8's open question: one receipt covers many submission rows.

---

## 10. Routes

### 10.1 Auth and account

| Route | Notes |
|-------|-------|
| `POST /v1/auth/signup` | |
| `POST /v1/auth/login` | |
| `POST /v1/auth/login/mfa` | |
| `POST /v1/auth/logout` | |
| `POST /v1/auth/logout-all` | |
| `POST /v1/auth/verify-email` | |
| `POST /v1/auth/verify-email/resend` | |
| `POST /v1/auth/password/change` | |
| `POST /v1/auth/password/reset-request` | |
| `POST /v1/auth/password/reset` | |
| `POST /v1/auth/mfa/totp/setup` | |
| `POST /v1/auth/mfa/totp/confirm` | |
| `POST /v1/auth/mfa/backup-codes/regenerate` | Step-up |
| `POST /v1/auth/step-up` | |
| `GET /v1/me` | |
| `GET /v1/me/sessions` | |
| `DELETE /v1/me/sessions/:id` | |
| `PUT /v1/me/handle` | |
| `POST /v1/feedback { body }` | 1–2,000 characters; screen from `X-Current-Screen`; 10 per user per hour; allowed for enrollment-only sessions. Returns `201 { id }` (PRD-007 §10) |

### 10.2 Players and lineups

| Route |
|-------|
| `GET /v1/seasons/:season/weeks/:week/pool` |
| `GET /v1/seasons/:season/weeks/:week/lineup` |
| `POST /v1/seasons/:season/weeks/:week/lineup/review` |
| `POST /v1/lineup-confirmations/:id/acknowledge` |
| `POST /v1/lineup-confirmations/:id/confirm` |
| `GET /v1/receipts/:id` |

### 10.2.1 Web app reads (PRD-007 §8)

| Route | Notes |
|-------|-------|
| `GET /v1/time` | `{ serverTime }`. Public, `Cache-Control: no-store`: the official clock |
| `GET /v1/seasons/current` | `{ season, currentWeek, weeks: [{ week, firstLock, lastLock, status }] }`. The current week is the next week with a window still to lock; status is `upcoming`, `live` or `complete` |
| `GET /v1/seasons/:season/weeks/:week/windows` | `{ windows: [{ id, label, scheduledEt, status, games: [{ away, home }] }] }` in kickoff order |
| `GET /v1/seasons/:season/leaderboard?offset&limit` | Season field board: everyone with a confirmed lineup, ranked on season centipoints with `RANK()` (ties share a rank, display order by handle), my row pinned as `me`. Handles only. Cached in Redis for 30 s; `ETag` / `304` |
| `GET /v1/seasons/:season/leaderboard/me` | My field row (or `null`) and the field size |
| `GET /v1/seasons/:season/weeks/:week/managers/:handle/lineup` | Post-lock reveal: another manager's **locked, non-voided** slots only, filtered in SQL; the rest come back `HIDDEN` with no player. My own lineup in full (`SUBMITTED`, `LOCKED`, `VOIDED`, `EMPTY`). `LOCKED` slots carry `burned` |
| `GET /v1/me/burns?season=` | Every burned player: week, slot, name, position, team, points, window, burned time |
| `GET /v1/me/notifications?before&limit` | Inbox, newest first, with `unread`, `players` (`{ [playerId]: { name, position, team } }` for players the notices name) and `nextBefore` (an opaque time-and-id cursor; a bare timestamp is also accepted) |
| `POST /v1/me/notifications/read` | `{ ids }` or `{ all: true }`; my items only. Read state (`read_at`) is separate from delivery (`dispatched_at`) |
| `GET /v1/me/notification-preferences` | PRD-008 §6, §9: `{ emailNotifications, email: { locks_burns, lineup_changes, receipts }, push: { …same groups } }` (emailNotifications is on or off and doesn't affect push); no stored choice = the default (on) |
| `PUT /v1/me/notification-preferences` | Any of `emailNotifications`, `email.{group}` and `push.{group}`; groups are stored per kind and channel |
| `GET /v1/push/config` | Public. PRD-008 §9: `{ enabled, publicKey }`; enabled only when `NOTIFY_PUSH=on` and the VAPID key is set |
| `POST /v1/me/push-subscriptions` | `{ endpoint, keys: { p256dh, auth } }` → 201 `{ subscribed, devices }`. Endpoint must be https on a known push service (400 `PUSH_ENDPOINT_NOT_ALLOWED`); 409 `PUSH_OFF` when push is off. Upsert by endpoint: a browser that changes accounts moves |
| `DELETE /v1/me/push-subscriptions` | `{ endpoint }` → `{ removed, devices }`; only the owner's device. Signing out everywhere (logout-all, password reset, suspension) also turns off every device |
| `POST /v1/notifications/unsubscribe?token=` | Public, no session (RFC 8058 one-click; mail providers post a form body). The signed token's only power is turning optional email off. 400 `TOKEN_INVALID` for a bad token; 30/min per IP |
| `GET /v1/admin/notifications/stats` | Admin + step-up: last 24 hours by kind and result, oldest pending notice |
| `GET /v1/auth/signup-config` | Public: `{ inviteOnly }` (§6.10) |
| `POST /v1/admin/invites` | Admin + step-up: a single-use invite code, shown once (§6.10) |
| `GET /v1/admin/invites` | Admin + step-up: invites with status and who used them (no codes) |
| `POST /v1/admin/invites/:id/revoke` | Admin + step-up: revoke an unused invite |
| `GET /v1/me/receipts?season=` | Receipt summaries `{ id, week, confirmedAt, sha256 }`, newest first |

### 10.3 Leaderboard

| Route | Notes |
|-------|-------|
| `GET /v1/pools?season=` | |
| `GET /v1/pools/:id/board` | Supports `offset`, `limit` and `ifVersion` |
| `GET /v1/pools/:id/me` | |
| `GET /v1/pools/:id/weeks/:week` | |
| `GET /v1/pools/:id/entries/:entryId/weeks/:week/lineup` | |

### 10.4 Payments

| Route | Gate |
|-------|------|
| `GET /v1/pools/:id/prizes` | |
| `POST /v1/pools/:id/checkout` | Financial |
| `GET /v1/me/payouts` | |
| `POST /v1/me/payout-account/link` | Financial |
| `GET /v1/me/payouts/:id/instant-quote` | |
| `POST /v1/me/payouts/:id/instant` | Financial |
| `POST /v1/webhooks/:processor` | Raw body; signature checked by the adapter |

**Checkout location:** the IP region comes from the trusted edge header (`cf-region-code` with `cf-ipcountry = US`, from Cloudflare's visitor-location headers). If the header is missing, or the country isn't US, the region is treated as unknown, which PRD-004 §11.2 blocks by default.

**Edge trust.** Railway's own address can be reached without Cloudflare, so the cf-* headers count only on a request that carries the edge secret. Cloudflare adds it on every proxied request (Transform Rule, header `X-Burnout-Edge`, value `EDGE_SHARED_SECRET`). The first middleware (`edgeGuard`) compares it in constant time and removes it from the request:

- **Verified:** the location headers stand, and the client IP is `cf-connecting-ip` when that is a valid IP, so rate limits and the audit log see the visitor rather than a Cloudflare node.
- **Not verified:** `cf-ipcountry`, `cf-region-code` and `cf-connecting-ip` are deleted. Checkout then sees an unknown region and blocks it, and the client IP is the address Railway's edge saw (`TRUST_PROXY=1`).
- **Secret unset in production:** nothing is trusted, and a warning is logged at startup. Only local and test setups run with no edge check at all.

Setup: `docs/deploy/RAILWAY.md`.

### 10.5 Admin (admin role + step-up)

| Route |
|-------|
| `POST /v1/admin/pools/:id/publish` |
| `POST /v1/admin/pools/:id/settlement/compute` |
| `POST /v1/admin/pools/:id/settlement/approve` |
| `GET /v1/admin/integrity` |
| `POST /v1/admin/transfers` |
| `POST /v1/admin/identity-verifications` (manual verification until an identity provider is chosen) |
| `POST /v1/admin/users/:id/suspend` |
| `POST /v1/admin/users/:id/factors/reset` (§6.7) |
| `GET /v1/admin/feedback?reviewed&category&severity&before&limit` |
| `POST /v1/admin/feedback/:id/review { reviewed }` |
| `GET /v1/admin/players/identities` (§7.5) |
| `POST /v1/admin/players/:id/identity { canonicalId, reason }` (§7.5) |

### 10.6 Ops

`GET /healthz` checks the database and Redis.

**Rate limits:**
- 300 requests per minute per IP overall;
- 10 per minute per IP on signup and password-reset requests;
- the sign-in limits in §6.2.

---

## 11. Worker

`node dist/worker.js` runs these jobs:

| Job | When |
|-----|------|
| Lock check (PRD-001), with the leaderboard `afterLock` hook | Every minute |
| `payments.runJobs()` (PRD-004) | Every minute |
| Scoring cycle (PRD-002): fetch the current week's games and gamelogs, ingest, evaluate burns for windows whose games are all Final, freeze due weeks with the leaderboard `afterFreeze` hook | Every 15 minutes during active windows, otherwise hourly |
| Roster sync and re-resolve (§7.3) | 3:00 AM ET nightly and Tuesday 11:59 PM ET |
| Injury reports and re-resolve (§7.3) | Every 15 minutes Wednesday–Sunday (Tech Summary §5) |
| Season schedule import and re-resolve (§11.6) | At worker startup, then hourly at :30 |
| Feedback tagging (PRD-007 §10): up to 10 untagged items per run through the Anthropic Messages API (`FEEDBACK_MODEL`); the reply is validated against the spec's schema; the feedback text is fenced as untrusted input and never logged; 3 attempts per item | Every 15 seconds, only when `ANTHROPIC_API_KEY` is set (quiet when idle) |
| Notice email (PRD-008 §7): claims due notices (`FOR UPDATE SKIP LOCKED` plus a claim time), skips stale, turned-off and unusable-account ones, sends one email per user, retries with backoff, records the result | Every 30 seconds, only when `NOTIFY_EMAIL=on` (quiet when idle); logs an error when the oldest pending notice is over 10 minutes old |

Each job:
- runs under a Postgres advisory lock, so two workers never run it at once;
- logs a JSON line;
- survives the failure of any other job.

**Scoring and refused feeds (v1.8).** The scoring cycle works through the active weeks newest first. Each MSF read that is refused with 403, 429 or 5xx is retried once after 2 seconds (MSF throttling shows up as 403). If a week's feed is still refused, that week is skipped for this run: an error line names the week and the HTTP status, the result lists it as `failed`, and the other weeks go on to ingest and burn. Staging on 2026-10-28 showed why this matters: an intermittent 403 on an old week's feed stopped every scoring run for about three hours.

### 11.6 Season schedule import

The `schedule` job builds `game_windows` and `nfl_games` from the MySportsFeeds season schedule (`{season}/games.json`). If the subscription doesn't include it (`403`), the job uses the 18 weekly `games.json` feeds instead, skipping any week that returns `404`. An empty feed changes nothing.

**One window per exact scheduled kickoff, per week.** Each window locks at precisely its games' scheduled time (hard constraint 4), so a Sunday with 4:05 and 4:25 games has two late windows. Labels give the day, the block and the kickoff in Eastern Time, e.g. "Sunday Late · 4:25 PM" or "Sunday Morning · 9:30 AM" (international games).

**Frozen windows never change.** A window is frozen once it is no longer `pending`, or once its kickoff has arrived. The import never moves, refills or deletes a frozen window. The database enforces this: a trigger rejects any change to the kickoff, week or games of a non-pending window, and any deletion of one (`WINDOW_SCHEDULE_FIXED`). Status changes still work.

**Pending windows follow the feed:**

- A game whose kickoff moves goes into the window for its new kickoff, which is created if needed. A window's own kickoff never changes, so a lock time can't silently move.
- A postponed or canceled game (`scheduleStatus` POSTPONED / CANCELED) leaves its window, so its players have no game that week.
- A DELAYED game keeps its window: a delay is a late kickoff, not a new scheduled time.
- A game moving onto a frozen window's kickoff never joins it. It stays in its current window and is reported.
- A game the feed no longer lists stays where it is and is reported, so a partial feed can't empty the schedule.

**Picks follow their games.** After any change, the import runs the §7.3 re-resolve for the current week. Picks on a moved game are re-pointed to its new window, or voided `PLAYER_NO_GAME` if the game left the week or its new window has closed. The user is notified either way (PRD-001 §6.4/§6.5).

**Emptied windows** are deleted when nothing references them. They are set to `postponed` (never locks) when only voided picks do, and reported if live picks still point at them.

**Review, not action:** the import logs a `schedule imported` warning listing anything it won't decide on its own:

- `LOCKED_GAME_MOVED`: the feed moved a game whose window is frozen.
- `LOCKED_GAME_OFF_SCHEDULE`: the feed postponed or canceled a frozen game. Cancelling a locked game is an admin action (PRD-001 §6.1).
- `GAME_MISSING_FROM_FEED`: a game we hold is no longer in the feed.
- `UNKNOWN_SCHEDULE_STATUS`: the game is kept in its window; check what the status means.
- `EMPTY_WINDOW_HAS_LIVE_PICKS`: every game left a window that still has unlocked picks.

**Canceled windows are history.** Once an admin cancels a locked game, the feed can place that game again in the week it moved to (PRD-001 §6.3). Scoring maps a game to its live window in preference to a canceled one.

**Backfill.** On a first import mid-season, past weeks' windows arrive as `pending` with kickoffs in the past. The ordinary lock job claims them, the scoring job pulls their games and gamelogs, and the burn step finalizes them. Earlier weeks' history fills in with no separate code path.

**Late entry close (PRD-004 D7).** Publishing a pool sets its `entry_closes_at` to the first live Week 3 window's kickoff once the schedule is imported, whatever the draft said. A pool can't be published after that point (`409 ENTRY_CUTOFF_PASSED`). Free play (§9.0) ends at the same moment.

---

## 12. Database Changes

| Change | Detail |
|--------|--------|
| `users` | Adds `status`, `role`, `email_verified_at`, `password_changed_at` and `last_login_at` |
| New tables | `sessions`, `auth_factors` (encrypted secret, `confirmed_at`, `last_used_step`), `backup_codes` (hash, `used_at`), `auth_tokens` (email-verify / password-reset hashes, expiry, `used_at`), `nfl_players`, `lineup_confirmations` |
| `nfl_games` | Adds `home_team` and `away_team` |
| `season_submissions` | Adds `receipt_id`. `void_reason` gains `PLAYER_NO_GAME`. Locked-row guard (§9.5) |
| `submission_receipts` | Adds `lineup_sha256`, and becomes append-only |
| `security_audit_log` | Becomes append-only (the PRD-001 reopen check reads it, and nothing ever changes it) |
| `notification_queue.kind` | Gains `LINEUP_RECEIPT`, `SUBMISSION_REPOINTED`, `SUBMISSION_VOIDED` and `SECURITY_ALERT` |
| `notification_queue` (v1.6) | Adds `read_at` and an index on `(user_id, created_at DESC)` for the inbox |
| `feedback` (v1.6) | New: user, screen, body (CHECK 1–2,000 chars), `tags` (JSONB, GIN index), `classified_at`, `classify_attempts`, review fields |
| `season_submissions` (v1.6) | Index on `(season, user_id)` for the field board |
| `nfl_players` (v1.7) | Adds `canonical_id`, `identity_source` (auto/manual), `identity_review`; no-chain trigger (§7.5) |
| `season_submissions` (v1.7) | Trigger: a row can't name an alias; `void_reason` gains `PLAYER_MERGED` |

---

## 13. Configuration (Railway env vars; never committed)

| Variable | Notes |
|----------|-------|
| `DATABASE_URL` | |
| `REDIS_URL` | |
| `TOTP_ENCRYPTION_KEY` | 32 bytes, base64 |
| `SESSION_COOKIE_SECURE` | |
| `CORS_ORIGINS` | |
| `APP_BASE_URL` | |
| `MSF_API_KEY` | |
| `MSF_BASE_URL` | |
| `SENDGRID_API_KEY` | Mailer; the dispatcher comes later |
| `PAYMENTS_LIVE` | |
| `PORT` | |
| `TURNSTILE_SECRET_KEY` | api. Sign-up bot check (§6.1); unset = no check, with a warning |
| `ANTHROPIC_API_KEY` | worker, optional. Feedback tagging; unset = stored untagged |
| `FEEDBACK_MODEL` | worker. Default `claude-haiku-5-5` |

---

## 14. Acceptance Criteria

| # | Criterion |
|---|-----------|
| AC1 | Signup returns 202 for new and existing emails alike, with identical bodies. The password is stored only as a bcrypt hash. A password under 12 characters is rejected. A taken or reserved handle is rejected. Verification links work once and expire. |
| AC2 | A wrong email and a wrong password give the same 401. The sixth failure for one email in 15 minutes is rate-limited, and so is the IP limit. |
| AC3 | Logout, logout-all, password change, password reset and suspension each invalidate the affected sessions on the very next request, Redis cache included. Idle (24 h) and hard (30 days) expiry are enforced. |
| AC4 | TOTP passes the RFC 6238 vectors. Enrolment needs the password. Confirmation returns 10 single-use backup codes. Once enrolled, sign-in requires the second factor. A replayed code is rejected. No plaintext secret is stored. |
| AC5 | Each financial route returns `EMAIL_UNVERIFIED`, then `MFA_ENROLLMENT_REQUIRED`, then `STEP_UP_REQUIRED` as each gate is missing, and succeeds when all are met. Step-up lapses after 5 minutes. Step-up codes are rate-limited. |
| AC6 | A cookie-authenticated state change without the CSRF header, or from a disallowed Origin, gets 403. Bearer requests are exempt. |
| AC7 | Confirmation writes the submissions and a receipt with all three gate timestamps and a checksum matching §9.4. Out-of-order, repeated and expired gates are rejected. Receipts are append-only. |
| AC8 | A confirm after a slot's `scheduled_et` is rejected even before the lock job runs. Locked slots can't be changed, but a partial re-save keeps them. The database rejects an UPDATE of a locked submission. |
| AC9 | Burned, bye-week, wrong-position, duplicate and empty-slot lineups get 422 with the right codes. |
| AC10 | Re-resolve re-points a traded player to his new pending window, voids with `PLAYER_NO_GAME` when there's no game, writes the audit row and the notification, and never touches a locked row. |
| AC11 | NIL: no player column or API response field holds an image, headshot or URL. Pool burn states and ownership percentages are correct. |
| AC12 | Checkout, payout and instant routes work end to end over HTTP against PRD-004. The webhook route checks the raw-body signature. A user can't read another user's payouts or receipts (404). |
| AC13 | Admin routes require the admin role and step-up. |
| AC14 | The listed events write audit rows, and the audit log is append-only. |
| AC15 | No response or log line contains a password hash, factor secret or session token, apart from the token in its own issuing response. |
| AC16 | At checkout, a missing or non-US geo header gives `JURISDICTION_BLOCKED`. |

Every critical rule also gets a mutation check, as with PRD-001 to PRD-004.

---

## 15. Out of Scope for PRD-006

| Item | Where it goes |
|------|---------------|
| SMS and passkey factors | §6.4 |
| An identity-verification provider | Admin manual verification until chosen |
| The notification dispatcher (Expo Push, Web Push, SendGrid send loop) | Outbox rows are written now |
| Weekly contests | |
| Pri/Alt insurance | PRD-005 |
| Closed leagues | |
| WebSocket live updates | Clients poll `ifVersion` for now |
| The web and mobile clients | |

---

## 16. Dependencies on Other PRDs

| PRD | What this package uses or changes |
|-----|-----------------------------------|
| PRD-001 | Uses `validateLineupDraft`, the lock engine and the burn evaluator. Implements §6.5 and resolves AC8. |
| PRD-002 | Schedule ingest now stores home and away teams. The worker drives ingest and freeze. |
| PRD-003 | Leaderboard service routes, and the handle set at signup. |
| PRD-004 | All payments routes. `stepUpAt` comes from the session. |

---

## 17. Open Questions

| # | Question | Owner |
|---|----------|-------|
| Q1 | ~~Can Out and IR players be selected?~~ **Resolved 2026-10-27:** no — greyed out, not burned; an existing pick is voided before its lock (PRD-001 §3.1.1). | — |
| Q2 | ~~Fullback eligibility.~~ **Resolved 2026-10-27:** FB eligible at RB and FLEX. | — |
| Q3 | Projections feed for `projectedPoints` (MSF add-on or another source). Null until then. | Nath |
| Q4 | ~~Paid entry to submit?~~ **Resolved 2026-10-27, revised same day:** free play for two weeks (until the Week 3 cutoff), no prizes; late payers score for prizes from their paid week (§9.0, PRD-003 §3). | — |
| Q5 | ~~Players feed shape.~~ **Resolved 2026-10-27:** `players`, `injuries` and `player_stats_totals` all return 200; the earlier 403 came from the season parameter. Parser verified against real samples (now test fixtures). | — |
| Q6 | Identity-verification provider (PRD-004 Q10). | Nath |
| Q7 | Supersedes Tech Summary §6.1 "JWT 24-hour". The Tech Summary should note that sessions are server-side and revocable. | Nath (doc) |

---

## Change log

| Version | Date | Changes |
|---------|------|---------|
| 1.7 | 2026-10-28 | §7.5: one person, one player. Duplicate MSF IDs for the same person become aliases of one kept ID; aliases can't be picked (DB-enforced); burns and stats follow the person; admin review and override. Roster sync also runs at worker startup. |
| 1.8 | 2026-10-28 | §11: scoring works newest week first, retries a refused MSF read once, and skips only the week whose feed stays refused. |
| 1.12 | 2026-10-28 | PRD-008 Phase 2: push config, device subscriptions, push preference groups; signing out everywhere revokes push devices; the `push` worker job; `push_subscriptions` and `notification_queue` push columns. |
| 1.11 | 2026-10-28 | §6.10: invite-only sign-up (per-person single-use codes, optional email lock, expiry and revoke), `invite_codes`, `SIGNUP_INVITE_ONLY`. |
| 1.10 | 2026-10-28 | PRD-008 Phase 1: notification preferences, one-click unsubscribe, admin stats; the `notify` worker job; `notification_queue` dispatch columns, `notification_preferences`, `users.email_notifications`. |
| 1.9 | 2026-10-28 | §10.2.1: notices return the named players' names; the inbox cursor includes the id so notices sharing a timestamp never drop at a page edge; reveal `LOCKED` slots say whether the player has burned. |
| 1.6 | 2026-10-27 | PRD-007 §8: D3 amended (a second factor for all use, §6.9; admin factor reset §6.7); Turnstile on sign-up; web app reads (§10.2.1); feedback and its worker tagging; `read_at`, `feedback`. |
| 1.5 | 2026-10-27 | §11.6: season schedule import. One window per exact kickoff; frozen windows fixed (enforced by a trigger); picks re-resolved after changes; review list for decisions the import won't make; backfill through the normal jobs; pools close at the Week 3 lock at publish. |
| 1.4 | 2026-10-27 | Free play is two weeks: the paid-entry cutoff moves from the Week 4 lock to the Week 3 lock (§9.0, Q4; PRD-003 §3, PRD-004 D7). |
| 1.3 | 2026-10-27 | Railway deploy: §10.4 edge trust. The cf-* location and client-IP headers count only with the Cloudflare edge secret; otherwise they're dropped (checkout blocked, proxy IP used). |
| 1.2 | 2026-10-27 | Real MSF samples: `players.json` without a season parameter; `INJURY_LIST` → IR; separate 15-minute injuries job on the light `injuries.json` feed; Q5 resolved. |
| 1.1 | 2026-10-27 | Rules calls: Out/IR unselectable and voided before lock; FB at RB/FLEX; free play through the Week 4 cutoff (§9.0); injury-report sync cadence; `players` feed 403 fallback. |
| 1.0 | 2026-10-27 | First version, built against decisions D1–D5. From the build: signup returns 202 without a session (§6.1); the sign-in second factor counts as step-up (§6.2); PRD-001's validator gained a `fixedSlots` option for partial re-saves; the scoring job burns only windows whose games are all Final. |
