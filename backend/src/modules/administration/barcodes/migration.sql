-- Rewrite-owned coordination and receipts only. No legacy GS1 uniqueness DDL.
CREATE TABLE IF NOT EXISTS pos_rewrite_catalog_locks (
  id VARCHAR(64) NOT NULL PRIMARY KEY
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS pos_rewrite_barcode_assignments (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  actor_id VARCHAR(32) NOT NULL,
  input_hash VARCHAR(64) NOT NULL,
  product_id VARCHAR(19) NOT NULL,
  barcode VARCHAR(19) NOT NULL,
  result JSON NOT NULL,
  created_at DATETIME NOT NULL,
  INDEX barcode_assignment_actor_created(actor_id,created_at)
) ENGINE=InnoDB;
