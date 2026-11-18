-- An immutable local receipt for a metadata-only exchange recovery command.
-- Never stores customer details, comments, provider requests or credentials.
CREATE TABLE IF NOT EXISTS pos_rewrite_exchange_recovery_claims (
  id VARCHAR(36) PRIMARY KEY,
  operator_id VARCHAR(32) NOT NULL,
  store_id VARCHAR(32) NOT NULL,
  order_id VARCHAR(32) NOT NULL,
  line_id VARCHAR(32) NOT NULL,
  counter_id VARCHAR(32) NOT NULL,
  verification_id VARCHAR(36) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  revision VARCHAR(64) NOT NULL,
  operation_id VARCHAR(36) NOT NULL,
  recorded_at DATETIME NOT NULL,
  INDEX ix_exchange_recovery_claim_line (store_id, order_id, line_id, id)
) ENGINE=InnoDB;
