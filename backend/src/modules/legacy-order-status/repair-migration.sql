-- Additive durable obligation; original return outcome and financial ledgers are retained.
CREATE TABLE IF NOT EXISTS pos_rewrite_return_repair_obligations (
 return_id VARCHAR(36) NOT NULL PRIMARY KEY,
 command_id VARCHAR(36) NOT NULL UNIQUE,
 operator_id VARCHAR(32) NOT NULL,
 auth_version VARCHAR(64) NOT NULL,
 role INT NOT NULL,
 user_type INT NOT NULL,
 store_id VARCHAR(32) NOT NULL,
 order_id VARCHAR(32) NOT NULL,
 counter_id VARCHAR(32) NOT NULL,
 rejection_hash VARCHAR(64) NOT NULL,
 request_id VARCHAR(128) NULL,
 state VARCHAR(16) NOT NULL,
 error_code VARCHAR(64) NULL,
 version INT UNSIGNED NOT NULL,
 recovery_actor_id VARCHAR(32) NULL,
 recovery_auth_version VARCHAR(64) NULL,
 created_at_ms BIGINT UNSIGNED NOT NULL,
 updated_at_ms BIGINT UNSIGNED NOT NULL,
 INDEX ix_return_repair_pending(state,created_at_ms),
 INDEX ix_return_repair_scope(store_id,order_id,created_at_ms)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_return_repair_recoveries (
 id VARCHAR(36) NOT NULL PRIMARY KEY,
 return_id VARCHAR(36) NOT NULL,
 actor_id VARCHAR(32) NOT NULL,
 expected_version INT UNSIGNED NOT NULL,
 created_at_ms BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB;
