CREATE TABLE IF NOT EXISTS pos_rewrite_discount_approvals (
  checkout_id VARCHAR(36) PRIMARY KEY,
  state JSON NOT NULL,
  updated_at DATETIME NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS pos_rewrite_discount_approval_limits (
  operator_id VARCHAR(32) PRIMARY KEY,
  last_sent_at_ms BIGINT NOT NULL,
  window_started_at_ms BIGINT NOT NULL,
  verification_attempts INT NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS pos_rewrite_discount_deliveries (
  id VARCHAR(80) PRIMARY KEY,
  checkout_id VARCHAR(36) NOT NULL,
  challenge_id VARCHAR(36) NULL,
  order_id VARCHAR(32) NULL,
  target_id VARCHAR(32) NOT NULL,
  kind VARCHAR(20) NOT NULL,
  status VARCHAR(16) NOT NULL,
  encrypted_code VARCHAR(256) NULL,
  request_id VARCHAR(128) NULL,
  operator_id VARCHAR(32) NOT NULL,
  created_at DATETIME NOT NULL,
  INDEX ix_discount_delivery_poll (status, created_at, id),
  INDEX ix_discount_delivery_challenge (checkout_id, challenge_id, status)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS pos_rewrite_discount_audits (
  order_id VARCHAR(32) PRIMARY KEY,
  checkout_id VARCHAR(36) NOT NULL,
  approval_id VARCHAR(36) NULL,
  approved_by VARCHAR(32) NULL,
  applied_by VARCHAR(32) NOT NULL,
  amount VARCHAR(16) NOT NULL,
  comment VARCHAR(45) NOT NULL,
  created_at DATETIME NOT NULL
) ENGINE=InnoDB;
