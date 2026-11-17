CREATE TABLE IF NOT EXISTS pos_rewrite_origin_history_generation_jobs (
 id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 version BIGINT UNSIGNED NOT NULL,
 phase VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 payload LONGTEXT NOT NULL,
 updated_at_ms BIGINT NOT NULL,
 lease_token VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
 lease_until_ms BIGINT NULL,
 KEY ix_origin_history_jobs_pending(phase,updated_at_ms,id)
) ENGINE=InnoDB;
