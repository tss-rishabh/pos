-- Apply explicitly to the writer. Session secrets are stored only as SHA-256 hashes.
CREATE TABLE pos_rewrite_sessions (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  user_id VARCHAR(32) NOT NULL,
  secret_hash VARCHAR(64) NOT NULL,
  auth_version VARCHAR(64) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  INDEX ix_rewrite_session_user(user_id),
  INDEX ix_rewrite_session_expiry(expires_at)
) ENGINE=InnoDB;
