# PRD-008 — Notification Delivery (email, then push)
**Burnout League · packages/api (worker) + apps/web**
*Status: v1.2 — **APPROVED 2026-10-28** (Nath), Q1–Q5 as recommended · Phase 1 (email) built 2026-10-28*
*Author: Build thread*

---

## 1. Purpose

Every event that matters to a player already writes a row to `notification_queue`: a lock, a burn, a voided or moved pick, a reopened slot, a lineup receipt, a stat correction, and the payment notices. The web app shows them in the inbox (PRD-007 §6.6), but nothing delivers them anywhere else, so a player only finds out by opening the app.

This PRD adds the sender: a worker job that turns queued notices into **email** (Phase 1, before the Week 8 Thursday lock on 2026-10-29) and **web push** (Phase 2). The in-app inbox stays the record; email and push are copies that point back to it.

## 2. What exists

- `notification_queue (id, user_id, kind, game_window_id, payload, created_at, dispatched_at, read_at)`; `dispatched_at` is null on every row. `read_at` (inbox) is separate and stays separate.
- Writers: burn engine (`LOCK`, `BURN`, `SLOT_REOPENED`), roster and identity (`SUBMISSION_VOIDED`, `SUBMISSION_REPOINTED`), lineups (`LINEUP_RECEIPT`), scoring (`SCORE_CORRECTION`, payload says `channels: in_app, recap_email`), payments (`ENTRY_RECEIPT`, `REFUND`, `POOL_CANCELLED`, `PAYOUT_*`).
- `SendGridMailer` sends the secret-bearing emails (verify, reset) directly, never through the queue. That stays as is.
- The worker runs a one-minute tick plus a 15-second feedback loop (PRD-006 §11).

## 3. Scope

**Phase 1 — email (build now, live for Thursday 8:15 PM ET):**
- the dispatcher job, the email templates, per-kind preferences with sensible defaults, an Account → Notifications screen, one-click unsubscribe, and ops visibility.

**Phase 2 — web push (next):**
- a service worker, VAPID keys, push subscriptions per device, the same preferences per channel. On iPhone, web push only works once the app is added to the home screen (iOS 16.4+), so Phase 2 also adds the web app manifest and an "Add to Home Screen" hint.

**Out of scope:** SMS; the native app's APNs/FCM push (comes with the mobile app); the weekly recap email (the `recap_email` channel on `SCORE_CORRECTION` waits for it); marketing email of any kind.

## 4. What gets sent

| Kind | Email by default | Why |
|------|------------------|-----|
| `SUBMISSION_VOIDED` | **On, immediately** | A slot just opened (Out/IR, no game, duplicate). The player can still fill it before its lock. Time-sensitive. |
| `SUBMISSION_REPOINTED` | **On, immediately** | His pick's lock time changed (trade, flex). |
| `SLOT_REOPENED` | **On, immediately** | Game canceled; the slot is open again. |
| `LOCK` | **On** (Q1) | "Thursday Night locked with Wes Kay and Ray Dent." |
| `BURN` | **On** (Q1) | "Wes Kay and Ray Dent are burned. 26.5 pts." |
| `LINEUP_RECEIPT` | **On** (Q3) | The evidentiary receipt: time, changed slots, checksum. |
| `SCORE_CORRECTION` | Off (in-app only) | Waits for the weekly recap. |
| Payment kinds | **On, always** | Transactional (receipts, refunds, payouts); no opt-out except unsubscribe-all, which keeps legally required ones. Not live until payments are (PRD-004). |

Grouping (Q2): notices for the same user that arrive within **2 minutes** of each other go out as **one email** (the window is `NOTIFY_GROUP_SECONDS`, default 120; see §12.1). A Sunday 1:00 PM lock with four of your players is one email, not four; a lock plus a void in the same minute is one email listing both. Immediate kinds skip the wait.

**Too late to matter:** a notice older than **6 hours** when the sender first sees it is marked handled without sending. This keeps a first deploy, a backfill or an outage from emailing a pile of old news. It never applies to payment notices (24 hours there).

## 5. The email

