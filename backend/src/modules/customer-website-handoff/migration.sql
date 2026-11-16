CREATE TABLE IF NOT EXISTS pos_rewrite_customer_website_handoffs (
 id CHAR(36) NOT NULL PRIMARY KEY,operation_id CHAR(36) NOT NULL,checkout_id CHAR(36) NOT NULL,checkout_version INT NOT NULL,
 operator_id VARCHAR(32) NOT NULL,operator_customer_id VARCHAR(32) NOT NULL,customer_id VARCHAR(32) NOT NULL,store_id VARCHAR(32) NOT NULL,counter_id VARCHAR(32) NOT NULL,
 operator_session_id CHAR(36) NOT NULL,challenge_id CHAR(36) NOT NULL,verified_until_ms BIGINT UNSIGNED NOT NULL,
 authority_hash CHAR(64) NOT NULL,configuration_hash CHAR(64) NOT NULL,token_digest CHAR(64) NOT NULL,state VARCHAR(16) NOT NULL,
 expires_at_ms BIGINT UNSIGNED NOT NULL,session_expires_at_ms BIGINT UNSIGNED NOT NULL,created_at_ms BIGINT UNSIGNED NOT NULL,updated_at_ms BIGINT UNSIGNED NOT NULL,
 consumed_operation_id CHAR(36) NULL,browser_binding_digest CHAR(64) NULL,consumed_at_ms BIGINT UNSIGNED NULL,request_id VARCHAR(128) NULL,consumed_request_id VARCHAR(128) NULL,
 UNIQUE KEY uq_customer_website_handoff_operation(operation_id),UNIQUE KEY uq_customer_website_handoff_token(token_digest),UNIQUE KEY uq_customer_website_handoff_consumption(consumed_operation_id),
 KEY ix_customer_website_handoff_checkout(checkout_id,state,expires_at_ms),KEY ix_customer_website_handoff_expiry(expires_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
