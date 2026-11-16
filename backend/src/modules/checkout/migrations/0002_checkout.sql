-- Apply only to the writer after review. Never execute against the supplied live reader.
CREATE TABLE pos_rewrite_checkout_sessions (
 id VARCHAR(36) NOT NULL PRIMARY KEY,
 operator_id VARCHAR(32) NOT NULL,
 store_id VARCHAR(32) NOT NULL,
 version INT NOT NULL,
 state JSON NOT NULL,
 updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 INDEX ix_checkout_operator_store(operator_id,store_id)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_customer_cart_leases (
 customer_id VARCHAR(32) NOT NULL PRIMARY KEY,
 checkout_id VARCHAR(36) NOT NULL,
 expires_at_ms BIGINT NOT NULL
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_gift_card_leases (
 serial VARCHAR(32) NOT NULL PRIMARY KEY,
 checkout_id VARCHAR(36) NOT NULL,
 expires_at_ms BIGINT NOT NULL
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_checkout_operations (
 checkout_id VARCHAR(36) NOT NULL,
 id VARCHAR(36) NOT NULL,
 status VARCHAR(16) NOT NULL,
 request_hash VARCHAR(64) NOT NULL,
 result JSON NULL,
 error_code VARCHAR(64) NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 PRIMARY KEY(checkout_id,id)
) ENGINE=InnoDB;
