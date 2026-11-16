CREATE TABLE IF NOT EXISTS pos_rewrite_customer_otp_challenges (
 id VARCHAR(36) NOT NULL PRIMARY KEY,
 operator_id VARCHAR(32) NOT NULL,
 store_id VARCHAR(32) NOT NULL,
 customer_id VARCHAR(32) NOT NULL,
 scope JSON NOT NULL,
 contact JSON NOT NULL,
 scope_hash VARCHAR(64) NOT NULL,
 active_scope_hash VARCHAR(64) NULL,
 request_hash VARCHAR(64) NOT NULL,
 actor_version VARCHAR(64) NOT NULL,
 state VARCHAR(16) NOT NULL,
 code_hash VARCHAR(64) NOT NULL,
 budget_keys JSON NOT NULL,
 attempts INT NOT NULL DEFAULT 0,
 expires_at_ms BIGINT NOT NULL,
 proof_expires_at_ms BIGINT NOT NULL,
 verified_until_ms BIGINT NULL,
 request_id VARCHAR(128) NULL,
 created_at_ms BIGINT NOT NULL,
 updated_at_ms BIGINT NOT NULL,
 UNIQUE KEY uq_customer_otp_active_scope(active_scope_hash),
 KEY ix_customer_otp_customer_created(customer_id,created_at_ms),
 KEY ix_customer_otp_expiry(state,expires_at_ms,id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_customer_otp_budgets (
 budget_key VARCHAR(96) NOT NULL PRIMARY KEY,
 business_day VARCHAR(10) NOT NULL,
 sends INT NOT NULL,
 failures INT NOT NULL,
 window_failures INT NOT NULL,
 window_reset_at_ms BIGINT NOT NULL,
 last_sent_at_ms BIGINT NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_customer_otp_deliveries (
 id VARCHAR(36) NOT NULL PRIMARY KEY,
 challenge_id VARCHAR(36) NOT NULL,
 channel VARCHAR(8) NOT NULL,
 available_at_ms BIGINT NOT NULL,
 state VARCHAR(16) NOT NULL,
 encrypted_payload TEXT NOT NULL,
 lease_token VARCHAR(36) NULL,
 lease_expires_at_ms BIGINT NULL,
 created_at_ms BIGINT NOT NULL,
 updated_at_ms BIGINT NOT NULL,
 UNIQUE KEY uq_customer_otp_delivery_channel(challenge_id,channel),
 KEY ix_customer_otp_delivery_poll(state,available_at_ms,id),
 KEY ix_customer_otp_delivery_lease(state,lease_expires_at_ms,id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_customer_otp_operations (
 id VARCHAR(36) NOT NULL PRIMARY KEY,
 challenge_id VARCHAR(36) NOT NULL,
 kind VARCHAR(16) NOT NULL,
 request_hash VARCHAR(64) NOT NULL,
 outcome JSON NOT NULL,
 created_at_ms BIGINT NOT NULL,
 KEY ix_customer_otp_operation_challenge(challenge_id,created_at_ms)
) ENGINE=InnoDB;
