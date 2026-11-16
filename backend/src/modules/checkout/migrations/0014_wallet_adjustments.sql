CREATE TABLE IF NOT EXISTS pos_rewrite_wallet_adjustments (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  operator_id VARCHAR(32) NOT NULL,
  customer_id VARCHAR(32) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  execution_id VARCHAR(36) NOT NULL,
  request_json TEXT NOT NULL,
  result_json TEXT NULL,
  request_id VARCHAR(128) NULL,
  created_at DATETIME NOT NULL,
  KEY ix_wallet_adjustment_customer (customer_id, created_at, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS pos_rewrite_wallet_consumptions (
  operation_id VARCHAR(36) NOT NULL,
  history_id VARCHAR(32) NOT NULL,
  asset VARCHAR(8) NOT NULL,
  used_before DOUBLE NOT NULL,
  used_after DOUBLE NOT NULL,
  PRIMARY KEY(operation_id, history_id)
) ENGINE=InnoDB;
