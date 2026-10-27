-- AlterTable
ALTER TABLE "users" ADD COLUMN     "handle" VARCHAR(20);

-- CreateTable
CREATE TABLE "contest_pools" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "season" VARCHAR(20) NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "buy_in_cents" INTEGER NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "entry_closes_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contest_pools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contest_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pool_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "entered_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "contest_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leaderboard_snapshots" (
    "pool_id" UUID NOT NULL,
    "week" SMALLINT NOT NULL,
    "kind" VARCHAR(12) NOT NULL,
    "user_id" UUID NOT NULL,
    "handle" VARCHAR(20) NOT NULL,
    "rank" INTEGER NOT NULL,
    "points_x100" BIGINT NOT NULL,
    "taken_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "leaderboard_snapshots_pkey" PRIMARY KEY ("pool_id","week","kind","user_id")
);

-- CreateTable
CREATE TABLE "user_handle_history" (
    "user_id" UUID NOT NULL,
    "handle" VARCHAR(20) NOT NULL,
    "season" VARCHAR(20) NOT NULL,
    "is_change" BOOLEAN NOT NULL,
    "valid_from" TIMESTAMPTZ NOT NULL,
    "valid_to" TIMESTAMPTZ,

    CONSTRAINT "user_handle_history_pkey" PRIMARY KEY ("user_id","valid_from")
);

-- CreateIndex
CREATE UNIQUE INDEX "contest_pools_season_kind_buy_in_cents_key" ON "contest_pools"("season", "kind", "buy_in_cents");

-- CreateIndex
CREATE INDEX "idx_contest_entries_user" ON "contest_entries"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "contest_entries_pool_id_user_id_key" ON "contest_entries"("pool_id", "user_id");

-- CreateIndex
CREATE INDEX "idx_handle_history_season_user" ON "user_handle_history"("season", "user_id");

-- AddForeignKey
ALTER TABLE "contest_entries" ADD CONSTRAINT "contest_entries_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "contest_pools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contest_entries" ADD CONSTRAINT "contest_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leaderboard_snapshots" ADD CONSTRAINT "leaderboard_snapshots_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "contest_pools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leaderboard_snapshots" ADD CONSTRAINT "leaderboard_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_handle_history" ADD CONSTRAINT "user_handle_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
