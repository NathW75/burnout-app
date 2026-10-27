-- PRD-002 scoring guarantees that Prisma's schema language cannot express.

-- ── Domains ──────────────────────────────────────────────────────────────────
ALTER TABLE "player_game_scores" ADD CONSTRAINT "player_game_scores_status_check"
  CHECK ("status" IN ('provisional', 'final', 'frozen'));
ALTER TABLE "user_week_scores" ADD CONSTRAINT "user_week_scores_status_check"
  CHECK ("status" IN ('provisional', 'final', 'frozen'));
ALTER TABLE "score_corrections" ADD CONSTRAINT "score_corrections_reason_check"
  CHECK ("reason" IN ('STAT_CORRECTION', 'AFTER_FREEZE'));
ALTER TABLE "score_corrections" ADD CONSTRAINT "score_corrections_applied_reason_check"
  CHECK (("reason" = 'STAT_CORRECTION') = "applied");
ALTER TABLE "player_game_stats" ADD CONSTRAINT "player_game_stats_counts_check" CHECK (
  "pass_td" >= 0 AND "pass_int" >= 0 AND "rush_td" >= 0 AND "receptions" >= 0 AND "rec_td" >= 0
  AND "return_td" >= 0 AND "fumble_rec_td" >= 0 AND "fumbles_lost" >= 0 AND "two_pt" >= 0
  AND "fg_made_0_39" >= 0 AND "fg_made_40_49" >= 0 AND "fg_made_50_plus" >= 0 AND "fg_missed" >= 0
  AND "xp_made" >= 0 AND "xp_missed" >= 0);

-- Score correction notices (PRD-002 §7.1) go through the same outbox.
ALTER TABLE "notification_queue" DROP CONSTRAINT "notification_queue_kind_check";
ALTER TABLE "notification_queue" ADD CONSTRAINT "notification_queue_kind_check"
  CHECK ("kind" IN ('LOCK', 'BURN', 'SLOT_REOPENED', 'SCORE_CORRECTION'));

-- ── Season totals (PRD-002 §8.4) ────────────────────────────────────────────
CREATE VIEW "user_season_totals" AS
  SELECT "user_id", "season", SUM("points_x100")::bigint AS "points_x100"
    FROM "user_week_scores"
   GROUP BY "user_id", "season";

-- ── §3.4: one ruleset per season ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION burnout_score_rules_version() RETURNS trigger AS $$
DECLARE pinned TEXT;
BEGIN
  SELECT rules_version INTO pinned FROM season_rules WHERE season = NEW.season;
  IF pinned IS NULL THEN
    RAISE EXCEPTION 'RULES_VERSION: season % has no pinned ruleset', NEW.season USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.rules_version <> pinned THEN
    RAISE EXCEPTION 'RULES_VERSION: season % is scored under %, not %', NEW.season, pinned, NEW.rules_version
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "player_game_scores_rules_version" BEFORE INSERT OR UPDATE ON "player_game_scores"
  FOR EACH ROW EXECUTE FUNCTION burnout_score_rules_version();

CREATE OR REPLACE FUNCTION burnout_season_rules_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'RULES_VERSION: season_rules is fixed once pinned (% rejected)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "season_rules_immutable" BEFORE UPDATE OR DELETE ON "season_rules"
  FOR EACH ROW EXECUTE FUNCTION burnout_season_rules_immutable();

-- ── §6 / AC8: frozen is permanent ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION burnout_reject_frozen_update() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'frozen' THEN
    RAISE EXCEPTION 'SCORE_FROZEN: % on frozen %.% rejected', TG_OP, TG_TABLE_NAME, OLD.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "player_game_scores_frozen" BEFORE UPDATE ON "player_game_scores"
  FOR EACH ROW EXECUTE FUNCTION burnout_reject_frozen_update();
CREATE TRIGGER "user_week_scores_frozen" BEFORE UPDATE ON "user_week_scores"
  FOR EACH ROW EXECUTE FUNCTION burnout_reject_frozen_update();

-- Stat lines behind a frozen score cannot change either.
CREATE OR REPLACE FUNCTION burnout_stats_frozen() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM player_game_scores WHERE stats_id = OLD.id AND status = 'frozen') THEN
    RAISE EXCEPTION 'SCORE_FROZEN: stat line % belongs to a frozen score', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "player_game_stats_frozen" BEFORE UPDATE ON "player_game_stats"
  FOR EACH ROW EXECUTE FUNCTION burnout_stats_frozen();

-- ── Append-only tables ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION burnout_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY: % on % rejected', TG_OP, TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "score_corrections_append_only" BEFORE UPDATE OR DELETE ON "score_corrections"
  FOR EACH ROW EXECUTE FUNCTION burnout_append_only();
CREATE TRIGGER "score_corrections_no_truncate" BEFORE TRUNCATE ON "score_corrections"
  FOR EACH STATEMENT EXECUTE FUNCTION burnout_append_only();
CREATE TRIGGER "week_freezes_append_only" BEFORE UPDATE OR DELETE ON "week_freezes"
  FOR EACH ROW EXECUTE FUNCTION burnout_append_only();
CREATE TRIGGER "player_game_scores_no_delete" BEFORE DELETE ON "player_game_scores"
  FOR EACH ROW EXECUTE FUNCTION burnout_append_only();
CREATE TRIGGER "player_game_stats_no_delete" BEFORE DELETE ON "player_game_stats"
  FOR EACH ROW EXECUTE FUNCTION burnout_append_only();
