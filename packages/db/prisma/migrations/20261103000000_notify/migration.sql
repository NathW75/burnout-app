-- PRD-008 Phase 1: email delivery of queued notices.

-- Dispatch bookkeeping on the outbox. read_at (inbox) stays separate from delivery.
ALTER TABLE "notification_queue"
  ADD COLUMN "dispatch_claimed_at" TIMESTAMPTZ,
  ADD COLUMN "dispatch_attempts" SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN "dispatch_next_at" TIMESTAMPTZ,
  ADD COLUMN "dispatch_result" VARCHAR(60),
  ADD COLUMN "dispatch_ref" VARCHAR(120);

ALTER TABLE "notification_queue"
  ADD CONSTRAINT "notification_queue_dispatch_result_check"
  CHECK ("dispatch_result" IS NULL OR "dispatch_result" ~ '^(sent|skipped:[a-z_]+|failed:[a-z0-9_]+)$');

-- What the sender scans: undispatched rows, oldest first.
CREATE INDEX "idx_notification_queue_undispatched" ON "notification_queue" ("created_at") WHERE "dispatched_at" IS NULL;

-- Per-user, per-channel, per-kind choices. No row = the PRD-008 §4 default.
CREATE TABLE "notification_preferences" (
    "user_id" UUID NOT NULL,
    "channel" VARCHAR(10) NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id", "channel", "kind"),
    CONSTRAINT "notification_preferences_channel_check" CHECK ("channel" IN ('email', 'push'))
);
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The unsubscribe switch: 'off' stops all optional email (required transactional mail still goes).
ALTER TABLE "users" ADD COLUMN "email_notifications" VARCHAR(3) NOT NULL DEFAULT 'on';
ALTER TABLE "users" ADD CONSTRAINT "users_email_notifications_check" CHECK ("email_notifications" IN ('on', 'off'));
