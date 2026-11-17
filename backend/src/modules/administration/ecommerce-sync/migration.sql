-- Rewrite checkpoint/audit tables only; existing settings outbox remains the only queue.
CREATE TABLE pos_rewrite_ecommerce_inventory_syncs (
 id VARCHAR(36) NOT NULL PRIMARY KEY,store_id BIGINT NOT NULL,actor_id VARCHAR(32) NOT NULL,request_id VARCHAR(128) NULL,
 policy_hash VARCHAR(64) NOT NULL,threshold INT NOT NULL,active INT NOT NULL,state VARCHAR(16) NOT NULL,full_state VARCHAR(16) NOT NULL,
 selected_rows INT NOT NULL,processed_rows INT NOT NULL,skipped_rows INT NOT NULL,error_code VARCHAR(64) NULL,full_result JSON NULL,
 created_at DATETIME(3) NOT NULL,updated_at DATETIME(3) NOT NULL,
 INDEX ix_rewrite_ecommerce_sync_store(store_id,created_at,id)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_ecommerce_inventory_sync_rows (
 sync_id VARCHAR(36) NOT NULL,association_id BIGINT NOT NULL,product_id BIGINT NOT NULL,selected_stock INT NOT NULL,current_stock INT NULL,state VARCHAR(16) NOT NULL,updated_at DATETIME(3) NOT NULL,
 PRIMARY KEY(sync_id,association_id),INDEX ix_rewrite_ecommerce_sync_pending(sync_id,state,product_id,association_id)
) ENGINE=InnoDB;
