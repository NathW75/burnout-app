-- PRD-004 payments guarantees that Prisma's schema language cannot express.

-- ── §5 Pools: money terms, status, publication ───────────────────────────────
ALTER TABLE "contest_pools" ADD CONSTRAINT "contest_pools_status_check"
  CHECK ("status" IN ('draft', 'open', 'closed', 'cancelled', 'settled'));
ALTER TABLE "contest_pools" ADD CONSTRAINT "contest_pools_money_terms_check" CHECK (
  "status" = 'draft' OR (
    "capacity" IS NOT NULL AND "min_entries" IS NOT NULL AND "rake_bps" IS NOT NULL AND
    "prize_pool_cents" IS NOT NULL AND "paid_places" IS NOT NULL AND "min_cash_cents" IS NOT NULL AND
    "prize_algorithm" IS NOT NULL AND "published_at" IS NOT NULL));
ALTER TABLE "contest_pools" ADD CONSTRAINT "contest_pools_terms_range_check" CHECK (
  ("capacity" IS NULL OR "capacity" >= 1) AND
  ("rake_bps" IS NULL OR "rake_bps" BETWEEN 0 AND 9999) AND
  ("min_entries" IS NULL OR "capacity" IS NULL OR "min_entries" <= "capacity") AND
  -- A pool that runs has at least one entry per paid place, so every prize is awarded (§5.1).
  ("min_entries" IS NULL OR "paid_places" IS NULL OR "min_entries" >= "paid_places"));

CREATE OR REPLACE FUNCTION burnout_pool_update() RETURNS trigger AS $$
DECLARE band_sum BIGINT; band_count INT; contiguous BOOLEAN;
BEGIN
  -- Money terms are frozen once the pool is published.
  IF OLD.status <> 'draft' AND (
       NEW.season, NEW.kind, NEW.buy_in_cents, NEW.capacity, NEW.min_entries, NEW.rake_bps, NEW.prize_pool_cents,
       NEW.paid_places, NEW.min_cash_cents, NEW.prize_algorithm, NEW.published_at)
     IS DISTINCT FROM (
       OLD.season, OLD.kind, OLD.buy_in_cents, OLD.capacity, OLD.min_entries, OLD.rake_bps, OLD.prize_pool_cents,
       OLD.paid_places, OLD.min_cash_cents, OLD.prize_algorithm, OLD.published_at) THEN
    RAISE EXCEPTION 'POOL_TERMS_FROZEN: pool % is %, its money terms cannot change', OLD.id, OLD.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status NOT IN ('draft', 'open') AND NEW.entry_closes_at IS DISTINCT FROM OLD.entry_closes_at THEN
    RAISE EXCEPTION 'POOL_TERMS_FROZEN: entry close of pool % cannot move after close', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status = 'open') OR
       (OLD.status = 'open' AND NEW.status IN ('closed', 'cancelled')) OR
       (OLD.status = 'closed' AND NEW.status = 'settled')) THEN
    RAISE EXCEPTION 'POOL_STATUS: % → % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;

  -- Publishing requires a complete, consistent prize table.
  IF OLD.status = 'draft' AND NEW.status = 'open' THEN
    SELECT COALESCE(SUM(prize_cents * (to_place - from_place + 1)), 0), count(*),
           COALESCE(bool_and(from_place = 1 + COALESCE(prev_to, 0)), false) AND max(to_place) = NEW.paid_places
      INTO band_sum, band_count, contiguous
      FROM (SELECT from_place, to_place, prize_cents, lag(to_place) OVER (ORDER BY from_place) AS prev_to
              FROM prize_table_bands WHERE pool_id = NEW.id) b;
    IF band_count = 0 OR NOT contiguous OR band_sum <> NEW.prize_pool_cents THEN
      RAISE EXCEPTION 'PRIZE_TABLE_INVALID: pool % bands (sum %, contiguous %) do not match prize pool %',
        NEW.id, band_sum, contiguous, NEW.prize_pool_cents USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "contest_pools_update" BEFORE UPDATE ON "contest_pools"
  FOR EACH ROW EXECUTE FUNCTION burnout_pool_update();

CREATE OR REPLACE FUNCTION burnout_pool_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'POOL_TERMS_FROZEN: published pool % cannot be deleted', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "contest_pools_delete" BEFORE DELETE ON "contest_pools"
  FOR EACH ROW EXECUTE FUNCTION burnout_pool_delete();

