-- Rewrite-owned command/proof tables only. Legacy ALTER proposals are separate.
CREATE TABLE IF NOT EXISTS pos_rewrite_voucher_selections (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  operator_id VARCHAR(32) NOT NULL,
  customer_id VARCHAR(32) NOT NULL,
  actor_version CHAR(64) NOT NULL,
  contact_json JSON NOT NULL,
  expires_at BIGINT NOT NULL,
  consumed_by VARCHAR(36) NULL,
  KEY ix_voucher_selection_expiry (expires_at,id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_voucher_operations (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  operator_id VARCHAR(32) NOT NULL,
  customer_id VARCHAR(32) NOT NULL,
  kind VARCHAR(16) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  execution_id VARCHAR(36) NOT NULL,
  store_id VARCHAR(32) NULL,
  checkout_id VARCHAR(36) NULL,
  result_json JSON NULL,
  error_code VARCHAR(40) NULL,
  request_id VARCHAR(128) NULL,
  created_at DATETIME NOT NULL,
  KEY ix_voucher_operation_actor (operator_id,created_at,id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_voucher_pin_budgets (
  voucher_id VARCHAR(32) NOT NULL PRIMARY KEY,
  failures INT NOT NULL,
  window_started_at BIGINT NOT NULL
) ENGINE=InnoDB;
