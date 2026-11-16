CREATE TABLE pos_rewrite_legacy_payment_recoveries (
  provider VARCHAR(8) NOT NULL,
  legacy_id VARCHAR(32) NOT NULL,
  attempt_id VARCHAR(36) NOT NULL,
  order_id VARCHAR(32) NOT NULL,
  store_id VARCHAR(32) NOT NULL,
  operator_id VARCHAR(32) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  request_id VARCHAR(128) NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (provider, legacy_id),
  UNIQUE KEY uq_legacy_payment_attempt (attempt_id),
  KEY ix_legacy_payment_order (order_id)
) ENGINE=InnoDB;
