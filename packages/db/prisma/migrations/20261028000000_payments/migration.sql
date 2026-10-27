-- AlterTable
ALTER TABLE "contest_pools" ADD COLUMN     "capacity" INTEGER,
ADD COLUMN     "min_cash_cents" BIGINT,
ADD COLUMN     "min_entries" INTEGER,
ADD COLUMN     "paid_places" INTEGER,
ADD COLUMN     "prize_algorithm" VARCHAR(40),
ADD COLUMN     "prize_pool_cents" BIGINT,
ADD COLUMN     "published_at" TIMESTAMPTZ,
ADD COLUMN     "rake_bps" INTEGER,
ADD COLUMN     "status" VARCHAR(12) NOT NULL DEFAULT 'draft';

-- CreateTable
CREATE TABLE "prize_table_bands" (
    "pool_id" UUID NOT NULL,
    "from_place" INTEGER NOT NULL,
    "to_place" INTEGER NOT NULL,
    "prize_cents" BIGINT NOT NULL,

    CONSTRAINT "prize_table_bands_pkey" PRIMARY KEY ("pool_id","from_place")
);

-- CreateTable
CREATE TABLE "entry_intents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "pool_id" UUID NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "rake_cents" INTEGER NOT NULL,
    "status" VARCHAR(12) NOT NULL,
    "hold_expires_at" TIMESTAMPTZ NOT NULL,
    "processor" VARCHAR(20) NOT NULL,
    "checkout_ref" VARCHAR(255),
    "payment_ref" VARCHAR(255),
    "ip_region" VARCHAR(10) NOT NULL,
    "billing_region" VARCHAR(10) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL,
    "captured_at" TIMESTAMPTZ,

    CONSTRAINT "entry_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contest_entry_voids" (
    "entry_id" UUID NOT NULL,
    "reason" VARCHAR(30) NOT NULL,
    "voided_at" TIMESTAMPTZ NOT NULL,
    "voided_by" UUID,

    CONSTRAINT "contest_entry_voids_pkey" PRIMARY KEY ("entry_id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "intent_id" UUID,
    "payment_ref" VARCHAR(255) NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "prize_share_cents" INTEGER NOT NULL DEFAULT 0,
    "reason" VARCHAR(30) NOT NULL,
    "status" VARCHAR(12) NOT NULL,
    "refund_ref" VARCHAR(255),
    "created_at" TIMESTAMPTZ NOT NULL,
    "succeeded_at" TIMESTAMPTZ,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processor_events" (
    "processor" VARCHAR(20) NOT NULL,
    "event_id" VARCHAR(255) NOT NULL,
    "type" VARCHAR(30) NOT NULL,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL,
    "processed_at" TIMESTAMPTZ,

    CONSTRAINT "processor_events_pkey" PRIMARY KEY ("processor","event_id")
);

-- CreateTable
CREATE TABLE "processor_approvals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "processor" VARCHAR(20) NOT NULL,
    "approved_at" TIMESTAMPTZ NOT NULL,
    "document_ref" VARCHAR(255) NOT NULL,
    "recorded_by" UUID NOT NULL,

    CONSTRAINT "processor_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "code" VARCHAR(80) NOT NULL,
    "kind" VARCHAR(12) NOT NULL,
    "pool_id" UUID,
    "user_id" UUID,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "ledger_transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" VARCHAR(30) NOT NULL,
    "ref_type" VARCHAR(30) NOT NULL,
    "ref_id" VARCHAR(255) NOT NULL,
    "idempotency_key" VARCHAR(255) NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL,
    "posted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" BIGSERIAL NOT NULL,
    "txn_id" UUID NOT NULL,
    "account" VARCHAR(80) NOT NULL,
    "amount_cents" BIGINT NOT NULL,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlements" (
    "pool_id" UUID NOT NULL,
    "snapshot_week" SMALLINT NOT NULL,
    "status" VARCHAR(12) NOT NULL,
    "computed_at" TIMESTAMPTZ NOT NULL,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ,

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("pool_id")
);

-- CreateTable
CREATE TABLE "settlement_awards" (
    "pool_id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "rank" INTEGER NOT NULL,
    "tie_size" INTEGER NOT NULL,
    "amount_cents" BIGINT NOT NULL,

    CONSTRAINT "settlement_awards_pkey" PRIMARY KEY ("pool_id","entry_id")
);

