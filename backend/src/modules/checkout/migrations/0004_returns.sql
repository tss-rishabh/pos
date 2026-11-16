CREATE TABLE pos_rewrite_return_operations (
 id VARCHAR(36) NOT NULL PRIMARY KEY,
 line_id VARCHAR(32) NOT NULL,
 store_id VARCHAR(32) NOT NULL,
 phase VARCHAR(32) NOT NULL,
 state JSON NOT NULL,
 created_at DATETIME NOT NULL,
 updated_at DATETIME NOT NULL,
 INDEX ix_return_line_phase(line_id,phase)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_return_outbox (
 id VARCHAR(36) NOT NULL PRIMARY KEY,
 kind VARCHAR(32) NOT NULL,
 order_id VARCHAR(32) NOT NULL,
 store_id VARCHAR(32) NOT NULL,
 product_id VARCHAR(32) NOT NULL,
 line_id VARCHAR(32) NOT NULL,
 status VARCHAR(16) NOT NULL,
 created_at DATETIME NOT NULL
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_return_verifications (
 id VARCHAR(36) NOT NULL PRIMARY KEY,
 state JSON NOT NULL
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_return_verification_limits (
 customer_id VARCHAR(32) NOT NULL PRIMARY KEY,
 state JSON NOT NULL,
 updated_at_ms BIGINT NOT NULL
) ENGINE=InnoDB;
