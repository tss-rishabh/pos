CREATE TABLE IF NOT EXISTS pos_rewrite_local_delivery_orders (
 order_id BIGINT NOT NULL PRIMARY KEY,
 state_json JSON NOT NULL,
 version INT NOT NULL,
 updated_at_ms BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_local_delivery_commands (
 command_id VARCHAR(36) NOT NULL PRIMARY KEY,
 phase VARCHAR(24) NOT NULL,
 state_json JSON NOT NULL,
 snapshot_json JSON NOT NULL,
 input_json JSON NOT NULL,
 stage VARCHAR(32) NOT NULL,
 KEY idx_local_delivery_command_phase(phase,command_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_local_delivery_calls (
 call_id VARCHAR(36) NOT NULL PRIMARY KEY,
 command_id VARCHAR(36) NOT NULL,
 sequence_no INT NOT NULL,
 attempts INT NOT NULL,
 request_json JSON NOT NULL,
 request_hash VARCHAR(64) NOT NULL,
 status VARCHAR(24) NOT NULL,
 created_at_ms BIGINT UNSIGNED NOT NULL,
 result_json JSON NULL,
 claimed_at_ms BIGINT UNSIGNED NULL,
 completed_at_ms BIGINT UNSIGNED NULL,
 UNIQUE KEY uq_local_delivery_call_sequence(command_id,sequence_no),
 KEY idx_local_delivery_call_dispatch(status,created_at_ms,command_id,sequence_no)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_local_delivery_jobs (
 job_id VARCHAR(36) NOT NULL PRIMARY KEY,
 command_id VARCHAR(36) NOT NULL,
 request_id VARCHAR(128) NOT NULL,
 order_id BIGINT NOT NULL,
 store_id BIGINT NOT NULL,
 kind VARCHAR(32) NOT NULL,
 status VARCHAR(24) NOT NULL,
 due_at_ms BIGINT UNSIGNED NOT NULL,
 claimed_at_ms BIGINT UNSIGNED NULL,
 result_json JSON NULL,
 KEY idx_local_delivery_job_due(status,due_at_ms),
 KEY idx_local_delivery_job_order(order_id,status)
) ENGINE=InnoDB;
