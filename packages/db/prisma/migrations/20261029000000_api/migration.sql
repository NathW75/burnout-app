-- AlterTable
ALTER TABLE "users" ADD COLUMN     "email_verified_at" TIMESTAMPTZ,
ADD COLUMN     "last_login_at" TIMESTAMPTZ,
ADD COLUMN     "password_changed_at" TIMESTAMPTZ,
ADD COLUMN     "role" VARCHAR(12) NOT NULL DEFAULT 'user',
ADD COLUMN     "status" VARCHAR(12) NOT NULL DEFAULT 'active';

-- AlterTable
ALTER TABLE "season_submissions" ADD COLUMN     "receipt_id" UUID;

-- AlterTable
ALTER TABLE "submission_receipts" ADD COLUMN     "lineup_sha256" CHAR(64);

-- AlterTable
ALTER TABLE "nfl_games" ADD COLUMN     "away_team" VARCHAR(5),
ADD COLUMN     "home_team" VARCHAR(5);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "client" VARCHAR(10) NOT NULL,
    "ip_address" VARCHAR(45),
    "user_agent" TEXT,
    "mfa_pending" BOOLEAN NOT NULL DEFAULT false,
    "mfa_attempts" INTEGER NOT NULL DEFAULT 0,
    "step_up_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL,
    "last_seen_at" TIMESTAMPTZ NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_factors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "secret_ciphertext" TEXT NOT NULL,
    "last_used_step" BIGINT,
    "created_at" TIMESTAMPTZ NOT NULL,
    "confirmed_at" TIMESTAMPTZ,
    "disabled_at" TIMESTAMPTZ,

    CONSTRAINT "auth_factors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "code_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL,
    "used_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,

    CONSTRAINT "backup_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "purpose" VARCHAR(20) NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "used_at" TIMESTAMPTZ,

    CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nfl_players" (
    "msf_player_id" VARCHAR(50) NOT NULL,
    "first_name" VARCHAR(60) NOT NULL,
    "last_name" VARCHAR(60) NOT NULL,
    "position" VARCHAR(5) NOT NULL,
    "team" VARCHAR(5),
    "roster_status" VARCHAR(40),
    "injury_status" VARCHAR(15) NOT NULL DEFAULT 'Active',
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "nfl_players_pkey" PRIMARY KEY ("msf_player_id")
);

-- CreateTable
CREATE TABLE "lineup_confirmations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "season" VARCHAR(20) NOT NULL,
    "week" SMALLINT NOT NULL,
    "slots" JSONB NOT NULL,
    "status" VARCHAR(12) NOT NULL,
    "gate1_at" TIMESTAMPTZ NOT NULL,
    "gate2_at" TIMESTAMPTZ,
    "gate3_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "ip_address" VARCHAR(45) NOT NULL,
    "user_agent" TEXT NOT NULL,

    CONSTRAINT "lineup_confirmations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "idx_sessions_user_live" ON "sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "idx_auth_factors_user" ON "auth_factors"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "backup_codes_code_hash_key" ON "backup_codes"("code_hash");

-- CreateIndex
CREATE INDEX "idx_backup_codes_user" ON "backup_codes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_tokens_token_hash_key" ON "auth_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "idx_auth_tokens_user" ON "auth_tokens"("user_id", "purpose");

-- CreateIndex
CREATE INDEX "idx_nfl_players_position" ON "nfl_players"("position");

-- CreateIndex
CREATE INDEX "idx_nfl_players_team" ON "nfl_players"("team");

-- CreateIndex
CREATE INDEX "idx_lineup_confirmations_user_week" ON "lineup_confirmations"("user_id", "season", "week");

-- CreateIndex
CREATE INDEX "idx_submission_receipts_user_week" ON "submission_receipts"("user_id", "season", "week");

-- CreateIndex
CREATE INDEX "idx_nfl_games_home" ON "nfl_games"("season", "week", "home_team");

-- CreateIndex
CREATE INDEX "idx_nfl_games_away" ON "nfl_games"("season", "week", "away_team");

-- AddForeignKey
ALTER TABLE "season_submissions" ADD CONSTRAINT "season_submissions_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "submission_receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_factors" ADD CONSTRAINT "auth_factors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_codes" ADD CONSTRAINT "backup_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lineup_confirmations" ADD CONSTRAINT "lineup_confirmations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
