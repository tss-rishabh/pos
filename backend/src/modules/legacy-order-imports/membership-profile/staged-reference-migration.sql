CREATE TABLE IF NOT EXISTS pos_rewrite_import_membership_staged_references (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  operation_id VARCHAR(36) NOT NULL,
  order_id VARCHAR(32) NOT NULL,
  grant_id VARCHAR(36) NOT NULL,
  data JSON NOT NULL,
  created_at_ms BIGINT NOT NULL,
  UNIQUE KEY uq_import_member_staged_reference_grant(operation_id,grant_id),
  KEY ix_import_member_staged_reference_order(order_id,created_at_ms,id)
) ENGINE=InnoDB;
