-- PRD-003 leaderboard guarantees that Prisma's schema language cannot express.

-- ── §7 Handles ───────────────────────────────────────────────────────────────
ALTER TABLE "users" ADD CONSTRAINT "users_handle_format_check"
  CHECK ("handle" IS NULL OR "handle" ~ '^[A-Za-z0-9_]{3,20}$');
CREATE UNIQUE INDEX "users_handle_lower_key" ON "users" (lower("handle"));

-- Every handle change goes through user_handle_history:
--   at most 2 changes per user per season (the signup handle is not a change);
--   a handle another user released less than 30 days ago cannot be claimed;
--   history rows are append-only except closing the current row (valid_to).
CREATE OR REPLACE FUNCTION burnout_handle_history_insert() RETURNS trigger AS $$
BEGIN
  IF NEW.is_change AND (
    SELECT count(*) FROM user_handle_history
     WHERE user_id = NEW.user_id AND season = NEW.season AND is_change) >= 2 THEN
    RAISE EXCEPTION 'HANDLE_CHANGE_LIMIT: user % already changed handle twice in %', NEW.user_id, NEW.season
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM user_handle_history h
     WHERE lower(h.handle) = lower(NEW.handle) AND h.user_id <> NEW.user_id
       AND (h.valid_to IS NULL OR h.valid_to > NEW.valid_from - interval '30 days')) THEN
    RAISE EXCEPTION 'HANDLE_RESERVED: % is in use or was released less than 30 days ago', NEW.handle
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "user_handle_history_insert" BEFORE INSERT ON "user_handle_history"
  FOR EACH ROW EXECUTE FUNCTION burnout_handle_history_insert();

CREATE OR REPLACE FUNCTION burnout_handle_history_update() RETURNS trigger AS $$
BEGIN
  IF OLD.valid_to IS NULL AND NEW.valid_to IS NOT NULL
     AND (NEW.user_id, NEW.handle, NEW.season, NEW.is_change, NEW.valid_from)
         IS NOT DISTINCT FROM (OLD.user_id, OLD.handle, OLD.season, OLD.is_change, OLD.valid_from) THEN
    RETURN NEW;   -- closing the current handle is the only permitted update
  END IF;
  RAISE EXCEPTION 'APPEND_ONLY: user_handle_history rows can only be closed' USING ERRCODE = 'insufficient_privilege';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "user_handle_history_update" BEFORE UPDATE ON "user_handle_history"
  FOR EACH ROW EXECUTE FUNCTION burnout_handle_history_update();
CREATE TRIGGER "user_handle_history_no_delete" BEFORE DELETE ON "user_handle_history"
  FOR EACH ROW EXECUTE FUNCTION burnout_append_only();

-- users.handle may only take a value that has an open history row for that user.
CREATE OR REPLACE FUNCTION burnout_users_handle_audited() RETURNS trigger AS $$
BEGIN
  IF NEW.handle IS DISTINCT FROM OLD.handle AND NEW.handle IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM user_handle_history
     WHERE user_id = NEW.id AND handle = NEW.handle AND valid_to IS NULL) THEN
    RAISE EXCEPTION 'HANDLE_UNAUDITED: handle changes must go through user_handle_history'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "users_handle_audited" BEFORE UPDATE OF "handle" ON "users"
  FOR EACH ROW EXECUTE FUNCTION burnout_users_handle_audited();

-- ── §3 Pools and entries ─────────────────────────────────────────────────────
ALTER TABLE "contest_pools" ADD CONSTRAINT "contest_pools_kind_check"
  CHECK ("kind" IN ('season_open', 'season_closed'));
ALTER TABLE "contest_pools" ADD CONSTRAINT "contest_pools_buy_in_check" CHECK ("buy_in_cents" > 0);

CREATE OR REPLACE FUNCTION burnout_entry_window() RETURNS trigger AS $$
DECLARE closes TIMESTAMPTZ;
BEGIN
  SELECT entry_closes_at INTO closes FROM contest_pools WHERE id = NEW.pool_id;
  IF NEW.entered_at >= closes THEN
    RAISE EXCEPTION 'ENTRY_CLOSED: pool % closed to entries at %', NEW.pool_id, closes
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "contest_entries_window" BEFORE INSERT ON "contest_entries"
  FOR EACH ROW EXECUTE FUNCTION burnout_entry_window();
CREATE TRIGGER "contest_entries_immutable" BEFORE UPDATE OR DELETE ON "contest_entries"
  FOR EACH ROW EXECUTE FUNCTION burnout_append_only();

-- ── §8 Snapshots ─────────────────────────────────────────────────────────────
ALTER TABLE "leaderboard_snapshots" ADD CONSTRAINT "leaderboard_snapshots_kind_check"
  CHECK ("kind" IN ('week_start', 'official'));
CREATE TRIGGER "leaderboard_snapshots_append_only" BEFORE UPDATE OR DELETE ON "leaderboard_snapshots"
  FOR EACH ROW EXECUTE FUNCTION burnout_append_only();
CREATE TRIGGER "leaderboard_snapshots_no_truncate" BEFORE TRUNCATE ON "leaderboard_snapshots"
  FOR EACH STATEMENT EXECUTE FUNCTION burnout_append_only();
