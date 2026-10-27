# PRD-004 — Payments
**Burnout League · packages/payments**
Version 1.3 · 2026-10-27
Status: APPROVED — implement against this spec (v1.3 changes: see change log)

---

## 1. Purpose

This package moves money for season-long contest pools. It collects entry fees, keeps the prize pool apart from platform money, pays winners from the official final standings, and keeps a ledger that proves every cent is where it should be.

It is processor-agnostic. All processor calls go through one adapter interface (§7). Stripe is the candidate processor, but its Prohibited Businesses list names fantasy sports leagues and paid-entry prize contests, and it allows them only with explicit prior approval. **No real money moves until a processor has approved this use case in writing** (§7.3).

This PRD is the single source of truth for entry payment, prize tables, settlement and payouts. Code that conflicts with it is wrong.

---

## 2. Definitions

| Term | Definition |
|------|-----------|
| **Buy-in** | The entry fee for one pool, in cents. |
| **Rake** | The platform's service fee, a fixed percentage of each buy-in (§4.2). |
| **Prize contribution** | Buy-in minus rake. This is the part of each entry fee that belongs to the prize pool. |
| **Capacity** | The most entries a pool accepts. The prize table is published for a full pool. |
| **Prize pool** | Capacity × prize contribution. It is fixed and published before entry opens (§5). |
| **Minimum field** | The fewest entries a pool needs to run. Below it at entry close, the pool is cancelled and everyone is refunded. |
| **Overlay** | Prize pool minus the prize contributions actually collected. The platform pays it when a pool runs with fewer entries than capacity. |
| **Prize table** | Each paid finishing place and its prize, published with the pool. |
| **Min cash** | The smallest prize in a table. |
| **Award** | The amount one entry wins at settlement, after tie splits. |
| **Settlement** | Turning the official final standings into awards. |
| **Payout** | Sending an award to the winner's bank account. |
| **Ledger** | The internal double-entry record of every money movement (§6). |
| **Adapter** | The code that talks to a payment processor (§7). |

---

## 3. Locked Decisions

| # | Decision | Source |
|---|----------|--------|
| D1 | Processor-agnostic PRD. Stripe is the candidate, pending written approval. No live money before that approval. | Decision 2026-10-26 |
| D2 | No wallet and no stored balance. Users pay for each entry at checkout, and winnings go straight to their bank account. | Decision 2026-10-26 |
| D3 | Top 20% of capacity is paid. The table is tiered and top-heavy, and min cash is at least 1.5× the buy-in. | Decision 2026-10-26 |
| D4 | Web checkout is the main payment path. Mobile opens web checkout (§8.4). | Build constraints |
| D5 | The prize pool is never mixed with operating money, and processing fees come out of rake, never the prize pool. | Exec summary §4.1; T&C §5.2 |
| D6 | A contest entry is created only after its payment is captured. | PRD-003 §3 |
| D7 | One entry per verified person per pool. Entry closes at the **Week 3 lock**; a late entry's prize standings count only from the week it was paid. | PRD-003 §3 (v1.4) |
| D8 | Settlement uses only the OFFICIAL Week 18 leaderboard snapshot. | PRD-003 §4 |
| D9 | Tied entries split the combined prizes of the places they occupy, evenly. | PRD-002 §9 |
| D10 | A W-9 is required before the first payout. | T&C §5.5 |
| D11 | Season-long payouts start within 5 business days of the last regular-season game going Final. | T&C §5.6 |
| D12 | Standard ACH payout is free. Instant payout is optional and the user pays its fee. | Exec summary §4.1 |
| D13 | No refunds once entry has closed, except for platform error or pool cancellation. | T&C §5.1 |
| D14 | Restricted jurisdictions are checked at registration and at checkout, and the list lives in the database. | Exec summary §5.3 |
| D15 | Step-up authentication is required for every financial action. | T&C §3.3 |

---

## 4. Money Rules

### 4.1 Integer cents everywhere

Every amount is an integer number of cents (`bigint` in Postgres, `number` in TypeScript). No floating point appears in any money path. Rounding rules are spelled out wherever division happens (§5.2, §9.3).

### 4.2 Rake schedule

| Buy-in | Rake | Prize contribution |
|--------|------|--------------------|
| $25 | 15% | $21.25 |
| $50 | 12% | $44.00 |
| $100 | 10% | $90.00 |
| Other | 10% unless set on the pool | — |

`rake_cents = floor(buy_in_cents × rake_bps / 10000)`. Each pool stores its own `rake_bps`, so a later schedule change never alters a published pool.

### 4.3 Disclosure

