CREATE TABLE IF NOT EXISTS pos_rewrite_desktop_sso_flows (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  status VARCHAR(24) NOT NULL,
  desktop_secret_hash VARCHAR(64) NOT NULL,
  browser_ticket_hash VARCHAR(64) NOT NULL,
  pairing_code_hash VARCHAR(64) NOT NULL,
  approval_secret_hash VARCHAR(64) NULL,
  operator_id VARCHAR(32) NULL,
  auth_version VARCHAR(128) NULL,
  approval_attempts INT NOT NULL DEFAULT 0,
  consumed_credential TEXT NULL,
  created_at_ms BIGINT NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  started_at_ms BIGINT NULL,
  approved_at_ms BIGINT NULL,
  consumed_at_ms BIGINT NULL,
  request_id VARCHAR(128) NULL,
  INDEX ix_desktop_sso_expiry(expires_at_ms,id)
) ENGINE=InnoDB;
