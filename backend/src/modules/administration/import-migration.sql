-- Rewrite-owned inventory imports. Apply after administration/media/settings migrations.
INSERT IGNORE INTO pos_rewrite_administration_registries(resource) VALUES ('inventory-imports');
CREATE TABLE IF NOT EXISTS pos_rewrite_inventory_imports (
  sequence BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  id VARCHAR(36) NOT NULL,
  actor_id VARCHAR(32) NOT NULL,
  request_id VARCHAR(128) NULL,
  checksum VARCHAR(64) NOT NULL,
  name VARCHAR(120) NOT NULL,
  state VARCHAR(16) NOT NULL,
  error_code VARCHAR(64) NULL,
  total_rows INT NOT NULL,
  processed_rows INT NOT NULL,
  successful_rows INT NOT NULL,
  failed_rows INT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_rewrite_inventory_import_id(id),
  INDEX ix_rewrite_inventory_import_actor(actor_id,sequence),
  INDEX ix_rewrite_inventory_import_pending(state,sequence)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_inventory_import_rows (
  import_id VARCHAR(36) NOT NULL,
  record_number INT NOT NULL,
  cells JSON NOT NULL,
  command JSON NULL,
  state VARCHAR(16) NOT NULL,
  error_code VARCHAR(64) NULL,
  message VARCHAR(255) NULL,
  PRIMARY KEY(import_id,record_number),
  INDEX ix_rewrite_inventory_import_row_state(import_id,state,record_number)
) ENGINE=InnoDB;
