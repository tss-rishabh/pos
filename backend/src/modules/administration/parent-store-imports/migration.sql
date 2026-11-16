-- Additive rewrite queue profile; existing stock imports remain stock by default.
ALTER TABLE pos_rewrite_inventory_imports
  ADD COLUMN profile VARCHAR(24) NOT NULL DEFAULT 'stock' AFTER id,
  ADD INDEX ix_rewrite_inventory_import_profile_pending(profile,state,sequence);

CREATE TABLE pos_rewrite_parent_store_import_audits (
 import_id VARCHAR(36) NOT NULL,
 record_number INT NOT NULL,
 actor_id VARCHAR(32) NOT NULL,
 request_id VARCHAR(128) NULL,
 store_id VARCHAR(19) NOT NULL,
 parent_id VARCHAR(19) NOT NULL,
 before_json JSON NOT NULL,
 after_ids JSON NOT NULL,
 reset_ids JSON NOT NULL,
 created_at DATETIME(3) NOT NULL,
 PRIMARY KEY(import_id,record_number)
) ENGINE=InnoDB;