The checkout confirmation shows a receipt line: **Entry fee $25.00 · Service fee $3.75 · Prize pool contribution $21.25**, plus the guaranteed prize pool for the pool. The contest rules page describes prizes and does not discuss rake. Rake terms live in the Terms of Service.

### 4.4 Processing fees

Processor fees post to `processing_fees` (an operating expense). Refunds where the platform eats the fee, chargeback fees and chargeback losses also post to operating accounts. No posting rule anywhere in this PRD may debit a prize liability account for a fee or loss (AC8, AC14).

---

## 5. Prize Pools and Prize Tables

### 5.1 Fixed prize pool (LOCKED, subject to legal opinion)

The federal fantasy-sports exemption in UIGEA (31 U.S.C. §5362(1)(E)(ix)(I)) requires that all prizes be "established and made known to the participants in advance of the game or contest" and that their value is "not determined by the number of participants or the amount of any fees paid by those participants." Several state fantasy-contest laws copy this language.

A pool whose prizes grow with each entry, where the hero number is the current pool total, fails that test on its face. So:

- Each pool publishes a **fixed prize table** for its capacity before entry opens. Its total is the prize pool.
- The prize table is **immutable** once published, and a database trigger enforces this.
- The pool runs on that table whatever the final field size, as long as the minimum field is met.
- If the field is below the minimum at entry close, the pool is cancelled and every entry is refunded in full (§10.3).
- If the field is between the minimum and capacity, the platform funds the overlay at entry close (§6.3).
- The pool closes to new entries when it reaches capacity.

Ops sets capacity and the minimum field per pool. Setting the minimum field equal to capacity gives a must-fill pool with no overlay risk. A low minimum field gives a guaranteed pool. Either way it is one mechanism.

**Constraint:** the minimum field must be at least the number of paid places, and the database enforces this. A pool that runs therefore always has at least one entry for every paid place, so every published prize is awarded.

The checkout hero number becomes **"Guaranteed prize pool $21,250"**. That replaces the exec summary's "current pool total" framing, which this section supersedes.

A scaling (pari-mutuel) pool is out of scope. It needs a written attorney opinion before it can be considered (§16, Q1).

### 5.2 Prize table algorithm `banded-top20-v1`

The algorithm runs once, when a pool is created. Its output is stored in `prize_table_bands`, and from then on **the stored table is authoritative**. The algorithm is never re-run against a live pool.

**Inputs:** capacity `C`, `buy_in_cents B` and `rake_bps R`.

1. **Prize pool:** `P = C·B − floor(C·B·R / 10000)`.
2. **Min cash:** `M = 1.5 × B`, rounded up to a whole dollar. For $25 that gives $38, for $50 $75 and for $100 $150.
3. **Paid places:** `K = max(1, floor(C / 5))`. If `K·M > P`, then `K = floor(P / M)`. If that is 0, then `K = 1` (winner takes all).
4. **Bands:** places 1 through 10 are paid individually. After that, bands end on the sequence 15, 20, 25, 30, 40, 50, 60, 75, 100, 150, 200, 250, 300, 400, 500, 600, 750, 1000, and so on (×1.5, 2, 2.5, 3, 4, 5, 6, 7.5 and 10 per decade). The last band ends at `K`.
5. **Weights:** `w(i) = i^(−1.2)`, and `W = Σ w(i)` for i = 1 to K. A band's weight per place is the mean of `w` over its places.
6. **Prize per place:** `M + floor_to_dollar((P − K·M) × band_weight / W)`.
7. **Remainder:** whatever is left after step 6 (always less than K dollars) goes to 1st place.

**Guarantees, each tested:**
- The table sums to exactly `P`.
- Prizes never increase from one place to the next.
- Every prize is at least `M`.
- Every prize except possibly 1st is a whole dollar.

**Weight approximation:** step 5 uses an integer fixed-point power table, so no floats are involved. The fixtures in §5.3 are the source of truth for the implementation.

### 5.3 Example tables (fixtures; for review)

These are the default capacities proposed for the 2026-27 season. Each prize pool is about $21–22.5K. Ops can change capacities before a pool is published (§16, Q2).

