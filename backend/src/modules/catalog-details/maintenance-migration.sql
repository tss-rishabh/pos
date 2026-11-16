-- Rewrite-owned maintenance ledger only. Never apply this file to a reader.
CREATE TABLE IF NOT EXISTS pos_rewrite_catalog_commands (
 id VARCHAR(36) NOT NULL PRIMARY KEY,
 kind ENUM('inventory-pull','product-troubleshoot') NOT NULL,
 owner_id VARCHAR(32) NOT NULL,
 request_id VARCHAR(128) NOT NULL,
 input_hash VARCHAR(64) NOT NULL,
 state ENUM('PENDING','RUNNING','SUCCEEDED','UNCERTAIN','FAILED') NOT NULL,
 metadata JSON NOT NULL,
 local_applied BOOLEAN NOT NULL,
 created_at DATETIME(3) NOT NULL,
 updated_at DATETIME(3) NOT NULL,
 error_code VARCHAR(64) NULL,
 INDEX ix_catalog_commands_owner_state(owner_id,state,created_at),
 INDEX ix_catalog_commands_state_created(state,created_at,id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_catalog_deliveries (
 id VARCHAR(36) NOT NULL PRIMARY KEY,
 command_id VARCHAR(36) NOT NULL,
 ordinal INT NOT NULL,
 target_identity VARCHAR(64) NOT NULL,
 payload JSON NOT NULL,
 state ENUM('PENDING','SENDING','DELIVERED','UNCERTAIN','FAILED') NOT NULL,
 lease_until DATETIME(3) NULL,
 lease_token VARCHAR(36) NULL,
 updated_at DATETIME(3) NOT NULL,
 error_code VARCHAR(64) NULL,
 reconciliation_id VARCHAR(36) NULL,
 reconciliation_outcome ENUM('delivered','not-delivered') NULL,
 reconciled_by VARCHAR(32) NULL,
 UNIQUE KEY uq_catalog_delivery_ordinal(command_id,ordinal),
 INDEX ix_catalog_deliveries_lease(state,lease_until),
 INDEX ix_catalog_deliveries_command(command_id,state)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_catalog_locks (
 id VARCHAR(64) NOT NULL PRIMARY KEY
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_catalog_reconciliations (
 id VARCHAR(36) NOT NULL PRIMARY KEY,
 command_id VARCHAR(36) NOT NULL,
 delivery_id VARCHAR(36) NOT NULL,
 outcome ENUM('delivered','not-delivered') NOT NULL,
 actor_id VARCHAR(32) NOT NULL,
 request_id VARCHAR(128) NOT NULL,
 created_at DATETIME(3) NOT NULL,
 INDEX ix_catalog_reconciliations_delivery(delivery_id,created_at)
) ENGINE=InnoDB;
