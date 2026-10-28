-- Feedback alerts (PRD-007 §10.1): the worker emails admins about each new
-- piece of feedback, once. Feedback that already exists isn't emailed.
ALTER TABLE feedback
  ADD COLUMN admin_alerted_at     TIMESTAMPTZ,
  ADD COLUMN admin_alert_attempts SMALLINT NOT NULL DEFAULT 0;

UPDATE feedback SET admin_alerted_at = now();

CREATE INDEX idx_feedback_alert_pending ON feedback (submitted_at) WHERE admin_alerted_at IS NULL;
