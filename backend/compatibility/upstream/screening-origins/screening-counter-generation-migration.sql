-- Additive rewrite-owned encrypted publisher journal; no legacy DDL.
CREATE TABLE pos_rewrite_screening_counter_generation_jobs (
 id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 version BIGINT UNSIGNED NOT NULL,
 phase VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 payload LONGTEXT NOT NULL,
 updated_at_ms BIGINT NOT NULL,
 KEY ix_screening_counter_generation_phase(phase,updated_at_ms,id)
) ENGINE=InnoDB;

-- Generic customer demands and atomic per-lane discovery cursors. No source
-- authority or historical facts are minted by admission.
CREATE TABLE pos_rewrite_screening_counter_generation_demands (
 id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 version BIGINT UNSIGNED NOT NULL,
 phase VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 lane VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 payload LONGTEXT NOT NULL,
 due_at_ms BIGINT NOT NULL,
 created_at_ms BIGINT NOT NULL,
 updated_at_ms BIGINT NOT NULL,
 KEY ix_screening_counter_demand_due(phase,due_at_ms,created_at_ms),
 KEY ix_screening_counter_demand_new(lane,created_at_ms)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_screening_counter_generation_cursors (
 lane VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 version BIGINT UNSIGNED NOT NULL,
 payload LONGTEXT NOT NULL,
 updated_at_ms BIGINT NOT NULL
) ENGINE=InnoDB;
