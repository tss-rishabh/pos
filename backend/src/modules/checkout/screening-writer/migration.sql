-- Rewrite-owned journals. Source creation/effect/completion tables are the
-- separately reviewed existing public-screening-writer schema prerequisite.
CREATE TABLE IF NOT EXISTS pos_rewrite_public_screening_work (
  operation_id VARCHAR(36) NOT NULL PRIMARY KEY,
  checkout_id VARCHAR(36) NOT NULL,
  actor_id VARCHAR(32) NOT NULL,
  store_id VARCHAR(32) NOT NULL,
  data JSON NOT NULL,
  proof_hash VARCHAR(64) NOT NULL,
  status VARCHAR(24) NOT NULL,
  next_check_at_ms BIGINT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  KEY ix_public_screening_work_due(status,next_check_at_ms,operation_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS pos_rewrite_public_screening_payment_evidence (
  id VARCHAR(80) NOT NULL PRIMARY KEY,
  operation_id VARCHAR(36) NOT NULL,
  order_id VARCHAR(32) NOT NULL,
  intent JSON NOT NULL,
  intent_hash VARCHAR(64) NOT NULL,
  paid JSON NULL,
  paid_hash VARCHAR(64) NULL,
  KEY ix_public_screening_payment_order(order_id,id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS pos_rewrite_public_screening_publication_dispatches (
  operation_id VARCHAR(36) NOT NULL PRIMARY KEY,
  data JSON NOT NULL,
  proof_hash VARCHAR(64) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS pos_rewrite_public_screening_submission_dispatches (
  operation_id VARCHAR(36) NOT NULL PRIMARY KEY,
  data JSON NOT NULL,
  proof_hash VARCHAR(64) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS pos_rewrite_public_screening_publication_replies (
  operation_id VARCHAR(36) NOT NULL PRIMARY KEY,
  data JSON NOT NULL,
  proof_hash VARCHAR(64) NOT NULL
) ENGINE=InnoDB;
