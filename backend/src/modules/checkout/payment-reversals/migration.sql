-- Rewrite-only append-only payment compensation and cash movement evidence.
CREATE TABLE IF NOT EXISTS pos_rewrite_payment_reversals (
 id CHAR(36) PRIMARY KEY, order_id VARCHAR(32) NOT NULL, store_id VARCHAR(32) NOT NULL,
 counter_id VARCHAR(32) NOT NULL, operator_id VARCHAR(32) NOT NULL,
 original_payment_id CHAR(36) NOT NULL, cash_return_receipt_id CHAR(36) NOT NULL,
 request_hash CHAR(64) NOT NULL, receipt_hash CHAR(64) NOT NULL, receipt JSON NOT NULL,
 request_id VARCHAR(128) NULL, recorded_at DATETIME NOT NULL,
 UNIQUE KEY payment_reversal_original(original_payment_id),
 UNIQUE KEY payment_reversal_cash_return(cash_return_receipt_id),
 KEY payment_reversal_order(order_id,recorded_at,id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_payment_correction_orders (
 order_id VARCHAR(32) PRIMARY KEY, store_id VARCHAR(32) NOT NULL, counter_id VARCHAR(32) NOT NULL,
 order_date DATE NOT NULL, first_payment_id CHAR(36) NOT NULL, input_hash CHAR(64) NOT NULL,
 KEY payment_correction_order_day(store_id,order_date,order_id)
) ENGINE=InnoDB;
ALTER TABLE pos_rewrite_payment_outbox ADD INDEX ix_payment_outbox_order_state(order_id,kind,status,id);
CREATE TABLE IF NOT EXISTS pos_rewrite_payment_correction_cash (
 id VARCHAR(80) PRIMARY KEY, order_id VARCHAR(32) NOT NULL, store_id VARCHAR(32) NOT NULL,
 counter_id VARCHAR(32) NOT NULL, operator_id VARCHAR(32) NOT NULL,
 direction VARCHAR(3) NOT NULL, amount DECIMAL(12,2) NOT NULL, business_date DATE NOT NULL,
 source_id CHAR(36) NOT NULL, input_hash CHAR(64) NOT NULL, recorded_at DATETIME NOT NULL,
 UNIQUE KEY payment_correction_source(source_id,direction),
 KEY payment_correction_date(store_id,business_date,id), KEY payment_correction_order(order_id,id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_payment_correction_close_impacts (
 id VARCHAR(100) PRIMARY KEY, source_id CHAR(36) NOT NULL, store_id VARCHAR(32) NOT NULL,
 business_date DATE NOT NULL, close_id VARCHAR(32) NOT NULL, close_version VARCHAR(16) NOT NULL,
 recorded_at DATETIME NOT NULL
) ENGINE=InnoDB;
