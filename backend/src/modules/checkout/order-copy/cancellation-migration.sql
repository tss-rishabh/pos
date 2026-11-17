-- New rewrite-only immutable unsent fences. Existing command UUID slots are
-- retained/claimed too, so an older decoder fails closed instead of dispatching.
CREATE TABLE pos_rewrite_order_copy_cancellations (
 copy_id VARCHAR(36) NOT NULL PRIMARY KEY,
 cancellation_id VARCHAR(36) NOT NULL,
 checkout_id VARCHAR(36) NOT NULL,
 operator_id VARCHAR(32) NOT NULL,
 request_hash VARCHAR(64) NOT NULL,
 receipt_hash VARCHAR(64) NOT NULL,
 receipt JSON NOT NULL,
 original_command JSON NULL,
 UNIQUE KEY ux_order_copy_cancellation(cancellation_id)
) ENGINE=InnoDB;
