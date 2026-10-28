-- PRD-008 Phase 2: web push. Push is tracked separately from email: each channel
-- delivers (or skips) a notice on its own.
ALTER TABLE "notification_queue"
  ADD COLUMN "push_dispatched_at" TIMESTAMPTZ,
  ADD COLUMN "push_claimed_at" TIMESTAMPTZ,
  ADD COLUMN "push_attempts" SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN "push_next_at" TIMESTAMPTZ,
  ADD COLUMN "push_result" VARCHAR(60);
ALTER TABLE "notification_queue"
  ADD CONSTRAINT "notification_queue_push_result_check"
  CHECK ("push_result" IS NULL OR "push_result" ~ '^(sent|skipped:[a-z_]+|failed:[a-z0-9_]+)$');
CREATE INDEX "idx_notification_queue_push_undispatched" ON "notification_queue" ("created_at") WHERE "push_dispatched_at" IS NULL;

-- One row per browser/device that allowed notifications.
CREATE TABLE "push_subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" VARCHAR(200) NOT NULL,
    "auth" VARCHAR(100) NOT NULL,
    "user_agent" VARCHAR(300),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_ok_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "push_subscriptions_endpoint_https_check" CHECK ("endpoint" LIKE 'https://%')
);
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");
CREATE INDEX "idx_push_subscriptions_user_active" ON "push_subscriptions" ("user_id") WHERE "revoked_at" IS NULL;
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
