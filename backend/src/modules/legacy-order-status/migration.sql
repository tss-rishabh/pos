-- Rewrite-owned durable intent only. Explicit deployment on writer; never apply to a reader.
CREATE TABLE IF NOT EXISTS pos_rewrite_whole_order_status_commands (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  effect_key VARCHAR(64) NOT NULL UNIQUE,
  operator_id VARCHAR(32) NOT NULL,
  auth_version VARCHAR(64) NOT NULL,
  store_id VARCHAR(32) NOT NULL,
  order_id VARCHAR(32) NOT NULL,
  platform VARCHAR(16) NOT NULL,
  source VARCHAR(32) NOT NULL,
  return_operation_id VARCHAR(36) NULL,
  request_id VARCHAR(128) NULL,
  snapshot JSON NOT NULL,
  scope_hash VARCHAR(64) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  state VARCHAR(16) NOT NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  receipt JSON NULL,
  error_code VARCHAR(64) NULL,
  claimed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  INDEX ix_whole_order_status_dispatch(state,created_at),
  INDEX ix_whole_order_status_active(order_id,state),
  INDEX ix_whole_order_status_order(store_id,order_id,created_at)
) ENGINE=InnoDB;
-- Qualified STORE receiver uses the immutable command as its sole scope authority.
-- Installing this candidate requires excluding/draining legacy unqualified workers.
CREATE TABLE IF NOT EXISTS pos_rewrite_whole_order_status_receivers (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  accepted_at_ms BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_whole_order_status_attempts (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  operation_id VARCHAR(36) NOT NULL,
  platform VARCHAR(16) NOT NULL,
  state VARCHAR(16) NOT NULL,
  due_at_ms BIGINT UNSIGNED NOT NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  claimed_at_ms BIGINT UNSIGNED NULL,
  updated_at_ms BIGINT UNSIGNED NOT NULL,
  response JSON NULL,
  INDEX ix_whole_status_attempt_dispatch(state,due_at_ms),
  INDEX ix_whole_status_attempt_operation(operation_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_whole_order_status_vendor_calls (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  stage_id VARCHAR(64) NOT NULL,
  attempt INT UNSIGNED NOT NULL,
  body_hash VARCHAR(64) NULL,
  state VARCHAR(16) NOT NULL,
  response_code INT NULL,
  created_at_ms BIGINT UNSIGNED NOT NULL,
  updated_at_ms BIGINT UNSIGNED NOT NULL,
  UNIQUE KEY uq_whole_status_vendor_attempt(stage_id,attempt)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_whole_order_status_notifications (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  claim_token VARCHAR(36) NOT NULL,
  operation_id VARCHAR(36) NOT NULL,
  kind VARCHAR(16) NOT NULL,
  state VARCHAR(16) NOT NULL,
  updated_at_ms BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_whole_order_status_rates (
  platform VARCHAR(16) NOT NULL PRIMARY KEY,
  next_at_ms BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB;