| Place | $25 × 1,000 (pool $21,250) | $50 × 500 (pool $22,000) | $100 × 250 (pool $22,500) |
|-------|------|------|------|
| 1 | $3,676.00 (17.3%) | $4,154.00 (18.9%) | $4,705.00 (20.9%) |
| 2 | $1,577.00 | $1,826.00 | $2,122.00 |
| 3 | $984.00 | $1,151.00 | $1,362.00 |
| 4 | $708.00 | $837.00 | $1,008.00 |
| 5 | $550.00 | $658.00 | $806.00 |
| 6 | $449.00 | $543.00 | $677.00 |
| 7 | $380.00 | $464.00 | $588.00 |
| 8 | $329.00 | $406.00 | $523.00 |
| 9 | $291.00 | $363.00 | $474.00 |
| 10 | $261.00 | $328.00 | $435.00 |
| 11–15 | $203.00 | $263.00 | $362.00 |
| 16–20 | $149.00 | $201.00 | $292.00 |
| 21–25 | $120.00 | $168.00 | $255.00 |
| 26–30 | $103.00 | $149.00 | $233.00 |
| 31–40 | $87.00 | $131.00 | $213.00 |
| 41–50 | $74.00 | $116.00 | $196.00 (last paid) |
| 51–60 | $66.00 | $107.00 | — |
| 61–75 | $60.00 | $100.00 | — |
| 76–100 | $54.00 | $93.00 (last paid) | — |
| 101–150 | $48.00 | — | — |
| 151–200 | $45.00 (last paid) | — | — |

Small-pool fixtures:
- $25 × 50: pool $1,062.50, 10 paid. 1st gets $318.50, 2nd $158.00, and 10th $55.00.
- $25 × 10: pool $212.50, 2 paid. 1st gets $133.50 and 2nd $79.00.

At 1,000 capacity, 1st place returns about 147× the buy-in, and the last paid place returns 1.8×.

---

## 6. Ledger

### 6.1 Model

The ledger is double-entry and append-only. Each transaction has two or more entries, and the signed amounts in a transaction sum to zero (debits positive, credits negative).

Two rules are enforced in Postgres, not in application code:
- A deferred constraint trigger rejects any transaction whose entries do not sum to zero at commit.
- `ledger_transactions` and `ledger_entries` reject UPDATE and DELETE, using the existing `burnout_append_only()` function. A correction is a new reversing transaction.

### 6.2 Accounts

| Account | Kind | Scope | Meaning |
|---------|------|-------|---------|
| `processor_clearing:prize` | asset | global | Prize share of captured funds still held at the processor |
| `processor_clearing:operating` | asset | global | Rake share (less fees) still held at the processor |
| `prize_bank` | asset | global | The segregated prize-fund account (§6.5) |
| `operating_bank` | asset | global | Platform operating account |
| `prize_liability:{pool}` | liability | per pool | Owed to that pool's winners |
| `payable:{user}` | liability | per user | Awarded but not yet paid out |
| `refund_payable:{user}` | liability | per user | Refund owed, not yet confirmed by the processor |
| `rake_revenue` | revenue | global | Service fees |
| `processing_fees` | expense | global | Processor fees, including refunds where the platform eats the fee |
| `overlay_expense` | expense | global | Overlay funded by the platform |
| `chargeback_loss` | expense | global | Disputes lost |

### 6.3 Posting rules

Example: one $25 entry at 15% rake, with a processor fee of $1.03.

| Event | Debit | Credit |
|-------|-------|--------|
| Payment captured | `processor_clearing:prize` 2125, `processor_clearing:operating` 375 | `prize_liability:{pool}` 2125, `rake_revenue` 375 |
| Capture rejected (never entered, §8.3) | `processor_clearing:operating` 2500 | `refund_payable:{user}` 2500 |
| Processor fee reported | `processing_fees` 103 | `processor_clearing:operating` 103 |
| Processor settles funds to the banks | `prize_bank` (prize share), `operating_bank` (rest) | `processor_clearing:prize`, `processor_clearing:operating` |
| Ops transfer (e.g. funding an overlay) | `prize_bank` | `operating_bank` |
| Entry close, field below capacity | `overlay_expense` (P − collected) | `prize_liability:{pool}` |
| Settlement approved | `prize_liability:{pool}` P | `payable:{user}` per award |
| Payout paid | `payable:{user}` | `prize_bank` |
| Payout failed or returned | `prize_bank` | `payable:{user}` (reverses the payout) |
| Refund issued (full) | `prize_liability:{pool}` 2125, `rake_revenue` 375 | `refund_payable:{user}` 2500 |
| Refund confirmed | `refund_payable:{user}` 2500 | `processor_clearing:prize` 2125, `processor_clearing:operating` 375 (all operating for a rejected capture) |
| Chargeback lost | `chargeback_loss` (amount + fee) | `processor_clearing:operating` |

The table names only accounts. Every transaction also records `ref_type` and `ref_id` (an entry intent, payout, settlement or dispute) and an idempotency key, which is unique.

The processor-settlement row depends on how the processor separates funds. The adapter reports what actually landed where (§7.1).

### 6.4 Integrity check

The check runs weekly, before settlement approval, and on demand. It fails loudly and blocks settlement if any of these is false:

