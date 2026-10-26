-- PRD-001 burn engine guarantees that Prisma's schema language cannot express.
-- These are the database-level half of the guarantees; the application-level
-- half lives in @burnout/db (createDbClient) and @burnout/burn-engine.

-- ── §7: game window status domain ────────────────────────────────────────────
ALTER TABLE "game_windows"
  ADD CONSTRAINT "game_windows_status_check"
  CHECK ("status" IN ('pending', 'locked', 'final', 'canceled', 'postponed'));

-- ── §3.1 / §7: slot keys and void reasons ────────────────────────────────────
ALTER TABLE "season_submissions"
  ADD CONSTRAINT "season_submissions_slot_key_check"
  CHECK ("slot_key" IN ('qb', 'rb1', 'rb2', 'wr1', 'wr2', 'wr3', 'te', 'flex', 'k'));

ALTER TABLE "season_submissions"
  ADD CONSTRAINT "season_submissions_void_reason_check"
  CHECK ("void_reason" IS NULL OR "void_reason" IN ('GAME_CANCELED', 'ADMIN_VOID'));

-- A voided submission can never be in a locked state.
ALTER TABLE "season_submissions"
  ADD CONSTRAINT "season_submissions_void_not_locked_check"
  CHECK ("void_reason" IS NULL OR "locked_at" IS NULL);

ALTER TABLE "weekly_submissions"
  ADD CONSTRAINT "weekly_submissions_slot_key_check"
  CHECK ("slot_key" IN ('qb', 'rb1', 'rb2', 'wr1', 'wr2', 'wr3', 'te', 'flex', 'k'));

ALTER TABLE "notification_queue"
  ADD CONSTRAINT "notification_queue_kind_check"
  CHECK ("kind" IN ('LOCK', 'BURN', 'SLOT_REOPENED'));

-- ── §5 two-part burn criterion, enforced on INSERT ──────────────────────────
-- A burn_records row may only be created for a season_submissions row that
--   (a) was locked (locked_at IS NOT NULL) and not voided, and
--   (b) belongs to a game window whose status is 'final',
-- and whose user/player/season/week/window/locked_at match the submission.
-- burn_records.submission_id references season_submissions only, so a weekly
-- contest submission can never be the source of a burn (§3.3 isolation).
CREATE OR REPLACE FUNCTION burnout_enforce_burn_criterion() RETURNS trigger AS $$
DECLARE
  s RECORD;
  w_status TEXT;
BEGIN
  SELECT * INTO s FROM season_submissions WHERE id = NEW.submission_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BURN_CRITERION: submission % does not exist', NEW.submission_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF s.locked_at IS NULL OR s.void_reason IS NOT NULL THEN
    RAISE EXCEPTION 'BURN_CRITERION: submission % was not locked (condition a)', NEW.submission_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT status INTO w_status FROM game_windows WHERE id = s.game_window_id;
  IF w_status IS DISTINCT FROM 'final' THEN
    RAISE EXCEPTION 'BURN_CRITERION: game window % is %, not final (condition b)', s.game_window_id, w_status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.user_id <> s.user_id
     OR NEW.player_id <> s.player_id
     OR NEW.season <> s.season
     OR NEW.week <> s.week
     OR NEW.game_window_id <> s.game_window_id
     OR NEW.locked_at <> s.locked_at THEN
    RAISE EXCEPTION 'BURN_CRITERION: burn record does not match submission %', NEW.submission_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "burn_records_enforce_criterion"
  BEFORE INSERT ON "burn_records"
  FOR EACH ROW EXECUTE FUNCTION burnout_enforce_burn_criterion();

-- ── §5.3 / AC6: burn_records is write-once ──────────────────────────────────
-- UPDATE and DELETE are rejected unless the transaction has declared a
-- sysadmin SLOT_REOPENED authorization:
--   SET LOCAL burnout.slot_reopen_audit_id = '<security_audit_log.id>';
-- and that audit row exists with event_type = 'SLOT_REOPENED' and
-- metadata->>'burn_record_id' equal to the row being changed. No audit row,
-- no change. TRUNCATE is always rejected.
CREATE OR REPLACE FUNCTION burnout_burn_records_immutable() RETURNS trigger AS $$
DECLARE
  audit_id TEXT := NULLIF(current_setting('burnout.slot_reopen_audit_id', true), '');
BEGIN
  IF audit_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM security_audit_log
     WHERE id::text = audit_id
       AND event_type = 'SLOT_REOPENED'
       AND metadata->>'burn_record_id' = OLD.id::text
  ) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'BURN_RECORD_IMMUTABLE: % on burn_records % rejected (no SLOT_REOPENED authorization)', TG_OP, OLD.id
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "burn_records_immutable"
  BEFORE UPDATE OR DELETE ON "burn_records"
  FOR EACH ROW EXECUTE FUNCTION burnout_burn_records_immutable();

CREATE OR REPLACE FUNCTION burnout_burn_records_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'BURN_RECORD_IMMUTABLE: TRUNCATE on burn_records rejected'
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "burn_records_no_truncate"
  BEFORE TRUNCATE ON "burn_records"
  FOR EACH STATEMENT EXECUTE FUNCTION burnout_burn_records_no_truncate();
