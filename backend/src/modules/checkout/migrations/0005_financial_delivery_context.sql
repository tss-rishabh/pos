ALTER TABLE pos_rewrite_payment_outbox
 ADD COLUMN request_id VARCHAR(128) NULL,
 ADD COLUMN operator_id VARCHAR(32) NULL,
 ADD INDEX ix_payment_delivery_status_time(status,created_at,id);
ALTER TABLE pos_rewrite_return_outbox
 ADD COLUMN request_id VARCHAR(128) NULL,
 ADD COLUMN operator_id VARCHAR(32) NULL,
 ADD INDEX ix_return_delivery_status_time(status,created_at,id);