1. Every ledger transaction balances. The trigger guarantees this, and the check re-proves it.
2. For each open pool: `prize_liability:{pool}` = Σ prize contributions of captured, non-refunded entries + posted overlay.
3. For each open pool: number of contest entries = number of captured, non-refunded entry intents.
4. For each settled pool: `prize_liability:{pool}` = 0, and Σ awards = P.
5. Σ `payable:*` + Σ `prize_liability:*` ≤ `prize_bank` + `processor_clearing:prize`. An overlay posted at close but not yet funded by an ops transfer fails this check, which blocks settlement until the prize fund is topped up.

Check 5 compares the ledger to itself. Reconciliation against the real bank statement is an ops task: ops enters statement balances in `bank_reconciliations`, and the check compares them to `prize_bank`.

### 6.5 Prize-fund custody

`prize_bank` is a dedicated account that holds only prize money. Which institution holds it, whether it is titled as a trust or FBO account, and any state reserve or bond rules are banking and legal questions (§16, Q4). The ledger works the same way either way.

---

## 7. Processor Adapter

### 7.1 Interface

```ts
interface PaymentProcessor {
  readonly name: string;                       // 'fake' | 'stripe' | …
  readonly live: boolean;

  createCheckout(req: {
    intentId: string; userId: string; amountCents: number; description: string;
    expiresAt: Date; successUrl: string; cancelUrl: string; idempotencyKey: string;
  }): Promise<{ checkoutUrl: string; checkoutRef: string }>;

  refund(req: { paymentRef: string; amountCents: number; idempotencyKey: string }): Promise<{ refundRef: string }>;

  createPayoutOnboardingLink(req: { userId: string; returnUrl: string }): Promise<{ url: string }>;
  getPayoutAccount(userId: string): Promise<PayoutAccountStatus | null>;

  /** Fee for an instant payout of this amount, shown before the user confirms. */
  instantPayoutFeeCents(amountCents: number): number;

  sendPayout(req: {
    payoutId: string; userId: string; amountCents: number;
    speed: 'standard' | 'instant'; idempotencyKey: string;
  }): Promise<{ payoutRef: string; feeCents: number }>;

  /** Verifies the signature and normalizes the payload. Throws on a bad signature. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string>): ProcessorEvent;
}

type ProcessorEvent =
  | { type: 'payment_captured'; eventId: string; intentId: string; paymentRef: string; amountCents: number; occurredAt: Date }
  | { type: 'payment_failed';   eventId: string; intentId: string; occurredAt: Date }
  | { type: 'fee_reported';     eventId: string; paymentRef: string; feeCents: number; occurredAt: Date }
  | { type: 'funds_settled';    eventId: string; prizeCents: number; operatingCents: number; occurredAt: Date }
  | { type: 'refund_succeeded'; eventId: string; refundRef: string; occurredAt: Date }
  | { type: 'dispute_opened';   eventId: string; paymentRef: string; amountCents: number; occurredAt: Date }
  | { type: 'dispute_closed';   eventId: string; paymentRef: string; outcome: 'won' | 'lost'; feeCents: number; occurredAt: Date }
  | { type: 'payout_paid';      eventId: string; payoutRef: string; occurredAt: Date }
  | { type: 'payout_failed';    eventId: string; payoutRef: string; reason: string; occurredAt: Date }
  | { type: 'account_updated';  eventId: string; userId: string; accountRef: string; status: PayoutAccountStatus; occurredAt: Date };

interface PayoutAccountStatus {
  payoutsEnabled: boolean;     // KYC done and a bank account attached
  tinVerified: boolean;        // W-9 collected and the TIN matched
  instantEligible: boolean;
}
```

### 7.2 Webhooks

- Every event is first stored in `processor_events` under the unique key `(processor, event_id)`. A duplicate is acknowledged and ignored.
- Each event is handled in one transaction that combines the state claim, the ledger posting and any entry creation.
- Every state change is a conditional claim (`UPDATE … WHERE status = … RETURNING`), the same pattern the burn engine uses. Replays and races cannot double-post.
- Events can arrive out of order. A handler that finds its precondition not yet met (for example `fee_reported` before `payment_captured`) leaves the event unprocessed for retry.

### 7.3 Live-money guard

- `FakeProcessor` is the only adapter used in development and tests. It runs in memory and can be scripted to emit any event.
- A live adapter starts only if `PAYMENTS_LIVE=true` is set **and** the `processor_approvals` table has a row for that processor, recording the approval document reference and the approver.
- If either is missing, the app refuses to start the live adapter and logs the reason.
- Processor secrets live in Railway environment variables only and are never committed, the same rule as the MSF key.

---

## 8. Entry Flow

### 8.1 Eligibility gate

