# PRD-007 — Web App (Player Portal)
**Burnout League · apps/web**
*Status: v1.6 — **APPROVED 2026-10-27** (Nath), decisions Q1–Q7 in §14; mockups approved on the landing-page design system (§11); API additions (§8) built; web app patch (a) built; patch (b) built 2026-10-28 in two parts (standings, burned roster, inbox; then account, feedback, light theme). Phase A screens complete.*
*Author: Build thread · 2026-10-27*

---

## 1. Purpose

The web app is where managers play: sign up, set the nine-slot lineup each week through the three gates, watch locks and burns happen, and see where they stand. It is the first client of the PRD-006 API and the reference implementation that the mobile app (Expo) follows later.

**Phase A** gets the 2026 testers playing for the rest of this season (free play, no money). **Phase B** adds what launch needs: payments, ownership analytics, projections and richer burn history.

The server is the authority for every rule. The web app never decides a lock, a burn, eligibility or visibility. It displays what the API says, and re-asks the API whenever time or state may have moved. Disabling a button in the UI is a convenience, never a control.

---

## 2. Users and context

- **Managers** (testers now, paying users from 2027). They're often on a phone, often minutes before a lock, and sometimes on a Sunday with bad signal.
- **Admin (Nath):** Phase A uses the existing admin API directly. An admin console is Phase B.
- **Scale at launch:** about 1,200 paying users in Year 1 (business plan); the 2026 testers are a few dozen.

---

## 3. Scope

### 3.1 Phase A: testers, rest of the 2026 season

| Area | Includes |
|------|----------|
| Accounts | One sign-up process: account, verify email, **set up the authenticator (required)**, save backup codes, then in. Sign in (password + code), sign out, password reset. |
| This Week | Official clock, the week's windows with lock countdowns, my nine slots and their states, my rank, what changed since last visit |
| Lineup | Player pool with filters, slot editing, the three gates (§7), receipt with checksum |
| Burned roster | Every player I've burned, by week, slot and points |
| Standings | The season field leaderboard (§8.1) and the post-lock reveal of other managers' locked players |
| Inbox | In-app notices: locks, burns, voided or re-pointed picks, reopened slots |
| Account | Handle, password, 2FA setup and backup codes, sessions (list, revoke, sign out everywhere), receipts |
| Feedback | The floating feedback button (`SPEC-feedback-system.md`, adapted in §10) |
| Help | The rules in plain language: burn, lock at scheduled kickoff, empty slots, Out/IR, game disruptions, free play |

### 3.2 Phase B: launch (2027)

- **Pools and payments:** entry list, prize tables, web checkout, payouts, identity verification hand-off. This is gated by the attorney's opinion and processor approval (hard constraints 5 and 6).
- **Ownership percentages** on player cards (PRD-001 §10), with the 50-lineup floor.
- **Projected points:** pending the projections feed decision (PRD-006 Q3).
- **Burned-roster charts** (Tech Summary §9.2).
- **MCP connections and tokens** in account settings (PRD-011 Phase 1a).
- **Admin console:** pools, settlements, identity verifications, suspensions, schedule review items, feedback.
- **Weekly contests and Pri/Alt:** their own PRDs.

### 3.3 Out of scope

