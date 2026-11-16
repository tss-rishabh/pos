-- Upstream-only postcommit delivery queue. Apply with the controlled migration
-- role after reviewing the actual deployed payment-service revision.
CREATE TABLE pos_rewrite_checkout_projection_effects (
 id VARCHAR(96) NOT NULL PRIMARY KEY,
 order_id BIGINT NOT NULL,
 user_id BIGINT NOT NULL,
 operator_id BIGINT NULL,
 resource VARCHAR(48) NOT NULL,
 payload JSON NOT NULL,
 status VARCHAR(16) NOT NULL,
 request_id VARCHAR(128) NULL,
 created_at DATETIME NOT NULL,
 updated_at DATETIME NOT NULL,
 INDEX ix_checkout_effect_poll(status,created_at,id)
) ENGINE=InnoDB;
