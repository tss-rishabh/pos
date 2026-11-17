-- Additive encrypted publisher demand queue. No legacy DDL or live execution.
CREATE TABLE pos_rewrite_origin_coupon_generation_demands (
 id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 version BIGINT UNSIGNED NOT NULL,
 phase VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 payload LONGTEXT NOT NULL,
 due_at_ms BIGINT NOT NULL,
 updated_at_ms BIGINT NOT NULL,
 KEY ix_origin_coupon_demand_due(phase,due_at_ms,id)
) ENGINE=InnoDB;
