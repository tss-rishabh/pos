CREATE TABLE pos_rewrite_customer_registrations (
 id VARCHAR(36) NOT NULL PRIMARY KEY,
 checkout_id VARCHAR(36) NOT NULL,
 operator_id VARCHAR(32) NOT NULL,
 store_id VARCHAR(32) NOT NULL,
 counter_id VARCHAR(32) NOT NULL,
 request_hash VARCHAR(64) NOT NULL,
 phone_hash VARCHAR(64) NOT NULL,
 email_hash VARCHAR(64) NOT NULL,
 encrypted_input TEXT NOT NULL,
 code_hash VARCHAR(64) NOT NULL,
 status VARCHAR(16) NOT NULL,
 verification_attempts INT NOT NULL,
 expires_at_ms BIGINT NOT NULL,
 verified_at_ms BIGINT NULL,
 customer_id VARCHAR(32) NULL,
 created_at_ms BIGINT NOT NULL,
 updated_at_ms BIGINT NOT NULL,
 INDEX ix_customer_registration_checkout(checkout_id,created_at_ms)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_customer_registration_claims (
 claim_key VARCHAR(70) NOT NULL PRIMARY KEY,
 registration_id VARCHAR(36) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_customer_registration_limits (
 limit_key VARCHAR(96) NOT NULL PRIMARY KEY,
 last_sent_at_ms BIGINT NOT NULL,
 send_window_at_ms BIGINT NOT NULL,
 send_count INT NOT NULL,
 failure_window_at_ms BIGINT NOT NULL,
 verification_failures INT NOT NULL
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_customer_registration_deliveries (
 id VARCHAR(48) NOT NULL PRIMARY KEY,
 registration_id VARCHAR(36) NOT NULL,
 channel VARCHAR(12) NOT NULL,
 status VARCHAR(16) NOT NULL,
 available_at_ms BIGINT NOT NULL,
 request_id VARCHAR(128) NULL,
 operator_id VARCHAR(32) NOT NULL,
 created_at_ms BIGINT NOT NULL,
 updated_at_ms BIGINT NOT NULL,
 INDEX ix_customer_registration_delivery_poll(status,available_at_ms,id),
 INDEX ix_customer_registration_delivery(registration_id,created_at_ms,id)
) ENGINE=InnoDB;