-- Prize bands may only be written while the pool is a draft.
ALTER TABLE "prize_table_bands" ADD CONSTRAINT "prize_table_bands_range_check"
  CHECK ("from_place" >= 1 AND "to_place" >= "from_place" AND "prize_cents" > 0);
CREATE OR REPLACE FUNCTION burnout_prize_bands_draft_only() RETURNS trigger AS $$
DECLARE st TEXT;
BEGIN
  SELECT status INTO st FROM contest_pools WHERE id = COALESCE(NEW.pool_id, OLD.pool_id);
  IF st IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'PRIZE_TABLE_PUBLISHED: prize table of pool % is published and immutable', COALESCE(NEW.pool_id, OLD.pool_id)
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "prize_table_bands_draft_only" BEFORE INSERT OR UPDATE OR DELETE ON "prize_table_bands"
  FOR EACH ROW EXECUTE FUNCTION burnout_prize_bands_draft_only();
CREATE TRIGGER "prize_table_bands_no_truncate" BEFORE TRUNCATE ON "prize_table_bands"
  FOR EACH STATEMENT EXECUTE FUNCTION burnout_append_only();

-- Entries can't be created in a pool that has closed, been cancelled or settled,
-- whatever entered_at claims (complements PRD-003's ENTRY_CLOSED).
CREATE OR REPLACE FUNCTION burnout_entry_pool_open() RETURNS trigger AS $$
DECLARE st TEXT;
BEGIN
  SELECT status INTO st FROM contest_pools WHERE id = NEW.pool_id;
  IF st NOT IN ('draft', 'open') THEN
    RAISE EXCEPTION 'ENTRY_CLOSED: pool % is %', NEW.pool_id, st USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "contest_entries_pool_open" BEFORE INSERT ON "contest_entries"
  FOR EACH ROW EXECUTE FUNCTION burnout_entry_pool_open();

-- ── §10.3 Voids ──────────────────────────────────────────────────────────────
ALTER TABLE "contest_entry_voids" ADD CONSTRAINT "contest_entry_voids_reason_check"
  CHECK ("reason" IN ('CAPTURE_AFTER_CLOSE', 'POOL_CANCELLED', 'DUPLICATE_CHARGE', 'PLATFORM_ERROR'));
CREATE OR REPLACE FUNCTION burnout_entry_void_window() RETURNS trigger AS $$
DECLARE st TEXT; closes TIMESTAMPTZ;
BEGIN
  SELECT p.status, p.entry_closes_at INTO st, closes
    FROM contest_entries e JOIN contest_pools p ON p.id = e.pool_id WHERE e.id = NEW.entry_id;
  IF NOT (st = 'cancelled' OR (st IN ('draft', 'open') AND NEW.voided_at < closes)) THEN
    RAISE EXCEPTION 'ENTRY_VOID_AFTER_CLOSE: entry % is in a % pool; the field is permanent after close', NEW.entry_id, st
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "contest_entry_voids_window" BEFORE INSERT ON "contest_entry_voids"
  FOR EACH ROW EXECUTE FUNCTION burnout_entry_void_window();
CREATE TRIGGER "contest_entry_voids_append_only" BEFORE UPDATE OR DELETE ON "contest_entry_voids"
  FOR EACH ROW EXECUTE FUNCTION burnout_append_only();
CREATE TRIGGER "contest_entry_voids_no_truncate" BEFORE TRUNCATE ON "contest_entry_voids"
  FOR EACH STATEMENT EXECUTE FUNCTION burnout_append_only();

-- ── §8 Entry intents and refunds ─────────────────────────────────────────────
ALTER TABLE "entry_intents" ADD CONSTRAINT "entry_intents_status_check"
  CHECK ("status" IN ('pending', 'expired', 'failed', 'captured', 'refunded'));
ALTER TABLE "entry_intents" ADD CONSTRAINT "entry_intents_amount_check"
  CHECK ("amount_cents" > 0 AND "rake_cents" >= 0 AND "rake_cents" < "amount_cents");
-- At most one live checkout per user per pool.
CREATE UNIQUE INDEX "entry_intents_one_pending" ON "entry_intents" ("user_id", "pool_id") WHERE "status" = 'pending';

CREATE OR REPLACE FUNCTION burnout_entry_intent_update() RETURNS trigger AS $$
BEGIN
  IF (NEW.id, NEW.user_id, NEW.pool_id, NEW.amount_cents, NEW.rake_cents, NEW.processor, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.user_id, OLD.pool_id, OLD.amount_cents, OLD.rake_cents, OLD.processor, OLD.created_at) THEN
    RAISE EXCEPTION 'INTENT_IMMUTABLE: entry intent % terms cannot change', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.payment_ref IS NOT NULL AND NEW.payment_ref IS DISTINCT FROM OLD.payment_ref THEN
    RAISE EXCEPTION 'INTENT_IMMUTABLE: payment_ref of intent % is set', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'pending' AND NEW.status IN ('expired', 'failed', 'captured', 'refunded')) OR
       (OLD.status IN ('expired', 'failed') AND NEW.status IN ('captured', 'refunded')) OR
       (OLD.status = 'captured' AND NEW.status = 'refunded')) THEN
    RAISE EXCEPTION 'INTENT_STATUS: % → % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "entry_intents_update" BEFORE UPDATE ON "entry_intents"
  FOR EACH ROW EXECUTE FUNCTION burnout_entry_intent_update();
