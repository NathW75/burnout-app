# PRD-006 — API, Accounts and Lineup Submission
**Burnout League · packages/api**
Version 1.0 · 2026-10-27
Status: APPROVED 2026-10-27 — scope and auth decisions locked by Nath (§3); build-time details open for review (§17)

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
| D3 | Signing up doesn't require two-factor. **A second factor must be enrolled before the first money action**, because step-up needs one. | Decision 2026-10-27 |
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

- **`POST /v1/auth/signup { email, password, handle }`:**
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
  - With no factor enrolled, the session is issued straight away.
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
- **Changes:** replacing the factor or regenerating backup codes requires step-up. Removing the only factor isn't self-service in v1; it goes through support.

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

Events with no known user are recorded under the system user (all-zero UUID).

---

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

**Sync:** `syncPlayers(feed)` upserts `nfl_players` from the MSF `players` feed. It runs nightly at 3:00 AM ET and at Tuesday 11:59 PM ET.

**Re-resolve:** `reresolveSubmissions(season, week)` then runs. For every submission this week that is not locked and not voided, it re-derives the player's window from his current team:

| Situation | Action |
|-----------|--------|
| Same window | Nothing |
| A different window that is still pending | Re-point `game_window_id`, write `SUBMISSION_REPOINTED` to the audit log, and notify the user |
| No game this week, unsigned, or the new window has locked | Void with `void_reason = 'PLAYER_NO_GAME'`, write `SUBMISSION_VOIDED` to the audit log, and notify the user |

Locked submissions are never touched. The same re-resolve also covers a game moving to another window within the week (PRD-001 §6.4).

### 7.4 MSF access

Only the worker calls MSF, with `MSF_API_KEY` from env using Basic auth (`key:MYSPORTSFEEDS`). The key is never logged.

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

**Ownership:**
- Week ownership is the share of this week's submitters who submitted the player.
- Season ownership is the share of users with any burn who have burned the player.
- Both are cached in Redis for 5 minutes (PRD-001 §10).

**Available pool:** eligible players minus the caller's burned players. A `pool_entries` row is created for a player the first time the user submits him, because the burn foreign key needs it.

---

## 9. Three-Gate Lineup Submission (PRD-001 §9)

### 9.1 Gate 1 — Review

`POST /v1/seasons/:season/weeks/:week/lineup/review { slots }`:

1. **Merge:** the server merges in the user's **locked** slots, which can't change. Sending a different player for a locked slot returns `422 SLOT_LOCKED`.
2. **Validate:** it runs the PRD-001 validator (`validateLineupDraft`) on the unlocked slots, checking:
   - every slot filled (`SLOT_EMPTY`);
   - no duplicates (`DUPLICATE_PLAYER`);
   - the player isn't burned (`PLAYER_BURNED_OR_UNAVAILABLE`);
   - the player exists (`PLAYER_NOT_FOUND`);
   - the position fits the slot (`POSITION_INELIGIBLE`);
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

### 10.2 Players and lineups

| Route |
|-------|
| `GET /v1/seasons/:season/weeks/:week/pool` |
| `GET /v1/seasons/:season/weeks/:week/lineup` |
| `POST /v1/seasons/:season/weeks/:week/lineup/review` |
| `POST /v1/lineup-confirmations/:id/acknowledge` |
| `POST /v1/lineup-confirmations/:id/confirm` |
| `GET /v1/receipts/:id` |

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

Each job:
- runs under a Postgres advisory lock, so two workers never run it at once;
- logs a JSON line;
- survives the failure of any other job.

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
| Q1 | Can Out and IR players be selected? PRD-001 allows them and only shows the status; Tech Summary §4.3 blocks them. This build follows PRD-001. | Nath |
| Q2 | Fullback eligibility at RB and FLEX. FB players are synced but not selectable until decided. | Nath |
| Q3 | Projections feed for `projectedPoints` (MSF add-on or another source). Null until then. | Nath |
| Q4 | Must a user hold a paid entry to submit a lineup, or may anyone play free? This build lets anyone submit. Boards rank only entrants. | Nath |
| Q5 | The MSF `players` feed shape is built from the v2.1 docs and needs a real sample to confirm, as was done for gamelogs. | Nath (fetch) |
| Q6 | Identity-verification provider (PRD-004 Q10). | Nath |
| Q7 | Supersedes Tech Summary §6.1 "JWT 24-hour". The Tech Summary should note that sessions are server-side and revocable. | Nath (doc) |

---

## Change log

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-10-27 | First version, built against decisions D1–D5. From the build: signup returns 202 without a session (§6.1); the sign-in second factor counts as step-up (§6.2); PRD-001's validator gained a `fixedSlots` option for partial re-saves; the scoring job burns only windows whose games are all Final. |
