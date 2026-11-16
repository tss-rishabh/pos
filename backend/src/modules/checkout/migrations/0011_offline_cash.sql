CREATE TABLE IF NOT EXISTS pos_rewrite_offline_cash_devices (
  id VARCHAR(36) PRIMARY KEY,
  operator_id VARCHAR(32) NOT NULL,
  store_id VARCHAR(32) NOT NULL,
  counter_id VARCHAR(32) NOT NULL,
  public_key_json TEXT NOT NULL,
  key_hash VARCHAR(64) NOT NULL,
  created_at_ms BIGINT NOT NULL,
  revoked_at_ms BIGINT NULL,
  KEY ix_offline_cash_device_operator (operator_id,store_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS pos_rewrite_offline_cash_authorizations (
  id VARCHAR(36) PRIMARY KEY,
  device_id VARCHAR(36) NOT NULL,
  operator_id VARCHAR(32) NOT NULL,
  store_id VARCHAR(32) NOT NULL,
  counter_id VARCHAR(32) NOT NULL,
  business_date DATE NOT NULL,
  authorization_json TEXT NOT NULL,
  snapshot_json MEDIUMTEXT NOT NULL,
  snapshot_hash VARCHAR(64) NOT NULL,
  accepted_receipts INT NOT NULL,
  accepted_cents BIGINT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  revoked_at_ms BIGINT NULL,
  KEY ix_offline_cash_authorization_device (device_id,created_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS pos_rewrite_offline_cash_receipts (
  id VARCHAR(36) PRIMARY KEY,
  authorization_id VARCHAR(36) NOT NULL,
  device_id VARCHAR(36) NOT NULL,
  sequence INT NOT NULL,
  operator_id VARCHAR(32) NOT NULL,
  store_id VARCHAR(32) NOT NULL,
  counter_id VARCHAR(32) NOT NULL,
  draft_id VARCHAR(36) NOT NULL,
  business_date DATE NOT NULL,
  completed_at_ms BIGINT NOT NULL,
  accepted_at_ms BIGINT NOT NULL,
  receipt_number VARCHAR(24) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  receipt_json MEDIUMTEXT NOT NULL,
  payable_cents BIGINT NOT NULL,
  cash_received_cents BIGINT NOT NULL,
  change_cents BIGINT NOT NULL,
  status VARCHAR(16) NOT NULL,
  conflicts_json TEXT NOT NULL,
  version INT NOT NULL,
  order_id VARCHAR(32) NULL,
  request_id VARCHAR(128) NULL,
  CONSTRAINT ck_offline_cash_receipt_amount CHECK (payable_cents > 0 AND change_cents >= 0 AND cash_received_cents - change_cents = payable_cents),
  UNIQUE KEY uq_offline_cash_receipt_sequence (authorization_id,sequence),
  UNIQUE KEY uq_offline_cash_receipt_draft (operator_id,draft_id),
  UNIQUE KEY uq_offline_cash_receipt_number (receipt_number),
  UNIQUE KEY uq_offline_cash_receipt_order (order_id),
  KEY ix_offline_cash_receipt_finance (store_id,business_date,id),
  KEY ix_offline_cash_receipt_queue (store_id,status,accepted_at_ms,id),
  KEY ix_offline_cash_receipt_device (device_id,accepted_at_ms,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS pos_rewrite_offline_cash_order_links (
  receipt_id VARCHAR(36) PRIMARY KEY,
  order_id VARCHAR(32) NOT NULL,
  payable_cents BIGINT NOT NULL,
  business_date DATE NOT NULL,
  projection_hash VARCHAR(64) NOT NULL,
  finalized_at_ms BIGINT NOT NULL,
  UNIQUE KEY uq_offline_cash_link_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS pos_rewrite_offline_cash_events (
  id VARCHAR(36) PRIMARY KEY,
  receipt_id VARCHAR(36) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  actor_id VARCHAR(32) NOT NULL,
  request_id VARCHAR(128) NULL,
  details_json TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  KEY ix_offline_cash_event_receipt (receipt_id,created_at_ms,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS pos_rewrite_offline_cash_close_impacts (
  receipt_id VARCHAR(36) NOT NULL,
  close_id BIGINT NOT NULL,
  prior_status VARCHAR(16) NOT NULL,
  prior_reason VARCHAR(64) NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (receipt_id,close_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