CREATE TRIGGER "entry_intents_no_delete" BEFORE DELETE ON "entry_intents"
  FOR EACH ROW EXECUTE FUNCTION burnout_append_only();

ALTER TABLE "refunds" ADD CONSTRAINT "refunds_status_check" CHECK ("status" IN ('pending', 'succeeded'));
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_check" CHECK ("amount_cents" > 0);
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_reason_check"
  CHECK ("reason" IN ('CAPTURE_AFTER_CLOSE', 'POOL_CANCELLED', 'DUPLICATE_CHARGE', 'PLATFORM_ERROR'));
CREATE OR REPLACE FUNCTION burnout_refund_update() RETURNS trigger AS $$
BEGIN
  IF (NEW.id, NEW.user_id, NEW.intent_id, NEW.payment_ref, NEW.amount_cents, NEW.reason, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.user_id, OLD.intent_id, OLD.payment_ref, OLD.amount_cents, OLD.reason, OLD.created_at)
     OR (OLD.refund_ref IS NOT NULL AND NEW.refund_ref IS DISTINCT FROM OLD.refund_ref)
     OR (OLD.status = 'succeeded' AND NEW.status <> 'succeeded') THEN
    RAISE EXCEPTION 'REFUND_IMMUTABLE: refund % cannot change that way', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "refunds_update" BEFORE UPDATE ON "refunds"
  FOR EACH ROW EXECUTE FUNCTION burnout_refund_update();
CREATE TRIGGER "refunds_no_delete" BEFORE DELETE ON "refunds"
  FOR EACH ROW EXECUTE FUNCTION burnout_append_only();

-- ── §7.2 Processor events; §7.3 approvals ────────────────────────────────────
CREATE OR REPLACE FUNCTION burnout_processor_event_update() RETURNS trigger AS $$
BEGIN
  IF OLD.processed_at IS NULL AND NEW.processed_at IS NOT NULL
     AND (NEW.processor, NEW.event_id, NEW.type, NEW.payload, NEW.received_at)
         IS NOT DISTINCT FROM (OLD.processor, OLD.event_id, OLD.type, OLD.payload, OLD.received_at) THEN
    RETURN NEW;   -- marking processed is the only permitted update
  END IF;
  RAISE EXCEPTION 'APPEND_ONLY: processor_events rows can only be marked processed' USING ERRCODE = 'insufficient_privilege';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "processor_events_update" BEFORE UPDATE ON "processor_events"
  FOR EACH ROW EXECUTE FUNCTION burnout_processor_event_update();
CREATE TRIGGER "processor_events_no_delete" BEFORE DELETE ON "processor_events"
  FOR EACH ROW EXECUTE FUNCTION burnout_append_only();
CREATE TRIGGER "processor_approvals_append_only" BEFORE UPDATE OR DELETE ON "processor_approvals"
  FOR EACH ROW EXECUTE FUNCTION burnout_append_only();

-- ── §6 Ledger ────────────────────────────────────────────────────────────────
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_kind_check"
  CHECK ("kind" IN ('asset', 'liability', 'revenue', 'expense'));
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_nonzero_check" CHECK ("amount_cents" <> 0);
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_kind_check" CHECK ("kind" IN (
  'capture', 'capture_rejected', 'fee', 'funds_settled', 'overlay', 'transfer', 'refund_entry', 'refund_confirmed',
  'settlement_approve', 'payout_paid', 'payout_returned', 'chargeback_lost'));

