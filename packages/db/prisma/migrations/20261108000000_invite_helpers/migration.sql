-- Invite helpers (PRD-006 §6.10, Nath 2026-10-30): a 'recruiter' may make,
-- list and revoke their own sign-up codes, nothing else an admin can do.
ALTER TABLE "users" DROP CONSTRAINT "users_role_check";
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("role" IN ('user', 'admin', 'recruiter'));
