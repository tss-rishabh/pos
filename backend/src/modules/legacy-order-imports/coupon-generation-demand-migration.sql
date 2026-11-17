-- Encrypted background demand from authenticated source previews. No customer
-- IDs, source witnesses or request values are stored in plaintext indexes.
CREATE TABLE pos_rewrite_coupon_generation_demands (
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  version BIGINT UNSIGNED NOT NULL,
  phase VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload LONGTEXT NOT NULL,
  proof VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  due_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  KEY ix_coupon_generation_demand_due(phase,due_at_ms,id)
) ENGINE=InnoDB;