The server runs these checks every time a checkout is requested. Any failure returns a specific reason code.

| Check | Reason code |
|-------|-------------|
| Pool is `open` and now < `entry_closes_at` | `ENTRY_CLOSED` |
| Entries + live holds < capacity | `POOL_FULL` |
| User has a verified identity (§11.1) | `IDENTITY_UNVERIFIED` |
| User meets the minimum age for their state | `UNDER_AGE` |
| IP-derived state **and** billing state are both allowed (§11.2) | `JURISDICTION_BLOCKED` |
| No existing entry, and no live hold, for this user in this pool | `ALREADY_ENTERED` |
| No open dispute and no account hold | `ACCOUNT_HOLD` |
| Step-up authentication within the last 5 minutes | `STEP_UP_REQUIRED` |

### 8.2 Checkout

1. When the gate passes, the server creates an `entry_intents` row in `pending` status. That row holds a seat. The hold expires at whichever is earlier: 15 minutes from creation, or `entry_closes_at`.
2. The seat count is checked and the hold inserted in one transaction, under `SELECT … FOR UPDATE` on the pool row. Two users cannot take the last seat.
3. The server calls `createCheckout`. The processor's session expiry is no later than the hold's expiry.
4. The user pays on the processor's hosted page. Card data never reaches Burnout servers.

### 8.3 Capture

When `payment_captured` arrives, one transaction does the following:

1. Claims the intent: `pending` or `expired` → `captured`.
2. Checks that the pool is still open, now < `entry_closes_at`, and either a seat is held or a seat is free.
   - If yes: posts the capture to the ledger and inserts the `contest_entries` row. Entry time is capture time.
   - If no: marks the intent `refund_pending`, posts the refund to the ledger and calls `refund`. No entry is created.
3. Queues a receipt email through the notification outbox.

Holds that expire are released by a sweep. A capture that arrives after its hold expired is honored only if a seat is free and the pool is still open.

### 8.4 Mobile

The mobile app opens web checkout in the system browser. It does not use in-app purchase for entries: Apple's guideline 5.3.3 forbids using in-app purchase for credit or currency used in real-money gaming. The exec summary's revenue line for contest buy-ins through app-store purchases should be removed (§16, Q8).

---

## 9. Settlement

### 9.1 Trigger and inputs

Settlement for a pool can start only when all of these hold:
- Week 18 has frozen (PRD-002 §7).
- The pool has an `official` snapshot for Week 18 (PRD-003 §8).
- The integrity check (§6.4) passes.

Settlement reads **only** that snapshot: its `user_id`, `rank` and `points_x100` columns. It never reads live scores, the cache or the board API.

### 9.2 Steps

1. **Compute.** Build awards from the snapshot (§9.3) and write `settlements` (status `computed`) and `settlement_awards`. Running compute again for a computed pool returns the existing result.
2. **Verify.** Check that Σ awards = P, that every rank in the snapshot matches a fresh `RANK()` over its own points, and that the award count is at least K.
3. **Approve.** An admin with fresh step-up approves the settlement. One transaction claims `computed` → `approved` and posts `prize_liability → payable` for every award. Approving twice posts once.
4. **Pay.** Payouts are created as in §10.

### 9.3 Tie splits and cent rounding

Take a group of `n` entries that share rank `r`. It occupies places r through r+n−1.

- The group's total is the sum of the prizes for places r through min(r+n−1, K). Places beyond K pay $0.
- Each member gets `floor(total / n)`.
- The leftover cents (always fewer than `n`) go one each to members in ascending `entry_id` order. Entry IDs are random UUIDs, so this is effectively a coin flip worth at most 1¢. It is stated in the rules and carries no competitive meaning.
- A tie that straddles the cash line splits only the paying places. Each member may then receive less than min cash, or even less than the buy-in, and the rules say so plainly.
  - Example: three entries tied for places 199–201 of 200 share the prizes for 199 and 200 ($90.00), so each gets $30.00.

Σ awards = P exactly for every tie pattern. This is property-tested (AC10).

---

## 10. Payouts, Refunds and Disputes

### 10.1 Payout gating

A payout is created only if the user's payout account has `payoutsEnabled` **and** `tinVerified`. Otherwise:
- The award stays in `payable:{user}`.
- The user is told to add a bank account and W-9, by email and in the app, at approval (day 0) and again on day 1, 7 and 30.
- An `account_updated` event that turns both flags true releases the payout automatically.

### 10.2 Timing and speed