-- Every transaction balances at commit: entries sum to zero, at least two of them.
CREATE OR REPLACE FUNCTION burnout_ledger_check_txn(txn UUID) RETURNS void AS $$
DECLARE total BIGINT; n INT;
BEGIN
  SELECT COALESCE(SUM(amount_cents), 0), count(*) INTO total, n FROM ledger_entries WHERE txn_id = txn;
  IF total <> 0 OR n < 2 THEN
    RAISE EXCEPTION 'LEDGER_UNBALANCED: transaction % has % entries summing to %', txn, n, total
      USING ERRCODE = 'check_violation';
  END IF;
END $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION burnout_ledger_entry_balanced() RETURNS trigger AS $$
BEGIN PERFORM burnout_ledger_check_txn(NEW.txn_id); RETURN NULL; END $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION burnout_ledger_txn_balanced() RETURNS trigger AS $$
BEGIN PERFORM burnout_ledger_check_txn(NEW.id); RETURN NULL; END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "ledger_entries_balanced" AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION burnout_ledger_entry_balanced();
CREATE CONSTRAINT TRIGGER "ledger_transactions_have_entries" AFTER INSERT ON "ledger_transactions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION burnout_ledger_txn_balanced();

-- D5 / AC8: a prize liability is debited only by an entry refund or a settlement.
-- Fees, chargebacks and overlay can never reduce what winners are owed.
CREATE OR REPLACE FUNCTION burnout_prize_liability_debits() RETURNS trigger AS $$
DECLARE k TEXT;
BEGIN
  IF NEW.account LIKE 'prize_liability:%' AND NEW.amount_cents > 0 THEN
    SELECT kind INTO k FROM ledger_transactions WHERE id = NEW.txn_id;
    IF k NOT IN ('refund_entry', 'settlement_approve') THEN
      RAISE EXCEPTION 'PRIZE_POOL_PROTECTED: a % transaction cannot debit %', k, NEW.account
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "ledger_entries_prize_protected" BEFORE INSERT ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION burnout_prize_liability_debits();

CREATE TRIGGER "ledger_accounts_append_only" BEFORE UPDATE OR DELETE ON "ledger_accounts"
  FOR EACH ROW EXECUTE FUNCTION burnout_append_only();
CREATE TRIGGER "ledger_transactions_append_only" BEFORE UPDATE OR DELETE ON "ledger_transactions"
  FOR EACH ROW EXECUTE FUNCTION burnout_append_only();
CREATE TRIGGER "ledger_entries_append_only" BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION burnout_append_only();
CREATE TRIGGER "ledger_transactions_no_truncate" BEFORE TRUNCATE ON "ledger_transactions"
  FOR EACH STATEMENT EXECUTE FUNCTION burnout_append_only();
CREATE TRIGGER "ledger_entries_no_truncate" BEFORE TRUNCATE ON "ledger_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION burnout_append_only();

-- ── §9 Settlement ────────────────────────────────────────────────────────────
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_status_check" CHECK ("status" IN ('computed', 'approved'));
ALTER TABLE "settlement_awards" ADD CONSTRAINT "settlement_awards_amount_check"
  CHECK ("amount_cents" >= 0 AND "tie_size" >= 1 AND "rank" >= 1);

CREATE OR REPLACE FUNCTION burnout_settlement_update() RETURNS trigger AS $$
DECLARE awarded BIGINT; pool_cents BIGINT;
BEGIN
  IF NOT (OLD.status = 'computed' AND NEW.status = 'approved' AND NEW.approved_by IS NOT NULL AND NEW.approved_at IS NOT NULL
          AND (NEW.pool_id, NEW.snapshot_week, NEW.computed_at) IS NOT DISTINCT FROM (OLD.pool_id, OLD.snapshot_week, OLD.computed_at)) THEN
    RAISE EXCEPTION 'SETTLEMENT_IMMUTABLE: only computed → approved (with approver) is allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT COALESCE(SUM(amount_cents), 0) INTO awarded FROM settlement_awards WHERE pool_id = NEW.pool_id;
  SELECT prize_pool_cents INTO pool_cents FROM contest_pools WHERE id = NEW.pool_id;
  IF awarded <> pool_cents THEN
    RAISE EXCEPTION 'SETTLEMENT_SUM_MISMATCH: awards % ≠ prize pool % for pool %', awarded, pool_cents, NEW.pool_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "settlements_update" BEFORE UPDATE ON "settlements"
  FOR EACH ROW EXECUTE FUNCTION burnout_settlement_update();
