-- Additive rewrite-only tables. No legacy-table or grant/trigger installation.
CREATE TABLE pos_rewrite_screening_origin_coupons (
 command_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 order_id BIGINT NOT NULL,
 data JSON NOT NULL,
 proof_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 UNIQUE KEY uq_origin_coupon_order(order_id)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_screening_origin_coupon_preparations (
 id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 command_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 data JSON NOT NULL,
 proof_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 created_at_ms BIGINT NOT NULL,
 KEY ix_origin_coupon_preparations(command_id,created_at_ms,id)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_screening_origin_coupon_active (
 command_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 preparation_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 data JSON NOT NULL,
 proof_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_screening_origin_birthday_claims (
 command_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 claim_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 receipt JSON NOT NULL,
 proof_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
) ENGINE=InnoDB;
