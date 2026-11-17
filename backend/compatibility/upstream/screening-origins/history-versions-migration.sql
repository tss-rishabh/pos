CREATE TABLE IF NOT EXISTS pos_rewrite_screening_origin_history_versions (
 id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 command_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 data JSON NOT NULL,
 proof_hash VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 created_at_ms BIGINT NOT NULL,
 KEY ix_screening_origin_history_versions(command_id,created_at_ms,id)
) ENGINE=InnoDB;
