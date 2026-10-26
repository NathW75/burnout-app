-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pool_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "player_id" VARCHAR(50) NOT NULL,
    "season" VARCHAR(20) NOT NULL,
    "burned" BOOLEAN NOT NULL DEFAULT false,
    "burned_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pool_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_windows" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "week" SMALLINT NOT NULL,
    "season" VARCHAR(20) NOT NULL,
    "label" VARCHAR(50) NOT NULL,
    "scheduled_et" TIMESTAMPTZ NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "msf_game_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "final_posted_at" TIMESTAMPTZ,

    CONSTRAINT "game_windows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "season_submissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "week" SMALLINT NOT NULL,
    "season" VARCHAR(20) NOT NULL,
    "slot_key" VARCHAR(10) NOT NULL,
    "player_id" VARCHAR(50) NOT NULL,
    "game_window_id" UUID NOT NULL,
    "submitted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMPTZ,
    "void_reason" VARCHAR(50),

    CONSTRAINT "season_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "burn_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "player_id" VARCHAR(50) NOT NULL,
    "season" VARCHAR(20) NOT NULL,
    "week" SMALLINT NOT NULL,
    "game_window_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "locked_at" TIMESTAMPTZ NOT NULL,
    "burned_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "burn_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lock_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "game_window_id" UUID NOT NULL,
    "fired_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submissions_locked" INTEGER NOT NULL,
    "notifications_queued" INTEGER NOT NULL,

    CONSTRAINT "lock_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_type" VARCHAR(50) NOT NULL,
    "game_id" UUID,
    "user_id" UUID,
    "slot_key" VARCHAR(10),
    "authorization_reference" VARCHAR(255),
    "performed_by" UUID NOT NULL,
    "performed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "security_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission_receipts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "week" SMALLINT NOT NULL,
    "season" VARCHAR(20) NOT NULL,
    "lineup_snapshot" JSONB NOT NULL,
    "gate1_at" TIMESTAMPTZ NOT NULL,
    "gate2_at" TIMESTAMPTZ NOT NULL,
    "gate3_at" TIMESTAMPTZ NOT NULL,
    "ip_address" VARCHAR(45) NOT NULL,
    "user_agent" TEXT NOT NULL,
    "submission_id" UUID NOT NULL,

    CONSTRAINT "submission_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weekly_submissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "contest_id" UUID NOT NULL,
    "week" SMALLINT NOT NULL,
    "season" VARCHAR(20) NOT NULL,
    "slot_key" VARCHAR(10) NOT NULL,
    "player_id" VARCHAR(50) NOT NULL,
    "game_window_id" UUID NOT NULL,
    "submitted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMPTZ,

    CONSTRAINT "weekly_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_queue" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "game_window_id" UUID,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatched_at" TIMESTAMPTZ,

    CONSTRAINT "notification_queue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "idx_pool_entries_user_season" ON "pool_entries"("user_id", "season", "burned");

-- CreateIndex
CREATE UNIQUE INDEX "pool_entries_user_id_player_id_season_key" ON "pool_entries"("user_id", "player_id", "season");

-- CreateIndex
CREATE INDEX "idx_game_windows_status" ON "game_windows"("status", "scheduled_et");

-- CreateIndex
CREATE INDEX "idx_season_submissions_window" ON "season_submissions"("game_window_id", "locked_at");

-- CreateIndex
CREATE UNIQUE INDEX "season_submissions_user_id_week_season_slot_key_key" ON "season_submissions"("user_id", "week", "season", "slot_key");

-- CreateIndex
CREATE UNIQUE INDEX "burn_records_user_id_player_id_season_key" ON "burn_records"("user_id", "player_id", "season");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_submissions_user_id_contest_id_slot_key_key" ON "weekly_submissions"("user_id", "contest_id", "slot_key");

-- CreateIndex
CREATE INDEX "idx_notification_queue_pending" ON "notification_queue"("dispatched_at", "created_at");

-- AddForeignKey
ALTER TABLE "pool_entries" ADD CONSTRAINT "pool_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "season_submissions" ADD CONSTRAINT "season_submissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "season_submissions" ADD CONSTRAINT "season_submissions_game_window_id_fkey" FOREIGN KEY ("game_window_id") REFERENCES "game_windows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "burn_records" ADD CONSTRAINT "burn_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "burn_records" ADD CONSTRAINT "burn_records_user_id_player_id_season_fkey" FOREIGN KEY ("user_id", "player_id", "season") REFERENCES "pool_entries"("user_id", "player_id", "season") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "burn_records" ADD CONSTRAINT "burn_records_game_window_id_fkey" FOREIGN KEY ("game_window_id") REFERENCES "game_windows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "burn_records" ADD CONSTRAINT "burn_records_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "season_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lock_events" ADD CONSTRAINT "lock_events_game_window_id_fkey" FOREIGN KEY ("game_window_id") REFERENCES "game_windows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_receipts" ADD CONSTRAINT "submission_receipts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_submissions" ADD CONSTRAINT "weekly_submissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_submissions" ADD CONSTRAINT "weekly_submissions_game_window_id_fkey" FOREIGN KEY ("game_window_id") REFERENCES "game_windows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
