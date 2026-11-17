-- Additive rewrite evidence only. Existing source/native financial DDL remains
-- a separately qualified deployment prerequisite; this performs no legacy ALTER.
CREATE TABLE IF NOT EXISTS pos_rewrite_public_screening_benefits (
 operation_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 order_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 data JSON NOT NULL,
 proof_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 UNIQUE KEY uq_public_screening_benefits_order(order_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_public_screening_benefit_preparations (
 operation_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 data JSON NOT NULL,
 proof_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_public_screening_benefit_cache (
 operation_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 data JSON NOT NULL,
 proof_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
) ENGINE=InnoDB;
