-- PRD-006 guarantees that Prisma's schema language cannot express.

-- ── §6 Accounts ──────────────────────────────────────────────────────────────
ALTER TABLE "users" ADD CONSTRAINT "users_status_check" CHECK ("status" IN ('active', 'suspended'));
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("role" IN ('user', 'admin'));
ALTER TABLE "users" ADD CONSTRAINT "users_email_lower_check" CHECK ("email" = lower("email"));

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_client_check" CHECK ("client" IN ('web', 'mobile'));
ALTER TABLE "auth_factors" ADD CONSTRAINT "auth_factors_kind_check" CHECK ("kind" IN ('totp', 'sms', 'passkey'));
-- At most one active TOTP factor per user.
CREATE UNIQUE INDEX "auth_factors_one_active_totp" ON "auth_factors" ("user_id")
  WHERE "kind" = 'totp' AND "confirmed_at" IS NOT NULL AND "disabled_at" IS NULL;
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_purpose_check" CHECK ("purpose" IN ('email_verify', 'password_reset'));

-- ── §6.8 Audit log is append-only (the PRD-001 reopen check reads it) ────────
CREATE TRIGGER "security_audit_log_append_only" BEFORE UPDATE OR DELETE ON "security_audit_log"
  FOR EACH ROW EXECUTE FUNCTION burnout_append_only();
CREATE TRIGGER "security_audit_log_no_truncate" BEFORE TRUNCATE ON "security_audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION burnout_append_only();

-- ── §7 Players: text only (NIL) ──────────────────────────────────────────────
ALTER TABLE "nfl_players" ADD CONSTRAINT "nfl_players_position_check" CHECK ("position" IN ('QB', 'RB', 'WR', 'TE', 'K', 'FB'));
ALTER TABLE "nfl_players" ADD CONSTRAINT "nfl_players_injury_check"
  CHECK ("injury_status" IN ('Active', 'Questionable', 'Doubtful', 'Out', 'IR', 'PUP'));

-- ── §9 Three-gate confirmations ──────────────────────────────────────────────
ALTER TABLE "lineup_confirmations" ADD CONSTRAINT "lineup_confirmations_status_check"
  CHECK ("status" IN ('reviewed', 'acknowledged', 'confirmed'));
ALTER TABLE "lineup_confirmations" ADD CONSTRAINT "lineup_confirmations_gate_order_check" CHECK (
  ("gate2_at" IS NULL OR "gate2_at" >= "gate1_at") AND
  ("gate3_at" IS NULL OR ("gate2_at" IS NOT NULL AND "gate3_at" >= "gate2_at")) AND
  ("status" <> 'acknowledged' OR "gate2_at" IS NOT NULL) AND
  ("status" <> 'confirmed' OR "gate3_at" IS NOT NULL));
CREATE OR REPLACE FUNCTION burnout_lineup_confirmation_update() RETURNS trigger AS $$
BEGIN
  IF (NEW.id, NEW.user_id, NEW.season, NEW.week, NEW.slots, NEW.gate1_at, NEW.expires_at, NEW.ip_address, NEW.user_agent)
     IS DISTINCT FROM (OLD.id, OLD.user_id, OLD.season, OLD.week, OLD.slots, OLD.gate1_at, OLD.expires_at, OLD.ip_address, OLD.user_agent)
     OR (OLD.gate2_at IS NOT NULL AND NEW.gate2_at IS DISTINCT FROM OLD.gate2_at)
     OR (OLD.gate3_at IS NOT NULL AND NEW.gate3_at IS DISTINCT FROM OLD.gate3_at)
     OR NOT (NEW.status = OLD.status
             OR (OLD.status = 'reviewed' AND NEW.status = 'acknowledged')
             OR (OLD.status = 'acknowledged' AND NEW.status = 'confirmed')) THEN
    RAISE EXCEPTION 'CONFIRMATION_IMMUTABLE: gates move forward once, in order' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "lineup_confirmations_update" BEFORE UPDATE ON "lineup_confirmations"
  FOR EACH ROW EXECUTE FUNCTION burnout_lineup_confirmation_update();
CREATE TRIGGER "lineup_confirmations_no_delete" BEFORE DELETE ON "lineup_confirmations"
  FOR EACH ROW EXECUTE FUNCTION burnout_append_only();

-- Receipts are the dispute record: append-only.
CREATE TRIGGER "submission_receipts_append_only" BEFORE UPDATE OR DELETE ON "submission_receipts"
  FOR EACH ROW EXECUTE FUNCTION burnout_append_only();
CREATE TRIGGER "submission_receipts_no_truncate" BEFORE TRUNCATE ON "submission_receipts"
  FOR EACH STATEMENT EXECUTE FUNCTION burnout_append_only();

-- ── §9.5 / PRD-001 §6.5 Season submissions ───────────────────────────────────
ALTER TABLE "season_submissions" DROP CONSTRAINT "season_submissions_void_reason_check";
ALTER TABLE "season_submissions" ADD CONSTRAINT "season_submissions_void_reason_check"
  CHECK ("void_reason" IS NULL OR "void_reason" IN ('GAME_CANCELED', 'ADMIN_VOID', 'PLAYER_NO_GAME'));

-- A locked submission is frozen. The only permitted change is the PRD-001 §6.1
-- slot reopen: locked_at → NULL with a void reason, nothing else touched.
CREATE OR REPLACE FUNCTION burnout_locked_submission_frozen() RETURNS trigger AS $$
BEGIN
  IF OLD.locked_at IS NOT NULL THEN
    IF NEW.locked_at IS NULL AND NEW.void_reason IS NOT NULL
       AND (NEW.id, NEW.user_id, NEW.week, NEW.season, NEW.slot_key, NEW.player_id, NEW.game_window_id, NEW.submitted_at, NEW.receipt_id)
           IS NOT DISTINCT FROM
           (OLD.id, OLD.user_id, OLD.week, OLD.season, OLD.slot_key, OLD.player_id, OLD.game_window_id, OLD.submitted_at, OLD.receipt_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'SUBMISSION_LOCKED: submission % locked at %', OLD.id, OLD.locked_at USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "season_submissions_locked_frozen" BEFORE UPDATE ON "season_submissions"
  FOR EACH ROW EXECUTE FUNCTION burnout_locked_submission_frozen();
CREATE OR REPLACE FUNCTION burnout_locked_submission_no_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'SUBMISSION_LOCKED: submission % locked at %', OLD.id, OLD.locked_at USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "season_submissions_locked_no_delete" BEFORE DELETE ON "season_submissions"
  FOR EACH ROW EXECUTE FUNCTION burnout_locked_submission_no_delete();

-- ── Notifications ────────────────────────────────────────────────────────────
ALTER TABLE "notification_queue" DROP CONSTRAINT "notification_queue_kind_check";
ALTER TABLE "notification_queue" ADD CONSTRAINT "notification_queue_kind_check" CHECK ("kind" IN (
  'LOCK', 'BURN', 'SLOT_REOPENED', 'SCORE_CORRECTION',
  'ENTRY_RECEIPT', 'REFUND', 'POOL_CANCELLED', 'PAYOUT_BLOCKED', 'PAYOUT_SENT', 'PAYOUT_FAILED',
  'LINEUP_RECEIPT', 'SUBMISSION_REPOINTED', 'SUBMISSION_VOIDED', 'SECURITY_ALERT'));
