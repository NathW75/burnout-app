-- PRD-007 §8: what the web app needs from the API.

-- §8.3 In-app inbox: read state is separate from delivery (dispatched_at).
ALTER TABLE "notification_queue" ADD COLUMN "read_at" TIMESTAMPTZ;
CREATE INDEX "idx_notification_queue_user_created" ON "notification_queue" ("user_id", "created_at" DESC);

-- §8.1 The season field board lists everyone with a lineup in the season.
CREATE INDEX "idx_season_submissions_season_user" ON "season_submissions" ("season", "user_id");

-- §8.5 Feedback (SPEC-feedback-system.md, adapted to sessions and the worker).
CREATE TABLE "feedback" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "screen" VARCHAR(100) NOT NULL,
    "body" TEXT NOT NULL,
    "submitted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tags" JSONB,
    "classified_at" TIMESTAMPTZ,
    "classify_attempts" SMALLINT NOT NULL DEFAULT 0,
    "reviewed" BOOLEAN NOT NULL DEFAULT false,
    "reviewed_at" TIMESTAMPTZ,
    "reviewed_by" UUID,

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "feedback_body_length" CHECK (char_length("body") BETWEEN 1 AND 2000)
);
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "idx_feedback_submitted" ON "feedback" ("submitted_at" DESC);
CREATE INDEX "idx_feedback_reviewed" ON "feedback" ("reviewed");
CREATE INDEX "idx_feedback_unclassified" ON "feedback" ("submitted_at") WHERE "classified_at" IS NULL;
CREATE INDEX "idx_feedback_tags" ON "feedback" USING GIN ("tags");