CREATE TRIGGER "settlements_no_delete" BEFORE DELETE ON "settlements"
  FOR EACH ROW EXECUTE FUNCTION burnout_append_only();

CREATE OR REPLACE FUNCTION burnout_award_insert() RETURNS trigger AS $$
BEGIN
  IF (SELECT status FROM settlements WHERE pool_id = NEW.pool_id) IS DISTINCT FROM 'computed' THEN
    RAISE EXCEPTION 'SETTLEMENT_IMMUTABLE: awards for pool % can only be written while computed', NEW.pool_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "settlement_awards_insert" BEFORE INSERT ON "settlement_awards"
  FOR EACH ROW EXECUTE FUNCTION burnout_award_insert();
CREATE TRIGGER "settlement_awards_append_only" BEFORE UPDATE OR DELETE ON "settlement_awards"
  FOR EACH ROW EXECUTE FUNCTION burnout_append_only();
CREATE TRIGGER "settlement_awards_no_truncate" BEFORE TRUNCATE ON "settlement_awards"
  FOR EACH STATEMENT EXECUTE FUNCTION burnout_append_only();

-- ── §10 Payouts and holds ────────────────────────────────────────────────────
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_status_check" CHECK ("status" IN ('pending', 'sent', 'paid', 'failed'));
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_speed_check" CHECK ("speed" IN ('standard', 'instant'));
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_amount_check"
  CHECK ("amount_cents" > 0 AND "fee_cents" >= 0 AND "fee_cents" < "amount_cents" AND "attempt" >= 1);
CREATE OR REPLACE FUNCTION burnout_payout_update() RETURNS trigger AS $$
BEGIN
  IF (NEW.id, NEW.user_id, NEW.pool_id, NEW.attempt, NEW.amount_cents, NEW.idempotency_key, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.user_id, OLD.pool_id, OLD.attempt, OLD.amount_cents, OLD.idempotency_key, OLD.created_at)
     OR (OLD.status <> 'pending' AND NEW.speed IS DISTINCT FROM OLD.speed)
     OR (OLD.payout_ref IS NOT NULL AND NEW.payout_ref IS DISTINCT FROM OLD.payout_ref) THEN
    RAISE EXCEPTION 'PAYOUT_IMMUTABLE: payout % cannot change that way', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'pending' AND NEW.status IN ('sent', 'failed')) OR
       (OLD.status = 'sent' AND NEW.status IN ('paid', 'failed')) OR
       (OLD.status = 'paid' AND NEW.status = 'failed')) THEN
    RAISE EXCEPTION 'PAYOUT_STATUS: % → % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "payouts_update" BEFORE UPDATE ON "payouts"
  FOR EACH ROW EXECUTE FUNCTION burnout_payout_update();
CREATE TRIGGER "payouts_no_delete" BEFORE DELETE ON "payouts"
  FOR EACH ROW EXECUTE FUNCTION burnout_append_only();
-- At most one live payout (pending / sent / paid) per award.
CREATE UNIQUE INDEX "payouts_one_live" ON "payouts" ("pool_id", "user_id") WHERE "status" IN ('pending', 'sent', 'paid');

