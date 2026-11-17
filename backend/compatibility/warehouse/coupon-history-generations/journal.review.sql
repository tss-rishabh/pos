-- REVIEW ONLY rewrite-owned MySQL migration, not invoked by any constructor.
-- Root owns migration registry/numbering and application deployment.
CREATE TABLE pos_rewrite_coupon_generation_journal (
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  version BIGINT UNSIGNED NOT NULL,
  phase VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload LONGTEXT NOT NULL,
  proof VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  KEY ix_coupon_generation_pending(phase,updated_at_ms,id)
) ENGINE=InnoDB;
