CREATE TABLE pos_rewrite_pending_order_cancellations (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  order_id VARCHAR(32) NOT NULL,
  store_id VARCHAR(32) NOT NULL,
  counter_id VARCHAR(32) NOT NULL,
  operator_id VARCHAR(32) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  receipt_hash VARCHAR(64) NOT NULL,
  receipt JSON NOT NULL,
  request_id VARCHAR(128) NULL,
  created_at DATETIME NOT NULL,
  UNIQUE KEY uq_pending_cancel_order (order_id),
  KEY ix_pending_cancel_store (store_id, created_at, id)
) ENGINE=InnoDB;