ALTER TABLE "account_holds" ADD CONSTRAINT "account_holds_reason_check" CHECK ("reason" IN ('DISPUTE', 'ADMIN'));
CREATE OR REPLACE FUNCTION burnout_hold_update() RETURNS trigger AS $$
BEGIN
  IF OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL
     AND (NEW.id, NEW.user_id, NEW.reason, NEW.ref_id, NEW.opened_at)
         IS NOT DISTINCT FROM (OLD.id, OLD.user_id, OLD.reason, OLD.ref_id, OLD.opened_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'APPEND_ONLY: account holds can only be closed' USING ERRCODE = 'insufficient_privilege';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "account_holds_update" BEFORE UPDATE ON "account_holds"
  FOR EACH ROW EXECUTE FUNCTION burnout_hold_update();
CREATE TRIGGER "account_holds_no_delete" BEFORE DELETE ON "account_holds"
  FOR EACH ROW EXECUTE FUNCTION burnout_append_only();

-- ── §11 Identity, jurisdictions, tax ─────────────────────────────────────────
ALTER TABLE "identity_verifications" ADD CONSTRAINT "identity_verifications_status_check"
  CHECK ("status" IN ('verified', 'rejected', 'revoked'));
-- One verified account per person, and one verified identity per account.
CREATE UNIQUE INDEX "identity_verifications_person_once" ON "identity_verifications" ("person_hash") WHERE "status" = 'verified';
CREATE UNIQUE INDEX "identity_verifications_user_once" ON "identity_verifications" ("user_id") WHERE "status" = 'verified';

ALTER TABLE "jurisdictions" ADD CONSTRAINT "jurisdictions_status_check" CHECK ("status" IN ('allowed', 'blocked'));
ALTER TABLE "jurisdictions" ADD CONSTRAINT "jurisdictions_age_check" CHECK ("min_age" >= 18);

-- Seed: exec summary §5.3 list, pending counsel's final list (PRD-004 §11.2).
-- Louisiana is blocked as a whole until counsel supplies the parish list.
-- Minimum ages: 18 by default; 19 where that is the age of majority (AL, NE);
-- 21 for MA, AZ, IA as a conservative placeholder pending counsel.
INSERT INTO "jurisdictions" ("country", "region", "sub_region", "status", "min_age", "effective_from", "source_note")
SELECT 'US', r, '',
       CASE WHEN r IN ('HI', 'ID', 'MT', 'WA', 'NV', 'LA') THEN 'blocked' ELSE 'allowed' END,
       CASE WHEN r IN ('AL', 'NE') THEN 19 WHEN r IN ('MA', 'AZ', 'IA') THEN 21 ELSE 18 END,
       '2026-01-01T00:00:00Z',
       'seed: exec summary §5.3; pending counsel final list'
  FROM unnest(ARRAY['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME',
                    'MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI',
                    'SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY']) AS r;

-- Prize winnings: Form 1099-MISC, $2,000 for payments made in 2026, indexed after (§11.3).
INSERT INTO "tax_thresholds" ("tax_year", "form", "threshold_cents") VALUES (2026, '1099-MISC', 200000);

CREATE TRIGGER "bank_reconciliations_append_only" BEFORE UPDATE OR DELETE ON "bank_reconciliations"
  FOR EACH ROW EXECUTE FUNCTION burnout_append_only();

-- Tax year = calendar year of payment, Eastern Time. Gross and net are both
-- exposed until the CPA decides which one the threshold applies to (§16 Q5).
CREATE VIEW "user_tax_year_totals" AS
WITH prizes AS (
  SELECT user_id, extract(year FROM paid_at AT TIME ZONE 'America/New_York')::int AS tax_year,
         SUM(amount_cents)::bigint AS prizes_paid_cents
    FROM payouts WHERE status = 'paid' GROUP BY 1, 2
), fees AS (
  SELECT user_id, extract(year FROM captured_at AT TIME ZONE 'America/New_York')::int AS tax_year,
         SUM(amount_cents)::bigint AS entry_fees_cents
    FROM entry_intents WHERE status = 'captured' GROUP BY 1, 2
), totals AS (
  SELECT COALESCE(p.user_id, f.user_id) AS user_id, COALESCE(p.tax_year, f.tax_year) AS tax_year,
         COALESCE(p.prizes_paid_cents, 0) AS prizes_paid_cents, COALESCE(f.entry_fees_cents, 0) AS entry_fees_cents
    FROM prizes p FULL JOIN fees f ON f.user_id = p.user_id AND f.tax_year = p.tax_year
)
SELECT t.user_id, t.tax_year, t.prizes_paid_cents, t.entry_fees_cents,
       (t.prizes_paid_cents - t.entry_fees_cents) AS net_winnings_cents,
       th.threshold_cents,
       (th.threshold_cents IS NOT NULL AND t.prizes_paid_cents >= th.threshold_cents) AS meets_gross_threshold,
       (th.threshold_cents IS NOT NULL AND t.prizes_paid_cents - t.entry_fees_cents >= th.threshold_cents) AS meets_net_threshold
  FROM totals t LEFT JOIN tax_thresholds th ON th.tax_year = t.tax_year AND th.form = '1099-MISC';

-- ── Notifications ────────────────────────────────────────────────────────────
ALTER TABLE "notification_queue" DROP CONSTRAINT "notification_queue_kind_check";
ALTER TABLE "notification_queue" ADD CONSTRAINT "notification_queue_kind_check" CHECK ("kind" IN (
  'LOCK', 'BURN', 'SLOT_REOPENED', 'SCORE_CORRECTION',
  'ENTRY_RECEIPT', 'REFUND', 'POOL_CANCELLED', 'PAYOUT_BLOCKED', 'PAYOUT_SENT', 'PAYOUT_FAILED'));
