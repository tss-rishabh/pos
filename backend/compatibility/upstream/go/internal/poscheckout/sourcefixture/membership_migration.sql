CREATE TABLE pos_rewrite_membership_versions (
  customer_id BIGINT NOT NULL PRIMARY KEY,
  revision BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_cancellation_membership_provenance (
  order_id BIGINT NOT NULL PRIMARY KEY,
  customer_id BIGINT NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  header_hash VARCHAR(64) NOT NULL,
  before_state JSON NOT NULL,
  confirmed_state JSON NOT NULL,
  proof_hash VARCHAR(64) NOT NULL,
  contract_version VARCHAR(60) NOT NULL,
  operation_id VARCHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  KEY ix_cancel_membership_customer (customer_id,revision)
) ENGINE=InnoDB;
-- Original entity identity remains a keyed digest, never a retained email.
-- Old abstract proofs remain NULL and cannot qualify as activated v2 evidence.
ALTER TABLE pos_rewrite_cancellation_membership_provenance
  ADD COLUMN entity_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL;
