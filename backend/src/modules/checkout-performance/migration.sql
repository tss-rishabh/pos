-- Additive postpaid metadata receipts. Never changes source order/payment/stock schemas.
CREATE TABLE IF NOT EXISTS pos_rewrite_checkout_performance (
 operation_id VARCHAR(36) NOT NULL PRIMARY KEY,
 checkout_id VARCHAR(36) NOT NULL,
 checkout_operation_id VARCHAR(36) NOT NULL,
 checkout_version INT NOT NULL,
 order_id BIGINT NOT NULL,
 order_store_id BIGINT NOT NULL,
 operator_id VARCHAR(32) NOT NULL,
 customer_id BIGINT NOT NULL,
 store_id VARCHAR(32) NOT NULL,
 counter_id VARCHAR(32) NOT NULL,
 header_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 payment_id VARCHAR(36) NULL,
 performance_json VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 receipt JSON NOT NULL,
 request_id VARCHAR(128) NULL,
 recorded_at DATETIME(3) NOT NULL,
 UNIQUE KEY ux_checkout_performance_order(order_id),
 CONSTRAINT ck_checkout_performance_scope CHECK (order_id>0 AND order_store_id>0 AND customer_id>0 AND checkout_version>=0)
) ENGINE=InnoDB;
