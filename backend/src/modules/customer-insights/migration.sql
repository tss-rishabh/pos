CREATE TABLE IF NOT EXISTS pos_rewrite_customer_profile_adjustments (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  operator_id VARCHAR(32) NOT NULL,
  store_id VARCHAR(32) NOT NULL,
  checkout_id VARCHAR(36) NOT NULL,
  customer_id VARCHAR(32) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  checkout_version INT NOT NULL,
  receipt JSON NOT NULL,
  request_id VARCHAR(128) NULL,
  created_at DATETIME(3) NOT NULL,
  INDEX ix_customer_profile_checkout(checkout_id,created_at)
) ENGINE=InnoDB;
