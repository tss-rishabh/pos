-- Review-only, after screening-origins/origin-coupon-migration.sql and the
-- immutable original other-writer-origins/go/migration.review.sql. No DDL runs
-- from the receiver or worker. This records actual source/Go coupon effects.
CREATE TABLE pos_rewrite_screening_origin_coupon_consumptions (
 command_id VARCHAR(36) NOT NULL,
 action VARCHAR(8) NOT NULL,
 order_id BIGINT NOT NULL,
 data JSON NOT NULL,
 proof_hash VARCHAR(64) NOT NULL,
 PRIMARY KEY(command_id,action),
 UNIQUE KEY uq_screening_origin_coupon_action(order_id,action)
) ENGINE=InnoDB;
