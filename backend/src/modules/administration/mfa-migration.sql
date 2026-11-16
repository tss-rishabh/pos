-- Rewrite-owned operator MFA enrollment/replay state only. No legacy table DDL.
CREATE TABLE IF NOT EXISTS pos_rewrite_operator_mfa_enrollments (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  actor_id VARCHAR(32) NOT NULL,
  operator_id VARCHAR(32) NOT NULL,
  actor_version VARCHAR(64) NOT NULL,
  operator_version VARCHAR(64) NOT NULL,
  sealed_secret VARCHAR(1024) NOT NULL,
  state VARCHAR(16) NOT NULL,
  attempts INT NOT NULL,
  last_attempt_at DATETIME(3) NULL,
  expires_at DATETIME(3) NOT NULL,
  request_id VARCHAR(128) NULL,
  created_at DATETIME(3) NOT NULL,
  INDEX ix_rewrite_operator_mfa_pending(operator_id,state,expires_at),
  INDEX ix_rewrite_operator_mfa_actor(actor_id,state),
  INDEX ix_rewrite_operator_mfa_expiry(expires_at)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_operator_mfa_mutations (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  actor_id VARCHAR(32) NOT NULL,
  operator_id VARCHAR(32) NOT NULL,
  hash VARCHAR(64) NOT NULL,
  result JSON NOT NULL,
  request_id VARCHAR(128) NULL,
  created_at DATETIME(3) NOT NULL,
  INDEX ix_rewrite_operator_mfa_mutation_time(created_at)
) ENGINE=InnoDB;