- Payouts for an approved settlement are sent no later than 5 business days after the last regular-season game goes Final (D11).
- `standard` (ACH) is the default and free.
- `instant` can be requested by the user with step-up. Its fee is deducted from the payout and shown before the user confirms.
- Each award produces one payout, with idempotency key `payout:{settlement}:{user}`.
- A failed or returned payout reverses to `payable` and notifies the user (AC13). The next attempt waits until the user updates their payout account, so a bad bank account is not retried in a loop.

### 10.3 Refunds

v1 has no self-serve withdrawal. A refund always returns the **full** buy-in, and the platform absorbs the processing fee. Refunds happen only for these reasons:

| Reason | When |
|--------|------|
| `CAPTURE_AFTER_CLOSE` | Capture arrives after entry close, with the pool full or not open (§8.3) |
| `POOL_CANCELLED` | Below the minimum field at entry close: every entry in the pool |
| `DUPLICATE_CHARGE` | The processor captured twice for one intent |
| `PLATFORM_ERROR` | Ops, with a written reason, before entry close only |

Refunding an entry that already exists writes a row to `contest_entry_voids`, which is append-only, with a reason. PRD-003 boards and snapshots exclude voided entries.
- A void is allowed only before `entry_closes_at`, or for a cancelled pool. A trigger enforces this.
- After close, the field is permanent.

This is a small change to PRD-003 §3 ("every entry is ranked"), bundled into this build.

### 10.4 Chargebacks

- `dispute_opened` puts an account hold on the user: no new entries and no payouts. The user's existing entries stay in their pools, because removing one after close would change the field.
- A dispute that is won lifts the hold.
- A dispute that is lost posts the amount and fee to `chargeback_loss`. The prize pool is never reduced.
- Whether a lost chargeback can be offset against that user's winnings is an attorney question (§16, Q6). Until it is answered, winnings stay held in `payable`.

---

## 11. Identity, Jurisdiction and Tax

### 11.1 Verified identity

- Entry requires a verified identity: legal name, date of birth and address, checked by an identity provider behind an `IdentityVerifier` adapter.
- The platform stores only the status, the provider's reference, the verified state and a **hash** of the provider's person identifier. It never stores ID numbers or images.
- The person hash is unique across accounts. One person cannot verify two accounts, which enforces "one entry per verified person".
- Multiple accounts are allowed only under distinct verified identities (T&C §3.2).

### 11.2 Jurisdictions

`jurisdictions` holds one row per state, plus optional sub-regions such as Louisiana parishes. Each row has `status` (allowed or blocked), `min_age`, effective dates and a source note.

Checks:
- At registration and at checkout, the IP-derived state and the billing state must both be allowed.
- At payout onboarding, the verified address state must be allowed.

The seed data is the exec summary list (HI, ID, MT, WA, NV), pending counsel's final list. Two conservative placeholders until counsel answers:
- **Louisiana is blocked as a whole** until counsel supplies the list of parishes where paid fantasy contests are allowed. Parish rows then go in as sub-regions.
- **Minimum ages:** 18 by default, 19 in AL and NE (age of majority), and 21 in MA, AZ and IA.

A region with no allowed row in force is blocked (default deny).

### 11.3 Tax reporting

- Prize winnings are reported on **Form 1099-MISC**, not Form 1099-K.
- The reporting threshold is **$2,000 for payments made in 2026**, indexed for inflation after that. It lives in a `tax_thresholds` table keyed by tax year.
- Season-long payouts made in January fall in that January's tax year.
- The `user_tax_year_totals` view sums prizes paid and entry fees paid per user per calendar year, and flags users at or above the threshold.
- Whether the threshold applies to gross prizes or to net winnings (prizes minus entry fees, as major operators report) is a CPA question (§16, Q5). The view exposes both.
- T&C §5.5 currently says "Form 1099-K, $600". That needs to change.

---

## 12. Database Schema — Payments Tables

The new tables live in migration `2026102800xxxx_payments`, with a companion `_payments_guards` migration for triggers.

