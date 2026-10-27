-- PRD-006 §11.6 (schedule import): a game window's schedule is fixed once it
-- leaves 'pending'. Its kickoff time, week and games never move after the
-- lock (hard constraint 4: the lock stands), and a window that has locked,
-- gone final, or been canceled or postponed is never deleted. Status changes
-- (pending → locked → final, → canceled by admin) are unaffected.

CREATE OR REPLACE FUNCTION game_windows_schedule_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'pending' THEN
      RAISE EXCEPTION 'WINDOW_SCHEDULE_FIXED: game window % is % and cannot be deleted', OLD.id, OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'pending'
     AND (NEW.season, NEW.week, NEW.scheduled_et, NEW.msf_game_ids)
         IS DISTINCT FROM (OLD.season, OLD.week, OLD.scheduled_et, OLD.msf_game_ids) THEN
    RAISE EXCEPTION 'WINDOW_SCHEDULE_FIXED: game window % is %; its kickoff, week and games are fixed', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER game_windows_schedule_guard
  BEFORE UPDATE OR DELETE ON game_windows
  FOR EACH ROW EXECUTE FUNCTION game_windows_schedule_guard();

-- The import finds a week's windows by kickoff time.
CREATE INDEX IF NOT EXISTS idx_game_windows_season_week ON game_windows(season, week, scheduled_et);