-- CreateTable
CREATE TABLE "payout_accounts" (
    "user_id" UUID NOT NULL,
    "processor" VARCHAR(20) NOT NULL,
    "account_ref" VARCHAR(255) NOT NULL,
    "payouts_enabled" BOOLEAN NOT NULL,
    "tin_verified" BOOLEAN NOT NULL,
    "instant_eligible" BOOLEAN NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "payout_accounts_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "payouts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "pool_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "fee_cents" BIGINT NOT NULL DEFAULT 0,
    "speed" VARCHAR(10) NOT NULL,
    "status" VARCHAR(10) NOT NULL,
    "payout_ref" VARCHAR(255),
    "idempotency_key" VARCHAR(255) NOT NULL,
    "failure_reason" VARCHAR(255),
    "created_at" TIMESTAMPTZ NOT NULL,
    "sent_at" TIMESTAMPTZ,
    "paid_at" TIMESTAMPTZ,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_holds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "reason" VARCHAR(30) NOT NULL,
    "ref_id" VARCHAR(255),
    "opened_at" TIMESTAMPTZ NOT NULL,
    "closed_at" TIMESTAMPTZ,

    CONSTRAINT "account_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_verifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "provider" VARCHAR(30) NOT NULL,
    "provider_ref" VARCHAR(255) NOT NULL,
    "person_hash" CHAR(64) NOT NULL,
    "status" VARCHAR(12) NOT NULL,
    "verified_region" VARCHAR(10) NOT NULL,
    "birth_date" DATE NOT NULL,
    "verified_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "identity_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jurisdictions" (
    "country" VARCHAR(2) NOT NULL,
    "region" VARCHAR(10) NOT NULL,
    "sub_region" VARCHAR(60) NOT NULL DEFAULT '',
    "status" VARCHAR(10) NOT NULL,
    "min_age" SMALLINT NOT NULL,
    "effective_from" TIMESTAMPTZ NOT NULL,
    "effective_to" TIMESTAMPTZ,
    "source_note" TEXT NOT NULL,

    CONSTRAINT "jurisdictions_pkey" PRIMARY KEY ("country","region","sub_region","effective_from")
);

-- CreateTable
CREATE TABLE "tax_thresholds" (
    "tax_year" SMALLINT NOT NULL,
    "form" VARCHAR(20) NOT NULL,
    "threshold_cents" BIGINT NOT NULL,

    CONSTRAINT "tax_thresholds_pkey" PRIMARY KEY ("tax_year","form")
);

-- CreateTable
CREATE TABLE "bank_reconciliations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account" VARCHAR(80) NOT NULL,
    "statement_date" DATE NOT NULL,
    "balance_cents" BIGINT NOT NULL,
    "entered_by" UUID NOT NULL,
    "entered_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "bank_reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "entry_intents_payment_ref_key" ON "entry_intents"("payment_ref");

-- CreateIndex
CREATE INDEX "idx_entry_intents_pool_status" ON "entry_intents"("pool_id", "status");

-- CreateIndex
CREATE INDEX "idx_entry_intents_user" ON "entry_intents"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_payment_ref_key" ON "refunds"("payment_ref");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_refund_ref_key" ON "refunds"("refund_ref");

-- CreateIndex
CREATE INDEX "idx_processor_events_pending" ON "processor_events"("processed_at", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_transactions_idempotency_key_key" ON "ledger_transactions"("idempotency_key");

-- CreateIndex
CREATE INDEX "idx_ledger_txn_ref" ON "ledger_transactions"("ref_type", "ref_id");

-- CreateIndex
CREATE INDEX "idx_ledger_entries_account" ON "ledger_entries"("account");

-- CreateIndex
CREATE INDEX "idx_ledger_entries_txn" ON "ledger_entries"("txn_id");

-- CreateIndex
CREATE INDEX "idx_settlement_awards_user" ON "settlement_awards"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "payouts_payout_ref_key" ON "payouts"("payout_ref");

-- CreateIndex
CREATE UNIQUE INDEX "payouts_idempotency_key_key" ON "payouts"("idempotency_key");

-- CreateIndex
CREATE INDEX "idx_payouts_status" ON "payouts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "payouts_pool_id_user_id_attempt_key" ON "payouts"("pool_id", "user_id", "attempt");

-- CreateIndex
CREATE INDEX "idx_account_holds_user_open" ON "account_holds"("user_id", "closed_at");

-- CreateIndex
CREATE INDEX "idx_identity_verifications_user" ON "identity_verifications"("user_id");

-- AddForeignKey
ALTER TABLE "prize_table_bands" ADD CONSTRAINT "prize_table_bands_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "contest_pools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_intents" ADD CONSTRAINT "entry_intents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_intents" ADD CONSTRAINT "entry_intents_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "contest_pools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contest_entry_voids" ADD CONSTRAINT "contest_entry_voids_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "contest_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_txn_id_fkey" FOREIGN KEY ("txn_id") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_fkey" FOREIGN KEY ("account") REFERENCES "ledger_accounts"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "contest_pools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_awards" ADD CONSTRAINT "settlement_awards_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "settlements"("pool_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_accounts" ADD CONSTRAINT "payout_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_holds" ADD CONSTRAINT "account_holds_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity_verifications" ADD CONSTRAINT "identity_verifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