| Table | Key columns | Guards |
|-------|-------------|--------|
| `contest_pools` (add columns) | `capacity`, `min_entries`, `rake_bps`, `status` (draft/open/closed/cancelled/settled), `prize_pool_cents` | `min_entries ≥ paid places`. Money columns are frozen once status leaves `draft`. |
| `prize_table_bands` | `pool_id`, `from_place`, `to_place`, `prize_cents` | Immutable once the pool is published. Bands must be contiguous from 1, and their sum must equal `prize_pool_cents`. |
| `entry_intents` | `id`, `user_id`, `pool_id`, `amount_cents`, `rake_cents`, `status` (pending/expired/failed/captured/refunded), `hold_expires_at`, `checkout_ref`, `payment_ref`, `ip_region`, `billing_region`, `captured_at` | Status moves only along allowed transitions. At most one pending intent per (user, pool). |
| `refunds` | `id`, `user_id`, `intent_id`, `payment_ref`, `amount_cents`, `prize_share_cents`, `reason`, `status`, `refund_ref` | One per payment. Terms immutable; status only pending → succeeded. |
| `contest_entry_voids` | `entry_id`, `reason`, `voided_at`, `voided_by` | Append-only. Only before close, or for a cancelled pool. |
| `processor_events` | `processor`, `event_id`, `type`, `payload`, `received_at`, `processed_at` | Unique on (processor, event_id). |
| `processor_approvals` | `processor`, `approved_at`, `document_ref`, `recorded_by` | Append-only |
| `ledger_accounts` | `code`, `kind`, `pool_id?`, `user_id?` | — |
| `ledger_transactions` | `id`, `kind`, `ref_type`, `ref_id`, `idempotency_key`, `occurred_at` | Append-only. Idempotency key unique. |
| `ledger_entries` | `txn_id`, `account`, `amount_cents` | Append-only. Deferred trigger requires each transaction to sum to 0. |
| `settlements` | `pool_id`, `snapshot_week`, `status`, `computed_at`, `approved_by`, `approved_at` | One per pool |
| `settlement_awards` | `pool_id`, `entry_id`, `user_id`, `rank`, `tie_size`, `amount_cents` | Immutable. Sum must equal `prize_pool_cents` at approval. |
| `payout_accounts` | `user_id`, `processor`, `account_ref`, `payouts_enabled`, `tin_verified`, `instant_eligible` | — |
| `payouts` | `id`, `user_id`, `pool_id`, `attempt`, `amount_cents`, `fee_cents`, `speed`, `status`, `payout_ref`, `idempotency_key` | Status moves only along allowed transitions. At most one live (pending/sent/paid) payout per award. Speed changes only while pending. |
| `account_holds` | `user_id`, `reason`, `opened_at`, `closed_at` | — |
| `identity_verifications` | `user_id`, `provider`, `provider_ref`, `person_hash`, `status`, `verified_state`, `dob_verified_at` | `person_hash` unique among verified rows |
| `jurisdictions` | `country`, `region`, `sub_region?`, `status`, `min_age`, `effective_from`, `effective_to` | — |
| `tax_thresholds` | `tax_year`, `form`, `threshold_cents` | — |
| `bank_reconciliations` | `account`, `statement_date`, `balance_cents`, `entered_by` | Append-only |

`contest_entries` also gains a guard: no entry can be inserted into a pool that is closed, cancelled or settled, whatever `entered_at` claims.

**No sensitive financial data:** no table stores a card number, bank account number, SSN or TIN. Only processor and provider references are kept. This is checked by a schema test (AC19).

---

## 13. API

| Endpoint | Purpose |
|----------|---------|
| `GET /pools/:id/prizes` | Published prize table, guaranteed prize pool, capacity, seats left and entry close time |
| `POST /pools/:id/checkout` | Runs the gate, creates the hold and returns the checkout URL. Requires step-up. |
| `POST /webhooks/:processor` | Processor events. Signature verified by the adapter. |
| `GET /me/entries/payments` | The user's receipts and refunds |
| `GET /me/payouts` | Awards, payout status and what is blocking a payout |
| `POST /me/payout-account/link` | Payout onboarding link (bank account + W-9). Requires step-up. |
| `POST /me/payouts/:id/instant` | Request instant payout and show the fee. Requires step-up. |
| `POST /admin/settlements/:pool/compute` · `/approve` | Admin only. `approve` requires step-up. |
| `GET /admin/integrity` | Runs the §6.4 check |

---

## 14. Acceptance Criteria

