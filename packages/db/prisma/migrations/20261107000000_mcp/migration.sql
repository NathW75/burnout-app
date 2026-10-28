-- PRD-011 Phase 1a: credentials for the AI connector (/mcp). Personal tokens
-- now; OAuth access and refresh tokens use the same table (part 2).
-- Only the SHA-256 of each token is stored; the token is shown once.
CREATE TABLE mcp_credentials (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         VARCHAR(16) NOT NULL CHECK (kind IN ('personal', 'oauth_access', 'oauth_refresh')),
  grant_id     UUID,
  token_hash   CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  label        VARCHAR(60),
  scope        VARCHAR(40) NOT NULL DEFAULT 'burnout.read' CHECK (scope = 'burnout.read'),
  expires_at   TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ,
  CHECK (expires_at > created_at),
  CHECK ((kind = 'personal') = (grant_id IS NULL))
);

CREATE INDEX idx_mcp_credentials_user_active ON mcp_credentials (user_id) WHERE revoked_at IS NULL;
