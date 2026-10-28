-- Invite-only sign-up (PRD-006 §6.10, decided 2026-10-28): per-person, single-use codes.
CREATE TABLE "invite_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code_hash" CHAR(64) NOT NULL,          -- sha256 of the normalized code; the code itself is shown once
    "email" TEXT,                            -- when set, only this address can use it
    "note" VARCHAR(200),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ,
    "used_at" TIMESTAMPTZ,
    "used_by" UUID,
    "revoked_at" TIMESTAMPTZ,

    CONSTRAINT "invite_codes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "invite_codes_email_lower_check" CHECK ("email" IS NULL OR "email" = lower("email")),
    CONSTRAINT "invite_codes_used_pair_check" CHECK (("used_at" IS NULL) = ("used_by" IS NULL))
);
CREATE UNIQUE INDEX "invite_codes_code_hash_key" ON "invite_codes"("code_hash");
CREATE UNIQUE INDEX "invite_codes_used_by_key" ON "invite_codes"("used_by");
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_used_by_fkey" FOREIGN KEY ("used_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