- The marketing site and waitlist (the `burnout-landing` Worker at burnoutfantasy.com stays as it is).
- The mobile app (its own PRD; it reuses this PRD's API additions).
- Live play-by-play.

---

## 4. Platform

| Item | Decision |
|------|----------|
| Location | `apps/web` in the monorepo (the `apps/*` workspace and `dev:web` / `build:web` scripts already exist) |
| Stack | React + Vite + TypeScript + Tailwind CSS (Tech Summary stack), React Router, TanStack Query for server state. Current stable versions at build time. |
| Rendering | Static single-page app. No server rendering, and no secrets in the bundle. |
| Hosting (Q1) | Cloudflare (static assets on Workers) at **`app.burnoutfantasy.com`**, staging at **`app-staging.burnoutfantasy.com`**. Same zone as the API, so DNS, TLS and headers live in one place. |
| Deploys (Q1) | GitHub Actions with `wrangler`. Staging deploys every push to `main`; production runs behind the same blackout deploy gate as the API (Thu 5:00 PM → Tue 2:00 AM ET). Needs a scoped `CLOUDFLARE_API_TOKEN` secret in GitHub. |
| API base | Build-time `VITE_API_BASE_URL` (`https://api-staging.burnoutfantasy.com` or `https://api.burnoutfantasy.com`), with the Turnstile site key, in `apps/web/.env.staging` and `.env.production` (public values only). Runbook: `docs/deploy/CLOUDFLARE-APP.md`. |
| API config change | `CORS_ORIGINS` adds the app origin and `APP_BASE_URL` becomes it, so email links and checkout returns land in the app (set per environment in `.railway/railway.ts`). |

**Sessions:** the API's `httpOnly`, `Secure`, `SameSite=Lax` cookie works across `app.` and `api.` because both are on the same site (burnoutfantasy.com). The app never sees or stores the session token; nothing auth-related goes in `localStorage`. Every unsafe request sends `X-Burnout-CSRF: 1`, and the API also checks `Origin` (PRD-006 §5).

---

## 5. Non-negotiables in the UI

1. **NIL:** players appear as text only: name, position, team abbreviation. No headshots, likenesses, or NFL or team logos anywhere. Team abbreviations are plain text.
2. **Times are Eastern and labeled.** Every kickoff and lock shows "ET". Each window states that it **locks at the scheduled kickoff, not the actual kickoff** (hard constraint 4 requires it on the roster page).
3. **Official clock.** The header shows Burnout League time from the server. The app measures its offset against `GET /v1/time` (§8.2) at load, on regaining focus, and every 5 minutes. All countdowns use server time; the device clock is never trusted.
4. **When a countdown hits zero, ask the server.** The app refetches the lineup and pool, and never assumes a lock that didn't happen or misses one that did.
5. **Pre-lock anonymity.** The app only ever receives what the server allows (PRD-003 §6). It never caches another manager's lineup and never shows ownership below the floor.
6. **Handles only.** Other users appear by handle, never by email or real name.
7. **Burn language** follows the brand guide: burned, locked, scorched. Never "eliminated" or "expired."

---

## 6. Screens (Phase A)

### 6.1 Sign up, verify, sign in

- **Sign up:** email, password (PRD-006 length rules), handle. It always shows "check your email" (the API answers 202 either way). Cloudflare Turnstile is on the form (Q6).
- **Verify:** the link opens `/verify?token=…`, which calls the API and then signs in.
- **Sign in:** password, then a code (TOTP or backup code). Every account has a factor (§6.1.1). A "remember this device" option is out of scope.
- **Reset password:** request, email link, set new password. Afterward, other sessions are signed out (the API does this).
- **First run:** after sign-up, a three-card explainer (burn, lock at scheduled kickoff, nine slots), then This Week.

#### 6.1.1 Two-factor is part of sign-up (decision 2026-10-27)

**Every account needs an authenticator before it can do anything** (Nath: "2FA needs to be required for all use because of potential attack surface"). It is one continuous process, not a later nudge:

1. Email, password and handle (with Turnstile).
2. Verify the email from the link.
3. **Set up the authenticator:** a QR code and the manual secret, with links to common authenticator apps. Enter a code to confirm.
4. **Backup codes,** shown once. Continuing requires ticking "I've saved these."
5. The explainer, then This Week.

A user who stops partway resumes at the step they left on their next sign-in (the login response says `mfaEnrollmentRequired: true`, and `GET /me` reports `emailVerified` and `mfaEnrolled`). Until step 3 is done, the only screens are the remaining sign-up steps, sign-out and the feedback button. **The server enforces this** (§8.6), so no client can skip it.

**Recovery:** a lost phone means signing in with a backup code and setting up a new authenticator. Losing both means an admin reset after an identity check (§8.6), after which the user sets up again at their next sign-in.

### 6.2 This Week (home)

- **Header:** official clock, current week, my season rank and points (from the field board).
- **Windows:** each window this week with its label ("Sunday Late · 4:25 PM ET"), a countdown, its status (open, locked, final), and how many of my slots sit in it.
- **My lineup:** the nine slots in order (QB, RB1, RB2, WR1, WR2, WR3, TE, FLEX, K), each in one of the states in §6.3, with "Edit lineup" while any window is open.
- **Since your last visit:** unread inbox items, e.g. "Saquon was voided: Out before his lock," "3 players burned."
- **Free play banner:** shows free-play status from `eligibility`. After the Week 3 cutoff in a season with paid pools, a non-entrant sees why they can't submit.

### 6.3 Lineup builder

**Slot states** (Tech Summary §2.1, PRD-001 §3):

| State | Shown as |
|-------|----------|
| Empty | Outlined, "Empty — scores 0, burns nothing" |
| Picked, editable | Filled, removable, with its lock time |
| Locked (window fired, not Final) | Amber "game live" tag, frozen |
| Burned | Red strikethrough, frozen; the player then appears only in the Burned roster |
| Voided | Flagged with the reason (Out/IR, no game, game canceled) and editable again if any window is open |

**Player picker:** opens for a slot and lists only eligible positions (FB counts at RB and FLEX).

- **Filters:** position, team, game window, text search.
- **Each card** (PRD-001 §10, Phase A fields): name, position, team, opponent with home/away, kickoff ET, injury status.
  - Projected points and ownership arrive in Phase B; Phase A shows nothing rather than a placeholder number.
- **Greyed and unselectable, with the reason:**
  - Out or IR: "not selectable, not burned"
  - on bye: "BYE WEEK"
  - game already locked
  - already burned (hidden by default, with a toggle to show)

**Draft:** changes are a local draft until confirmed, saved per week in browser storage as a convenience only. The draft is cleared or reconciled on refetch: any slot the server now reports as locked or voided wins over the draft.

**Submit:** "Review lineup" starts the three gates (§7). Only open slots can change; the API keeps locked slots fixed. **Every slot that hasn't locked needs a player to submit** (PRD-006 §9, `SLOT_EMPTY`): the button stays off and names the slots to fill. An empty slot happens only when a confirmed pick is voided later, and it then scores 0 and burns nothing. A draft pick whose window has since locked, or who is now listed Out, is flagged and must be replaced before review.

### 6.2.1 Navigation (as built, v1.5)

- **Bottom tabs:** WEEK, LINEUP, BOARD (standings), BURNED, ACCOUNT.
- **Header:** wordmark, official clock, and an inbox bell with the unread count as text (`Inbox, 3 unread` for screen readers). Below 380px the wordmark shortens to BURNOUT so all three fit at 360px.
- **Rules** moved from a tab to Account, and stay linked from every screen that states a rule (This Week's locks, the builder, the gates, the burned roster, the reveal).

### 6.4 Burned roster

Every burned player, grouped by week (newest week first; within a week, in the order they burned): slot, name, position and team, the window he burned in, and his points. A summary shows how many have burned and the points they scored. It's read-only reflection. Charts are Phase B.

### 6.5 Standings

- **Season field leaderboard (§8.1):** rank, handle, season points, this week's points. My row is pinned and paging is server-side. Ties share a rank, with display order by handle (PRD-003 §4).
- **Reveal:** tapping a manager shows their **locked** players for a chosen week (a picker lists weeks with a lock), and nothing for windows that haven't locked. Locked players who have since burned show as burned. A manager's own lineup is shown in full, with picks not yet locked marked "hidden from others".
- The board polls every 60 seconds while a window this week is locked and not yet Final, and shows when it last updated.
- **Paid pool boards** (PRD-003) appear here in Phase B, when the user has entries.

### 6.6 Inbox

In-app notices from the same events that queue emails, newest first, 30 at a time with "older notices". Read state is per item (opening one marks it read), with "mark all read"; unread items carry a NEW tag, not just a color. Notices name the players they're about (name, position, team; text only). Each item links to what it concerns: burns to the burned roster, this week's locks and moves to This Week, voids and reopened slots to the builder, receipts to the receipt, and an older week's notices to that week's lineup.

### 6.7 Account

- **Profile:** handle (PRD-003 handle rules and change history).
- **Security:**
  - change password
  - 2FA: replace the authenticator (needs a current code), regenerate backup codes (shown once)
  - sessions: list with device and last seen, revoke one, sign out everywhere
- **Receipts:** every confirmed lineup's receipt with its checksum, recomputable per PRD-006 §9.4.

**As built (v1.6):** Account lists Profile (handle with an inline change, two changes a season per PRD-003; email), Security (Password, Authenticator app, Backup codes, Sessions, each its own screen), Notifications (email notices, PRD-008 §6), Lineups (Receipts), Appearance (Dark, Light, Match device), Rules and Sign out. A public `/unsubscribe` page confirms the email's unsubscribe link.
- Password: current, new and repeat; other sessions are signed out and this one stays.
- Replace authenticator and new backup codes ask for a fresh code first (step-up), in place, and ask again if the server says it's stale. New codes are shown once with download, copy and an "I've saved these" tick.
- Sessions: device named from the browser (e.g. "Chrome on Android"), last active and signed-in times ET, "This device", sign out any other device, and sign out everywhere.
- Receipts: newest first, week, confirmation time and the start of the checksum, each opening its receipt.

### 6.8 Help

The rules page explains the burn, lock at scheduled kickoff, empty slots, Out/IR, team changes mid-week, cancellations and postponements, free play, and the Week 3 cutoff. It's linked from every screen that mentions a rule.

---

## 7. The three gates (PRD-001 §9, PRD-006 §9)

| Gate | Screen | API |
|------|--------|-----|
| 1. Review | Every slot as it will lock, each with its window and lock time ET; which players will burn if their game goes Final. Changed slots are marked NEW (lime 8% tint); already-burned slots show red strikethrough and can't change. | `POST …/lineup/review` |
| 2. Acknowledge | Three separate, unticked checkboxes: the burn rules, the permanent nature, no refunds. Each one's wording comes from the T&C. **CONTINUE stays lime but can't be tapped** (with "Tick N more to continue" under it) until all three are ticked; then it turns **red (`#D9363F`) with white text** and can be tapped. A ticked card's border turns lime. | `POST /lineup-confirmations/:id/acknowledge` |
| 3. Confirm | **Press and hold** for 1.5 seconds. A lime ring fills around the button while **the center fills red (`--pencil`) from 0 to 100% opacity in step with the ring**; the label changes to "KEEP HOLDING". The keyboard alternative is holding Space or Enter. Releasing early cancels and resets both. With reduced motion, the ring and fill step instead of animating. | `POST /lineup-confirmations/:id/confirm` |

- The confirmation expires (the API sets the deadline). Every gate shows the countdown, and the UI restarts at Gate 1 when it expires.
- If a window locks between gates, the API rejects the stale confirmation. The UI explains which slot locked and returns to the builder with fresh data.
- **Receipt:** "Locked in.", the confirmation time (server), the changed slots, and the SHA-256 checksum, with a link to the receipt page.
- Gate 3 is a deliberate action. The app never retries `confirm` automatically, and a network failure shows "check your lineup" and refetches.

---

## 8. Data the app needs that the API lacked (built 2026-10-27)

These endpoints follow PRD-006 conventions (session auth, `/v1`, zod validation, rate limits, tests with mutation checks). PRD-006 v1.6 §10.2.1 lists them with their response shapes.

### 8.1 Season field leaderboard (free play)

`GET /v1/seasons/:season/leaderboard?offset&limit` and `GET /v1/seasons/:season/leaderboard/me`

- **Who's on it:** every active user with a handle and at least one confirmed lineup this season, ranked by season points from `user_week_scores`. "This week's points" are for the latest week with a locked window.
- **Ranking:** the same tie and ranking rules as PRD-003 §4. The computed board is cached in Redis for 30 seconds (Postgres stays authoritative) and carries an `ETag`, so a polling client gets `304` when nothing changed.
- **Handles only:** the response has no user ids or emails.
- **Not prize standings:** prizes come only from pool boards. The field board shows everyone's full season.
- **Reveal:** `GET /v1/seasons/:season/weeks/:week/managers/:handle/lineup` returns only locked, non-voided slots, enforced in the query (PRD-003 §6.1). Other slots come back `HIDDEN` with no player. A manager's own lineup is shown in full.

### 8.2 Season, week and windows

- `GET /v1/time`: `{ serverTime }`. Unauthenticated and `no-store`, for the official clock.
- `GET /v1/seasons/current`: `{ season, currentWeek, weeks: [{ week, firstLock, lastLock, status }] }`. The current week is the earliest week with a window still to lock (after the season, the last week); status is `upcoming`, `live` or `complete`.
- `GET /v1/seasons/:season/weeks/:week/windows`: `{ windows: [{ id, label, scheduledEt, status, games: [{ away, home }] }] }` in kickoff order.

### 8.3 Burns, inbox, receipts

- `GET /v1/me/burns`: `[{ week, slot, playerId, name, position, team, pointsX100, burnedAt, windowLabel }]`.
- `GET /v1/me/notifications?before&limit` (with `unread`, `players` and `nextBefore`) and `POST /v1/me/notifications/read` (`{ ids }` or `{ all: true }`, the caller's items only). A new `read_at` column on `notification_queue`; delivery state (`dispatched_at`) stays separate from read state.
  - `players` (v1.5): `{ [playerId]: { name, position, team } }` for every player the returned notices name, so the inbox can say who locked or burned.
  - `nextBefore` (v1.5) is an opaque cursor (time and id). Several notices can share a timestamp, so a time-only cursor could skip one at a page edge. A bare timestamp is still accepted.
- The reveal's `LOCKED` slots carry `burned` (v1.5).
- `GET /v1/me/receipts`: receipt summaries `{ id, week, confirmedAt, sha256 }`, newest first.

### 8.4 Sign-up protection (Q6)

`POST /v1/auth/signup` accepts `turnstileToken` and verifies it server-side against Cloudflare siteverify (with the client IP) before anything is created. The secret is the `TURNSTILE_SECRET_KEY` Railway shared variable. A missing or failed token returns `400 TURNSTILE_FAILED`, and so does Cloudflare being unreachable (fails closed). Verification is skipped only when no secret is configured (local and tests).

### 8.5 Feedback

`POST /v1/feedback` per the spec, adapted in §10.

### 8.6 A second factor for all use (changes PRD-006 D3)

PRD-006 required a second factor only before the first money action. From this change on, **every account must have a confirmed factor to use the API:**

- **Enrollment-only sessions:** a signed-in user without a confirmed factor gets one. It may call only the sign-up steps: TOTP setup and confirm, `GET /me` (which reports `mfaEnrolled: false`), sign-out, email verification, `GET /time` and `POST /feedback`. Every other route returns `403 MFA_ENROLLMENT_REQUIRED` (or `EMAIL_UNVERIFIED` first while the email is unverified; TOTP setup also needs a verified email). The check is a router-level gate in the API, so it covers web, mobile and future MCP token issuance alike.
- **Sign-in:** users with a factor keep the existing password-then-code flow. Users without one get an enrollment-only session (`mfaEnrollmentRequired: true`), so they can finish setup.
- **Admin factor reset:** `POST /v1/admin/users/:id/factors/reset { reason }` (admin + step-up). It removes the user's factors and backup codes, revokes their sessions, writes an `MFA_RESET` entry in `security_audit_log` with the admin's reason, and emails the user. Their next sign-in is enrollment-only again. An admin can't reset their own factors.
- **Step-up and backup codes** are unchanged.
- **Tests:** every non-enrollment route refuses an enrollment-only session (enumerated from the router, so a new route can't slip through); enrollment completes and unlocks the session; the admin reset revokes and forces re-enrollment.

---

## 9. Behavior details

- **Freshness:**
  - Lineup and pool data refetch on focus, after any mutation, and at every countdown zero.
  - The leaderboard polls every 60 seconds while visible during live windows and sends `If-None-Match` with the board's `ETag` (`304` when unchanged).
- **Offline or flaky network:** read screens show the last data with a "last updated" time. Nothing is submitted offline, and Gate 3 needs a live response.
- **Errors:** API error codes map to plain messages. `WEEK_CLOSED`, `PAID_ENTRY_REQUIRED`, `PLAYER_INACTIVE`, `TURNSTILE_FAILED` and stale confirmations each get a specific explanation and next step.
- **Step-up:** actions the API marks as needing a fresh second factor prompt for a code in place, then retry once.
- **Accessibility:** WCAG 2.2 AA. Full keyboard use, visible focus, and screen-reader labels on slot states and countdowns. Reduced motion is respected, and color is never the only signal (states carry text tags).
- **Responsive:** mobile-first from 360px; the lineup is usable one-handed.
- **Performance:** the initial JS stays under about 200 KB gzipped; the routes for the three gates, the leaderboard and account load lazily.
- **Security headers** (set at Cloudflare): a strict Content-Security-Policy (self plus the API origin, Turnstile and Google Fonts), `frame-ancestors 'none'`, HSTS, and `Referrer-Policy: strict-origin-when-cross-origin`.
- **No third-party scripts** in Phase A beyond Turnstile. No analytics.

---

## 10. Feedback button (SPEC-feedback-system.md, adapted)

The spec is kept, with these changes to fit what's built:

- **Auth:** it uses the session (cookie or bearer) and the CSRF header, not JWT. An enrollment-only session may send feedback, so a tester stuck in sign-up can say so.
- **Route:** `POST /v1/feedback { body }`, not `/api/feedback`. The body is trimmed and must be 1–2,000 characters; any other field is rejected. The user comes from the session and the screen from `X-Current-Screen` (a readable slug, otherwise stored as `unknown`). 10 per user per hour.
- **AI tagging:** a worker job, not a Bull queue. It runs every 15 seconds (so tags land within the spec's 30 seconds), calls the Anthropic Messages API with `FEEDBACK_MODEL` (default `claude-haiku-5-5`), validates the reply against the spec's JSON shape, and writes `tags`. The feedback text is fenced in the prompt as untrusted input and never logged. Each item gets 3 attempts. Without `ANTHROPIC_API_KEY`, feedback is stored untagged.
- **Admin:** `GET /v1/admin/feedback` (filters: reviewed, category, severity, before) and `POST /v1/admin/feedback/:id/review`, admin + step-up. The admin screen is Phase B.

The floating button sits on every signed-in screen and sends the current route in `X-Current-Screen`. The 2,000-character limit and the spec's acceptance criteria otherwise stand.

**As built (v1.6):** a round button bottom right that measures and sits just above whatever bar is pinned to the bottom (the tabs, the lineup footer, a gate footer); screens have extra bottom padding so their last rows scroll clear of it. It opens a bottom sheet on phones and a side drawer from 768px: one text box with a counter, SEND FEEDBACK, a short "Sent" confirmation that closes itself, and on failure "Couldn't send" with the reason and the text kept. It shows on sign-up steps after sign-in (so a stuck tester can say so) and never on signed-out screens.

---

## 11. Visual design (decided 2026-10-27: match the landing page)

The app uses the **live landing page's design system** (burnoutfantasy.com), not the older brand-guide palette, so the product and the site read as one brand. Nath approved the mockups on this system.

**Color tokens** (names as on the landing page):

| Token | Value | Use |
|-------|-------|-----|
| `--graphite` | `#0D0E0F` | Header, bottom bars, nav |
| `--newsprint` | `#17191B` | Page background |
| `--paper` | `#202326` | Cards, rows |
| `--rule` | `#33383C` | Dividers, card borders |
| `--frame` | `#4A5056` | Button outlines, inputs |
| `--type` | `#EDEFEA` | Primary text |
| `--muted` | `#A3AAAE` | Secondary text |
| `--steel` | `#8A9196` | Disabled and greyed-out (Out, bye, locked picks) |
| `--line` | `#E6FF3D` | Primary buttons (text `#141414`), current step, selected filter, new picks (8% tint), header rule, Gate 3 ring |
| `--pencil` | `#FF5C66` | **Burned**: red text with strikethrough; Gate 3 center fill |
| `--bulb` | `#FFB81C` | **Live, locked, next lock** (fill with `#141414` text, or 14% tint row), voided/open slots (dashed) |
| commit red | `#D9363F` | Gate 2 CONTINUE once all three boxes are ticked (white text) |
| slate panel | `#1B232A` / border `#2C3A45` | Informational panels (since your last visit, lock rule, receipt). App addition: a cool blue-gray. |

**Type:** **DM Mono** for headings, labels, buttons, times and slot names (uppercase labels, "///" section markers); **IBM Plex Sans** for body text; tabular numerals for points, ranks and countdowns.

**Shape:** square-ish (4 px radius), 1 px rules, no shadows or gradients.

**Light theme:** the landing page defines one (`data-theme="light"`); the app adopts the same token overrides.

**As built (v1.6):** dark stays the default, as on the landing page; Account → Appearance offers Dark, Light or Match device, remembered per browser (`bl:theme` in localStorage, not account data) and applied before first paint by `public/theme.js` (an external file, since the CSP allows no inline script).
- Built on chalk `#EDEFEA` (the dark theme's type color) with cool neutrals rather than the landing page's warm cream (Nath, 2026-10-28): page `#EDEFEA`, cards and the header and bars `#F7F8F5`, rule `#BFC5C7`, muted `#52585B`, slate panels `#DEE5E9` / `#B3BFC6`.
- Kept from the landing page: type `#141414`, frame `#141414`, pencil `#C8102E`, and the primary button in ink with lime text.
- Brand marks (the header flame and the `///` section markers) are lime in dark and the darker red `#C8102E` in light (Nath, 2026-10-28).
- App additions, because the app uses colors as text where the landing page doesn't: lime and amber stay as fills, but as text they'd be unreadable on a light page, so accent text is olive `#4F5E00` and live text dark amber `#8A5300`; steel is `#5F6569`. Every text color is at least 4.5:1 on every light surface, and axe passes in both themes.
- Turnstile follows the theme; the browser's theme color follows it too.

**Favicon (2026-10-28):** the flame in lime with a red offset echo on graphite (`public/favicon.svg`, from the project library).

**Voice:** dry, confident and short, as on the landing page: "Start him. Lose him." "Locked in." Never hype.

**Marks:** the wordmark text and the flame mark. No photos, no player images, no team logos.

Mockups (approved): the "Burnout League — Web App Mockups" canvas.

---

## 12. Testing

- **Unit and component (Vitest + Testing Library):** slot states, the picker's eligibility rules (FB at RB/FLEX; Out/IR, bye and locked greyed), countdown and clock offset, the draft reconciling against server state, and gate flows including expiry, stale-lock rejection, the Gate 2 button states and the Gate 3 hold/cancel.
- **End to end (Playwright) in CI,** against the real API with Postgres and Redis services (as CI already runs). Patch (a) covers sign-up through the receipt, the server-enforced 2FA gate, sign-in with a code, a window locking during the gates, and axe on each screen it adds; the anonymity and tied-rank tests arrive with the standings in patch (b):
  - sign up → verify → set a lineup through all three gates → receipt
  - a window locks during Gate 2 → rejected → rebuilt
  - pre-lock anonymity: another manager's unlocked slot never appears in any response or in the DOM
  - the leaderboard renders tied ranks per PRD-003
- **Accessibility checks** (axe) on every route in CI.
- **API additions (§8):** integration tests and mutation checks as for PRD-006 (`packages/api/src/__tests__/web-api.test.ts`, and the §8.6 block in `auth.test.ts`).

---

## 13. Acceptance criteria (Phase A)

- [ ] A new user can sign up, verify, choose a handle and reach This Week on a 360px screen.
- [ ] The official clock tracks server time within 1 second after sync, even with the device clock set wrong by an hour.
- [ ] Every window shows its label, kickoff ET and the "locks at scheduled kickoff" statement.
- [ ] Out/IR, bye, locked and burned players can't be picked, and each shows why. FB is offered at RB and FLEX only.
- [ ] A lineup can only be submitted through all three gates. Gate 2's CONTINUE can't be tapped until all three boxes are ticked. Gate 3 requires a 1.5-second hold (or a held key), and releasing early cancels.
- [ ] An expired or stale confirmation can never submit. The user is returned to an up-to-date builder with the reason.
- [ ] After a lock, the slot shows as locked without a manual refresh.
- [ ] The receipt shows the checksum, and the help page explains how to recompute it.
- [x] The field leaderboard ranks ties per PRD-003, and my row is always visible.
- [x] The reveal never shows a slot whose window hasn't locked (asserted against API responses and the DOM).
- [ ] No player images, team logos or real names appear anywhere (automated scan of rendered routes).
- [x] The inbox shows lock, burn, void and re-point notices with read state.
- [x] Sign-up isn't complete without a confirmed authenticator. Until then, **the API refuses every route except the setup steps** (server-enforced and tested against every route). *(API side done; the app's backup-code acknowledgment is part of the web build.)*
- [x] Replacing the authenticator, regenerating backup codes, session revoke and sign-out-everywhere all work. No auth data is in `localStorage`.
- [ ] axe reports no serious or critical issues on any route.
- [ ] Staging deploys on push. A production deploy during the blackout window is held by the gate.

---

## 14. Open questions

| # | Question | Recommendation |
|---|----------|----------------|
| Q1 | ~~Hosting and deploys~~ | **Decided 2026-10-27:** Cloudflare static assets at `app.` / `app-staging.burnoutfantasy.com`, GitHub Actions + wrangler, production behind the blackout gate. |
| Q2 | ~~Season field leaderboard for free play~~ | **Decided: yes.** |
| Q3 | ~~Reveal on the field board~~ | **Decided: yes** (post-lock only, same rule as PRD-003). |
| Q4 | ~~Payments UI in Phase B~~ | **Decided: yes.** |
| Q5 | ~~2FA for free play~~ | **Decided: required for all use,** set up within one sign-up process (§6.1.1, §8.6). Changes PRD-006 D3. |
| Q6 | ~~Turnstile on sign-up~~ | **Decided: yes.** |
| Q7 | ~~Design mockups before the build~~ | **Decided: yes,** three screens (This Week, Lineup builder, the gates). |

---

## 15. Sequencing

1. ~~Approve this PRD (with Q1–Q7).~~ Done 2026-10-27.
2. ~~Mockups of the three key screens, for sign-off.~~ Done 2026-10-27.
3. ~~API additions (§8), shipped as their own patch with tests.~~ Built 2026-10-27.
4. Web app Phase A, as two patches: (a) accounts, This Week, lineup and gates, with a short rules page and a basic account page; built 2026-10-27. (b) in two parts: **part 1**, standings with the reveal, the burned roster and the inbox, built 2026-10-28; **part 2**, the full account (security, sessions, receipts), the feedback button and the light theme, built 2026-10-28.
5. Cloudflare setup: the deploy workflow, `wrangler.jsonc` and headers ship in patch (a); the runbook is `docs/deploy/CLOUDFLARE-APP.md` (API token and two GitHub secrets). Turnstile widgets created 2026-10-27.
6. Testers invited once SendGrid domain authentication is done (verification emails must arrive).

Depends on: PRD-001, PRD-003, PRD-004 (Phase B), PRD-006, `SPEC-feedback-system.md`. PRD-011 Phase 1a hosts its consent page and token settings here (Phase B).

---

## Change log

| Version | Date | Changes |
|---------|------|---------|
| 1.6 | 2026-10-28 | Patch (b) part 2 built: §6.7 account as built (handle change, password, replace authenticator and new backup codes behind step-up, sessions with revoke and sign out everywhere, receipts, appearance); §10 feedback button as built; §11 light theme as built (dark default; chalk-based cool neutrals instead of the landing page's cream; text-safe accents) and the new favicon. Acceptance: account security checked off. |
| 1.5 | 2026-10-28 | Patch (b) part 1 built: §6.2.1 navigation (BOARD and BURNED tabs, inbox bell, Rules under Account); §6.4 burned roster grouped by week; §6.5 reveal week picker, burned state and live polling; §6.6 inbox names players, links each notice, NEW tag. §8.3: notices return player names; the inbox cursor includes the id. Acceptance: field board, reveal and inbox checked off. |
| 1.4 | 2026-10-27 | §6.3: every open slot must be filled to submit (as the API already required), stale draft picks are flagged. §4, §12, §15: as built in web app patch (a). |
| 1.3 | 2026-10-27 | §7: Gate 2 (CONTINUE lime and untappable until all three are ticked, then red with white text) and Gate 3 (red center fills 0→100% with the ring) as approved in the mockups. §8, §10: as built (response shapes, Turnstile fails closed, 30-second field cache with ETag, feedback limits and tagging). Corrected the PRD-006 decision reference to D3. Added to the repo. |
| 1.2 | 2026-10-27 | §11: the visual design follows the live landing page's system (newsprint grays, lime/red/amber accents, DM Mono + IBM Plex Sans), replacing the brand-guide palette; mockups approved. |
| 1.1 | 2026-10-27 | Approved with Q1–Q7. Q5 changed: a second factor is required for all use, set up within sign-up (§6.1.1), and enforced by the API (§8.6, amends PRD-006). |
| 1.0 | 2026-10-27 | First draft. |

*End of PRD-007*