| # | Criterion |
|---|-----------|
| AC1 | Prize table: across a sweep of capacities from 1 to 100,000, buy-ins of $25, $50 and $100, and every rake, every table sums to P, never increases, has every prize ≥ M and has K = min(⌊C/5⌋, ⌊P/M⌋) with a minimum of 1. The §5.3 fixtures match exactly. |
| AC2 | A published prize table and pool money columns reject UPDATE and DELETE at the database level. |
| AC3 | The gate returns the right reason code for each of the eight checks in §8.1. |
| AC4 | 50 concurrent checkouts for 3 remaining seats produce exactly 3 holds (fewer seats than concurrent transactions, so a missing lock would oversell). |
| AC5 | Delivering the same `payment_captured` event twice produces one entry and one ledger transaction. |
| AC6 | A capture after close, or into a full pool, produces no entry and a full refund, and the user's ledger nets to zero. |
| AC7 | An unbalanced ledger transaction is rejected at commit. Ledger UPDATE and DELETE are rejected. |
| AC8 | After N entries with processor fees, `prize_liability:{pool}` equals N × prize contribution exactly. No posting path debits a prize liability for a fee. |
| AC9 | Settlement refuses to run without an official Week 18 snapshot or with any week unfrozen, and reads nothing but the snapshot. |
| AC10 | Ties: a property test over random tie patterns, including ties at the cash line, gives Σ awards = P. The §9.3 example produces $30.00 × 3. |
| AC11 | Compute and approve are idempotent. Awards are immutable. A double approval posts once. |
| AC12 | No payout is created without `payoutsEnabled` and `tinVerified`. An `account_updated` event releases held awards. |
| AC13 | Payout webhooks are idempotent. A failed payout reverses to `payable` and notifies the user. |
| AC14 | A lost chargeback posts to `chargeback_loss`, and the prize liability is unchanged. An open dispute blocks new entries and payouts. |
| AC15 | A field below the minimum at close cancels the pool and refunds every entry. A field between the minimum and capacity posts exactly P − collected as overlay. |
| AC16 | `user_tax_year_totals` gives correct gross and net per calendar year and flags users using the threshold for the year of payment. |
| AC17 | The live adapter refuses to start without both `PAYMENTS_LIVE=true` and a processor approval row. |
| AC18 | The integrity check catches each planted fault: an extra entry with no capture, a liability mismatch, and awards that do not sum to P. |
| AC19 | A schema test finds no column that could hold a card number, bank account number, SSN or TIN. |
| AC20 | Voided entries are excluded from PRD-003 boards and snapshots, and a void after close is rejected. |

As with PRD-001 to PRD-003, every critical rule gets a mutation check: break the rule, and confirm a test fails.

---

## 15. Out of Scope for PRD-004

- Weekly contests. These need their own PRD; the same ledger and adapter apply.
- Closed leagues and commissioner payout structures (P3).
- Pri/Alt insurance (PRD-005, P2).
- Scaling (pari-mutuel) prize pools (§5.1).
- Wallets and stored balances (D2).
- In-app purchase for entries (§8.4).
- Players outside the US.
- State fantasy-contest registrations, filings and fees. These are ops and legal work, not code.
- A real Stripe adapter. It is built only after written approval, against §7.1.

---

## 16. Open Questions

| # | Question | Owner |
|---|----------|-------|
| Q1 | Confirm that fixed published prize tables (§5.1) are required, and whether a minimum-field cancellation affects the analysis. The exec summary's "current pool total" framing assumes a scaling pool. | Gaming attorney |
| Q2 | Capacities and minimum fields per tier for 2026-27. §5.3 proposes 1,000 / 500 / 250, with a minimum field between the paid places and capacity. | Nath |
| Q3 | Written approval from Stripe for this use case, and a fallback processor if it says no (the exec summary names Paysafe). | Nath |
| Q4 | Prize-fund custody: which bank, trust or FBO titling, and any state reserve or bond requirements. | Attorney / bank |
| Q5 | 1099-MISC on gross prizes or net winnings, and state withholding. T&C §5.5 also needs correcting from "1099-K / $600". | CPA |
| Q6 | Can a lost chargeback be offset against the same user's winnings? | Attorney |
| Q7 | Unclaimed prizes (no W-9 ever provided): holding period and state unclaimed-property (escheatment) rules. | Attorney |
| Q8 | Remove the app-store purchase line for contest buy-ins from the exec summary and 10-year model (guideline 5.3.3). | Nath |
| Q9 | Rake conflict: T&C §5.3 says a flat 10% for season-long pools, while the exec summary has the tiered 15/12/10% this PRD uses. | Nath |
| Q10 | Identity provider choice, and whether to verify at signup or at first entry. | Nath |
| Q11 | Collusion disqualification at settlement: does a forfeited prize roll down to the next places, and how is that published in advance? | Attorney |

---

## Change log

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-10-26 | First draft |
| 1.3 | 2026-10-27 | D7: entry closes at the Week 3 lock (was Week 4), so the minimum-field / overlay decision moves with it. Free play is two weeks. |
| 1.2 | 2026-10-27 | D7: entry (and therefore the minimum-field / overlay decision at close) moves to the Week 4 lock; late entries score from `scoring_from_week`. |
| 1.1 | 2026-10-26 | Approved. From the build: clearing split into prize and operating accounts so check 5 is exact; posting rules for rejected captures and ops transfers; `instantPayoutFeeCents` and `accountRef` added to the adapter; `refunds` table; payout attempts wait for an account update after a failure; day-0 payout notice; Louisiana blocked and age placeholders pending counsel; default-deny jurisdictions; entry insert blocked after close; AC4 uses 3 seats so the race test can actually oversell without the lock. |