- **From:** `Burnout League <alerts@burnoutfantasy.com>` (new `NOTIFY_FROM`; needs SendGrid domain authentication, already on the to-do list, or mail lands in spam).
- **Subject** says the news: "Locked: Thursday Night · 2 players", "Burned: Wes Kay, Ray Dent", "Action needed: your RB1 is open (Ray Dent is Out)", "Week 8 lineup confirmed".
- **Body:** plain text plus a minimal HTML version in the brand voice ("Start him. Lose him." tone, no hype). Players as text only: name, position, team (NIL). Times in ET, labeled. One button/link to the right screen (the same links as the inbox: burned roster, This Week, builder, receipt).
- **No tracking:** SendGrid open and click tracking off (PRD-007 §9: no analytics in Phase A). Links go straight to `app.` / `app-staging.burnoutfantasy.com`.
- **Footer:** why you got it ("You get lock and burn emails. Change that in Account → Notifications"), a manage link, and **one-click unsubscribe** (`List-Unsubscribe` + `List-Unsubscribe-Post`, RFC 8058), which turns off all non-required email for that user.
- **Never in an email:** another manager's picks, ownership, anything pre-lock about someone else, links that sign you in. Links open the app, which asks for sign-in as usual.

## 6. Preferences

- Table `notification_preferences (user_id, channel, kind, enabled, updated_at)`, PK `(user_id, channel, kind)`. No row = the default in §4. Channel is `email` now, `push` in Phase 2.
- `users.email_notifications` (`on` / `off`): the unsubscribe switch. `off` stops everything except required transactional mail.
- API (as built): `GET /v1/me/notification-preferences` → `{ emailNotifications, email: { locks_burns, lineup_changes, receipts } }`; `PUT` takes any of those (session + CSRF, per PRD-006); groups are stored per kind, so finer switches later need no migration. `POST /v1/notifications/unsubscribe?token=…` (no session; signed, single-purpose token, `List-Unsubscribe-Post` compatible). The email's footer link opens the app's `/unsubscribe?token=…` page, which confirms before posting.
- Web: **Account → Notifications**: one switch per group ("Locks and burns", "Lineup changes we made: voids, moves, reopened slots", "Lineup receipts"), plus "Email me nothing optional". Phase 2 adds a push column.

## 7. The dispatcher (worker job `notify`)

Runs every **30 seconds** (its own loop, like feedback), under an advisory lock.

