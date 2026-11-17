-- Additive rewrite-owned encrypted publisher journal; no legacy DDL.
CREATE TABLE pos_rewrite_screening_counter_generation_jobs (
 id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 version BIGINT UNSIGNED NOT NULL,
 phase VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 payload LONGTEXT NOT NULL,
 updated_at_ms BIGINT NOT NULL,
 KEY ix_screening_counter_generation_phase(phase,updated_at_ms,id)
) ENGINE=InnoDB;
