CREATE TABLE IF NOT EXISTS pos_rewrite_import_membership_references (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  operation_id VARCHAR(36) NOT NULL,
  order_id VARCHAR(32) NOT NULL,
  grant_id VARCHAR(36) NOT NULL,
  data JSON NOT NULL,
  created_at_ms BIGINT NOT NULL,
  UNIQUE KEY uq_import_membership_reference_grant(operation_id,grant_id),
  KEY ix_import_membership_reference_order(order_id,created_at_ms,id)
) ENGINE=InnoDB;

-- Rewrite-owned contact evidence only. No legacy table, EAV or expiry changes.
-- The customer is already held by the financial profile. These immutable
-- receipt reads take no row/range locks against the contact delivery worker.
CREATE INDEX ix_contact_membership_reference
  ON pos_rewrite_customer_contact_challenges(customer_id,kind,status,created_at_ms,id);