1. **Claim:** select undispatched rows that are due (immediate kinds now; others once 2 minutes old, or once the user's oldest pending notice is 2 minutes old), `FOR UPDATE SKIP LOCKED`, up to 200, and set `dispatch_claimed_at`. A claim older than 5 minutes is treated as abandoned and reclaimed.
2. **Decide per user:** drop too-late rows (§4), rows the user's preferences turn off, unverified or suspended users. These get `dispatched_at` plus `dispatch_result = 'skipped:<reason>'`.
3. **Send:** one email per user per batch, through `SendGridMailer` (new outbox method, no secrets). Player names come from `nfl_players` (as the inbox does).
4. **Record:** `dispatched_at`, `dispatch_result = 'sent'`, SendGrid message id. On failure: `dispatch_attempts + 1`, back off (1, 5, 15 minutes), give up after 5 tries with `dispatch_result = 'failed:<status>'` and an error log line. A 4xx for a bad address marks it failed at once.
5. **At least once:** the send happens before `dispatched_at` is written, so a crash between them can send a duplicate. That's preferred to losing a notice. SendGrid gets the notice ids as a custom arg for tracing.

New columns on `notification_queue`: `dispatch_claimed_at`, `dispatch_attempts`, `dispatch_next_at` (retry time), `dispatch_result` (`sent`, `skipped:<reason>`, `failed:<status>`, CHECKed), `dispatch_ref` (SendGrid message id). New migration; existing writers unchanged.

**Off switch:** `NOTIFY_EMAIL=on|off` (Railway). Off by default in code; on in staging now; production when SendGrid's domain is authenticated. With it off, the job does nothing and logs once.

## 8. Ops

- Each run logs one JSON line: claimed, sent, skipped by reason, failed.
- `GET /v1/admin/notifications/stats` (admin + step-up): last 24 hours by kind and result, oldest pending age. An oldest-pending age over 10 minutes is logged as an error, so a stalled sender is visible in Railway's logs.

## 9. Phase 2 — web push (outline, its own approval)

- VAPID key pair in Railway env (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`); the public key also goes in the web build as a non-secret.
- `push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at, last_ok_at, revoked_at)`; `POST/DELETE /v1/me/push-subscriptions`.
- `apps/web`: `sw.js` (shows the notification, opens the linked screen on tap), `manifest.webmanifest`, the CSP gains `worker-src 'self'`; Account → Notifications gets an "Allow on this device" button (the browser's permission prompt only on that tap, never on page load).
- The dispatcher fans out to push with the same grouping and preferences; a `410 Gone` from the push service revokes that subscription.
- iPhone: works only from the home-screen app; the app shows a one-time "Add to Home Screen for alerts" hint on iOS Safari.

## 10. Testing

- Unit: grouping, too-late, preferences and defaults, subject and body text per kind (names, ET times, no other manager's data), unsubscribe token signing.
- Integration (Postgres): claim with `SKIP LOCKED` across two workers (no double send), retry and backoff, give-up, crash-between-send-and-record (duplicate allowed, never lost), unsubscribe end to end, `NOTIFY_EMAIL=off` does nothing.
- End to end: the e2e lock-and-burn flow (PRD-007) also asserts one grouped email lands in the in-memory mailer with the right link.
- Mutation checks as for PRD-006.

## 11. Acceptance criteria

- [ ] With `NOTIFY_EMAIL=on`, a lock at 8:15 PM ET produces one email per affected user within 3 minutes, naming the players and linking to This Week.
- [ ] A burn produces one email per user per window within 3 minutes of the burn, naming the players and their points.
- [ ] A voided pick emails within 1 minute and links to the builder.
- [ ] No notice older than 6 hours is ever emailed (payment notices: 24 hours).
- [ ] Turning a group off stops those emails; one-click unsubscribe stops all optional email; required transactional mail still arrives.
- [ ] Two worker replicas never send the same notice twice; a SendGrid outage retries and then gives up visibly.
- [ ] Emails contain no tracking, no other manager's picks, no sign-in links, no player images.

## 12. Open questions

| # | Question | Recommendation |
|---|----------|----------------|
| Q1 | Lock and burn emails on by default? Up to ~6 locks and ~6 burns a week. | **On for Phase A testers** (you're testing exactly this). Revisit at launch: likely burns on, locks off, with push carrying locks. |
| Q2 | Group notices within 2 minutes into one email? | **Yes.** Sunday 1:00 PM is the busy window; grouping keeps it to one email. Voids and moves skip the wait. |
| Q3 | Email the lineup receipt? | **Yes.** It's the player's own copy of the evidentiary record (time, slots, checksum), outside our system. |
| Q4 | Sender address | **`alerts@burnoutfantasy.com`** for notices; verification and reset keep `MAIL_FROM`. Both need the domain authenticated in SendGrid. |
| Q5 | Push in this patch or the next? | **Next.** Email can be live for Thursday; push needs the service worker, keys and an iPhone home-screen flow, and deserves its own pass. |

### 12.1 Decisions (2026-10-28) and notes for later

Q1–Q5 approved as recommended. Nath's notes, **not for Phase 1**:

- **Times in the player's own time zone.** Notices (and eventually the app) will need to show times in the user's time zone. Phase 1 keeps ET, labeled, as everywhere else (PRD-007 §5.2). When it's taken up: a stored time-zone preference (defaulting from the browser), every rendered time converted, and "ET" replaced by the zone's abbreviation. Lock rules don't change: locks stay at the scheduled kickoff, whatever the display zone.
- **The 2-minute grouping window may be too narrow.** Watch how many emails a busy Sunday produces per player and widen it if needed. The window is a setting (`NOTIFY_GROUP_SECONDS`, default 120), so changing it needs no code.
- **Finer-grained opt-outs.** Phase 1 offers three groups plus "email me nothing optional". Players may later want more control (for example burns but not locks, or only their first lock of the week); revisit with real usage.

## 13. Sequencing

1. Approve this PRD (Q1–Q5).
2. Phase 1 patch: migration, dispatcher, templates, preferences API, unsubscribe, Account → Notifications, tests. Target: ready Thursday morning.
3. Railway: `NOTIFY_EMAIL=on` and `NOTIFY_FROM` in staging; SendGrid domain authentication (user).
4. Phase 2 (push) as its own patch after the Week 8 games.

Depends on: PRD-001 (lock/burn notices), PRD-006 (worker, auth, CSRF), PRD-007 (inbox links, Account), SendGrid domain authentication.

---

## Change log

| Version | Date | Changes |
|---------|------|---------|
| 1.2 | 2026-10-28 | Phase 1 built: dispatcher (`notify` job, 30 s), templates, preferences by group, one-click unsubscribe and confirm page, Account → Notifications, admin stats, Railway settings (`NOTIFY_EMAIL`, `NOTIFY_FROM`, `NOTIFY_GROUP_SECONDS`, `API_PUBLIC_URL`). |
| 1.1 | 2026-10-28 | Approved with Q1–Q5 as recommended. §12.1: notes for later (user time zones, grouping window as a setting, finer opt-outs). |
| 1.0 | 2026-10-28 | First draft. |

*End of PRD-008*
