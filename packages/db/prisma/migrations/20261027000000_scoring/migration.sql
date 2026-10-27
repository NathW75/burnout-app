-- CreateTable
CREATE TABLE "nfl_games" (
    "msf_game_id" VARCHAR(50) NOT NULL,
    "season" VARCHAR(20) NOT NULL,
    "week" SMALLINT NOT NULL,
    "game_window_id" UUID,
    "scheduled_start" TIMESTAMPTZ NOT NULL,
    "played_status" VARCHAR(40) NOT NULL,
    "schedule_status" VARCHAR(40) NOT NULL,
    "is_final" BOOLEAN NOT NULL DEFAULT false,
    "final_observed_at" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "nfl_games_pkey" PRIMARY KEY ("msf_game_id")
);

-- CreateTable
CREATE TABLE "season_rules" (
    "season" VARCHAR(20) NOT NULL,
    "rules_version" VARCHAR(40) NOT NULL,
    "pinned_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "season_rules_pkey" PRIMARY KEY ("season")
);

-- CreateTable
CREATE TABLE "player_game_stats" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "season" VARCHAR(20) NOT NULL,
    "week" SMALLINT NOT NULL,
    "msf_game_id" VARCHAR(50) NOT NULL,
    "player_id" VARCHAR(50) NOT NULL,
    "game_window_id" UUID NOT NULL,
    "pass_yds" INTEGER NOT NULL DEFAULT 0,
    "pass_td" SMALLINT NOT NULL DEFAULT 0,
    "pass_int" SMALLINT NOT NULL DEFAULT 0,
    "rush_yds" INTEGER NOT NULL DEFAULT 0,
    "rush_td" SMALLINT NOT NULL DEFAULT 0,
    "receptions" SMALLINT NOT NULL DEFAULT 0,
    "rec_yds" INTEGER NOT NULL DEFAULT 0,
    "rec_td" SMALLINT NOT NULL DEFAULT 0,
    "return_td" SMALLINT NOT NULL DEFAULT 0,
    "fumble_rec_td" SMALLINT NOT NULL DEFAULT 0,
    "fumbles_lost" SMALLINT NOT NULL DEFAULT 0,
    "two_pt" SMALLINT NOT NULL DEFAULT 0,
    "fg_made_0_39" SMALLINT NOT NULL DEFAULT 0,
    "fg_made_40_49" SMALLINT NOT NULL DEFAULT 0,
    "fg_made_50_plus" SMALLINT NOT NULL DEFAULT 0,
    "fg_missed" SMALLINT NOT NULL DEFAULT 0,
    "xp_made" SMALLINT NOT NULL DEFAULT 0,
    "xp_missed" SMALLINT NOT NULL DEFAULT 0,
    "stat_hash" CHAR(64) NOT NULL,
    "source_updated_at" TIMESTAMPTZ NOT NULL,
    "ingested_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "player_game_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_game_scores" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "stats_id" UUID NOT NULL,
    "season" VARCHAR(20) NOT NULL,
    "week" SMALLINT NOT NULL,
    "msf_game_id" VARCHAR(50) NOT NULL,
    "player_id" VARCHAR(50) NOT NULL,
    "game_window_id" UUID NOT NULL,
    "points_x100" INTEGER NOT NULL,
    "status" VARCHAR(12) NOT NULL,
    "rules_version" VARCHAR(40) NOT NULL,
    "computed_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "player_game_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "score_corrections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "score_id" UUID NOT NULL,
    "detected_at" TIMESTAMPTZ NOT NULL,
    "points_before_x100" INTEGER NOT NULL,
    "points_after_x100" INTEGER NOT NULL,
    "stats_before" JSONB NOT NULL,
    "stats_after" JSONB NOT NULL,
    "applied" BOOLEAN NOT NULL,
    "reason" VARCHAR(30) NOT NULL,

    CONSTRAINT "score_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_week_scores" (
    "user_id" UUID NOT NULL,
    "season" VARCHAR(20) NOT NULL,
    "week" SMALLINT NOT NULL,
    "points_x100" INTEGER NOT NULL DEFAULT 0,
    "slots_scored" SMALLINT NOT NULL DEFAULT 0,
    "status" VARCHAR(12) NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "user_week_scores_pkey" PRIMARY KEY ("user_id","season","week")
);

-- CreateTable
CREATE TABLE "week_freezes" (
    "season" VARCHAR(20) NOT NULL,
    "week" SMALLINT NOT NULL,
    "last_final_at" TIMESTAMPTZ NOT NULL,
    "frozen_at" TIMESTAMPTZ NOT NULL,
    "scores_frozen" INTEGER NOT NULL,

    CONSTRAINT "week_freezes_pkey" PRIMARY KEY ("season","week")
);

-- CreateIndex
CREATE INDEX "idx_nfl_games_season_week" ON "nfl_games"("season", "week");

-- CreateIndex
CREATE UNIQUE INDEX "player_game_stats_season_msf_game_id_player_id_key" ON "player_game_stats"("season", "msf_game_id", "player_id");

-- CreateIndex
CREATE UNIQUE INDEX "player_game_scores_stats_id_key" ON "player_game_scores"("stats_id");

-- CreateIndex
CREATE INDEX "idx_pgs_player_week" ON "player_game_scores"("season", "week", "player_id");

-- CreateIndex
CREATE INDEX "idx_pgs_window_player" ON "player_game_scores"("game_window_id", "player_id");

-- CreateIndex
CREATE UNIQUE INDEX "player_game_scores_season_msf_game_id_player_id_key" ON "player_game_scores"("season", "msf_game_id", "player_id");

-- CreateIndex
CREATE INDEX "idx_score_corrections_score" ON "score_corrections"("score_id");

-- CreateIndex
CREATE INDEX "idx_user_week_scores_rank" ON "user_week_scores"("season", "week", "points_x100");

-- AddForeignKey
ALTER TABLE "nfl_games" ADD CONSTRAINT "nfl_games_game_window_id_fkey" FOREIGN KEY ("game_window_id") REFERENCES "game_windows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_game_stats" ADD CONSTRAINT "player_game_stats_game_window_id_fkey" FOREIGN KEY ("game_window_id") REFERENCES "game_windows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_game_scores" ADD CONSTRAINT "player_game_scores_stats_id_fkey" FOREIGN KEY ("stats_id") REFERENCES "player_game_stats"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_game_scores" ADD CONSTRAINT "player_game_scores_game_window_id_fkey" FOREIGN KEY ("game_window_id") REFERENCES "game_windows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "score_corrections" ADD CONSTRAINT "score_corrections_score_id_fkey" FOREIGN KEY ("score_id") REFERENCES "player_game_scores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_week_scores" ADD CONSTRAINT "user_week_scores_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
