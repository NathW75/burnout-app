-- PRD-006 §7.5, PRD-001 §5.4: one person, one player, whatever IDs the feed sends.
-- MySportsFeeds sometimes lists the same person under two IDs. The roster sync
-- keeps one ID per person (canonical_id IS NULL) and points the others at it.

ALTER TABLE "nfl_players"
  ADD COLUMN "canonical_id" VARCHAR(50),
  ADD COLUMN "identity_source" VARCHAR(10),
  ADD COLUMN "identity_review" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "nfl_players" ADD CONSTRAINT "nfl_players_canonical_id_fkey"
  FOREIGN KEY ("canonical_id") REFERENCES "nfl_players"("msf_player_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "nfl_players" ADD CONSTRAINT "nfl_players_canonical_not_self_check"
  CHECK ("canonical_id" IS NULL OR "canonical_id" <> "msf_player_id");
ALTER TABLE "nfl_players" ADD CONSTRAINT "nfl_players_identity_source_check"
  CHECK ("identity_source" IS NULL OR "identity_source" IN ('auto', 'manual'));
CREATE INDEX "idx_nfl_players_canonical" ON "nfl_players" ("canonical_id") WHERE "canonical_id" IS NOT NULL;

-- No chains: an alias points at a player that is not itself an alias, and a
-- player that others point at can't become an alias.
CREATE OR REPLACE FUNCTION burnout_player_identity_no_chain() RETURNS trigger AS $$
BEGIN
  IF NEW.canonical_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM nfl_players WHERE msf_player_id = NEW.canonical_id AND canonical_id IS NOT NULL) THEN
      RAISE EXCEPTION 'PLAYER_IDENTITY: % cannot point at alias %', NEW.msf_player_id, NEW.canonical_id USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM nfl_players WHERE canonical_id = NEW.msf_player_id) THEN
      RAISE EXCEPTION 'PLAYER_IDENTITY: % has aliases and cannot become one', NEW.msf_player_id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "nfl_players_identity_no_chain" BEFORE INSERT OR UPDATE OF "canonical_id" ON "nfl_players"
  FOR EACH ROW EXECUTE FUNCTION burnout_player_identity_no_chain();

-- A season lineup can only name a canonical player. Rows written before a merge
-- keep their alias (locked rows are frozen anyway); a new pick, or a change of
-- player, must use the canonical ID.
CREATE OR REPLACE FUNCTION burnout_submission_canonical_player() RETURNS trigger AS $$
DECLARE
  canon VARCHAR(50);
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.player_id IS NOT DISTINCT FROM OLD.player_id THEN
    RETURN NEW;
  END IF;
  SELECT canonical_id INTO canon FROM nfl_players WHERE msf_player_id = NEW.player_id;
  IF canon IS NOT NULL THEN
    RAISE EXCEPTION 'PLAYER_ALIAS: % is another ID for player %', NEW.player_id, canon USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "season_submissions_canonical_player" BEFORE INSERT OR UPDATE OF "player_id" ON "season_submissions"
  FOR EACH ROW EXECUTE FUNCTION burnout_submission_canonical_player();

-- A pick on an alias whose person is already in the same lineup is voided (§7.5).
ALTER TABLE "season_submissions" DROP CONSTRAINT "season_submissions_void_reason_check";
ALTER TABLE "season_submissions" ADD CONSTRAINT "season_submissions_void_reason_check"
  CHECK ("void_reason" IS NULL OR "void_reason" IN ('GAME_CANCELED', 'ADMIN_VOID', 'PLAYER_NO_GAME', 'PLAYER_INACTIVE', 'PLAYER_MERGED'));
