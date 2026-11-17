-- API-v2 writer ONLY, review/apply separately. No automatic source DDL.
CREATE TABLE pos_ecommerce_full_sync_commands (
 id CHAR(36) COLLATE ascii_bin PRIMARY KEY,
 body_hash CHAR(64) COLLATE ascii_bin NOT NULL,
 store_id VARCHAR(20) COLLATE ascii_bin NOT NULL,
 actor_id VARCHAR(20) COLLATE ascii_bin NOT NULL,
 request_id VARCHAR(128) COLLATE ascii_bin NULL,
 state VARCHAR(16) COLLATE ascii_bin NOT NULL,
 proof JSON NULL,
 error_code VARCHAR(64) COLLATE ascii_bin NULL,
 worker_id CHAR(36) COLLATE ascii_bin NULL,
 lease_until BIGINT NULL,
 created_ms BIGINT NOT NULL,
 updated_ms BIGINT NOT NULL,
 attempt INT NOT NULL,
 INDEX ecommerce_full_sync_queue(state,created_ms,id)
) ENGINE=InnoDB;
CREATE TABLE pos_ecommerce_full_sync_registry (
 id VARCHAR(32) COLLATE ascii_bin PRIMARY KEY,
 active_id CHAR(36) COLLATE ascii_bin NULL
) ENGINE=InnoDB;
INSERT INTO pos_ecommerce_full_sync_registry(id,active_id) VALUES('catalog',NULL);
CREATE TABLE pos_ecommerce_full_sync_reconciliations (
 id CHAR(36) COLLATE ascii_bin PRIMARY KEY,
 operation_id CHAR(36) COLLATE ascii_bin NOT NULL,
 worker_id CHAR(36) COLLATE ascii_bin NULL,
 evidence_sha256 CHAR(64) COLLATE ascii_bin NOT NULL,
 created_ms BIGINT NOT NULL,
 INDEX ecommerce_full_sync_reconciliation(operation_id,created_ms)
) ENGINE=InnoDB;
