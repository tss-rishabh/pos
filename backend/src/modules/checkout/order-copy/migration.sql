CREATE TABLE pos_rewrite_order_copy_reviews (
 id VARCHAR(36) NOT NULL PRIMARY KEY,
 checkout_id VARCHAR(36) NOT NULL,
 operator_id VARCHAR(32) NOT NULL,
 data JSON NOT NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 INDEX ix_order_copy_review_scope(checkout_id,operator_id,created_at,id)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_order_copy_commands (
 id VARCHAR(36) NOT NULL PRIMARY KEY,
 review_id VARCHAR(36) NOT NULL,
 checkout_id VARCHAR(36) NOT NULL,
 operator_id VARCHAR(32) NOT NULL,
 data JSON NOT NULL,
 updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 UNIQUE KEY ux_order_copy_review(review_id),
 INDEX ix_order_copy_command_scope(checkout_id,operator_id,updated_at,id)
) ENGINE=InnoDB;
