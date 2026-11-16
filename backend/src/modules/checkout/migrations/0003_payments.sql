CREATE TABLE pos_rewrite_payment_attempts (
 id VARCHAR(36) NOT NULL PRIMARY KEY,
 order_id VARCHAR(32) NOT NULL,
 store_id VARCHAR(32) NOT NULL,
 operator_id VARCHAR(32) NOT NULL,
 status VARCHAR(16) NOT NULL,
 state JSON NOT NULL,
 created_at DATETIME NOT NULL,
 updated_at DATETIME NOT NULL,
 INDEX ix_payment_order_status(order_id,status)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_payment_outbox (
 id VARCHAR(80) NOT NULL PRIMARY KEY,
 kind VARCHAR(32) NOT NULL,
 order_id VARCHAR(32) NOT NULL,
 store_id VARCHAR(32) NOT NULL,
 status VARCHAR(16) NOT NULL,
 created_at DATETIME NOT NULL
) ENGINE=InnoDB;
