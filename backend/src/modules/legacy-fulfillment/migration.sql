CREATE TABLE IF NOT EXISTS pos_rewrite_legacy_fulfillment_commands (
 command_id VARCHAR(36) NOT NULL PRIMARY KEY,
 actor_id VARCHAR(20) NOT NULL,
 store_id VARCHAR(20) NOT NULL,
 order_id VARCHAR(20) NOT NULL,
 action VARCHAR(20) NOT NULL,
 request_hash VARCHAR(64) NOT NULL,
 result_json JSON NULL,
 request_id VARCHAR(128) NOT NULL,
 created_at_ms BIGINT UNSIGNED NOT NULL,
 KEY idx_legacy_command_scope(store_id,order_id,created_at_ms)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS pos_rewrite_legacy_rto_receipts (
 order_id BIGINT NOT NULL PRIMARY KEY,
 store_id BIGINT NOT NULL,
 command_id VARCHAR(36) NOT NULL,
 receipt_json JSON NOT NULL,
 created_at_ms BIGINT UNSIGNED NOT NULL,
 UNIQUE KEY uq_legacy_rto_command(command_id)
) ENGINE=InnoDB;
