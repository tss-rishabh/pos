CREATE TABLE pos_rewrite_import_screening_reservations (
 operation_id VARCHAR(36) NOT NULL PRIMARY KEY,
 customer_id VARCHAR(32) NOT NULL,
 sku VARCHAR(32) NOT NULL,
 order_id VARCHAR(32) NULL,
 data JSON NOT NULL,
 proof_hash VARCHAR(64) NOT NULL,
 INDEX ix_import_screening_customer(customer_id,sku),
 UNIQUE KEY uq_import_screening_order(order_id)
) ENGINE=InnoDB;
