-- Decisions 2026-10-27: late entry scoring, Out/IR players unselectable.

-- AlterTable
ALTER TABLE "contest_entries" ADD COLUMN     "scoring_from_week" SMALLINT NOT NULL DEFAULT 1;

-- ── Late entry (PRD-003 §3, PRD-004 D7) ──────────────────────────────────────
-- An entry's prize standings start the week after the last week that had
-- already begun (any window at or before entered_at) when the entry was
-- created. Points from weeks already under way never count for prizes, so
-- nobody can buy in after seeing a hot start. Computed here so no code path
-- can choose it.
CREATE OR REPLACE FUNCTION burnout_entry_scoring_from_week() RETURNS trigger AS $$
BEGIN
  SELECT COALESCE(max(w.week) + 1, 1) INTO NEW.scoring_from_week
    FROM game_windows w JOIN contest_pools p ON p.season = w.season
   WHERE p.id = NEW.pool_id AND w.scheduled_et <= NEW.entered_at;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "contest_entries_scoring_from_week" BEFORE INSERT ON "contest_entries"
  FOR EACH ROW EXECUTE FUNCTION burnout_entry_scoring_from_week();

-- ── Out / IR players (PRD-006 §7.3) ──────────────────────────────────────────
ALTER TABLE "season_submissions" DROP CONSTRAINT "season_submissions_void_reason_check";
ALTER TABLE "season_submissions" ADD CONSTRAINT "season_submissions_void_reason_check"
  CHECK ("void_reason" IS NULL OR "void_reason" IN ('GAME_CANCELED', 'ADMIN_VOID', 'PLAYER_NO_GAME', 'PLAYER_INACTIVE'));
