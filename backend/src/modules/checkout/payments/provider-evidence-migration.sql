CREATE TABLE IF NOT EXISTS pos_rewrite_payment_provider_facts (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  attempt_id VARCHAR(36) NOT NULL,
  order_id VARCHAR(32) NOT NULL,
  data JSON NOT NULL,
  proof_hash VARCHAR(64) NOT NULL,
  created_at_ms BIGINT NOT NULL,
  KEY ix_payment_provider_fact_attempt(attempt_id,created_at_ms,id)
) ENGINE=InnoDB;
