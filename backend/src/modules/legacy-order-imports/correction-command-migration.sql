-- Separate additive migration: immutable correction-command control outcomes.
-- FENCED means no successor was queued for this UUID, not that the original
-- source import was effect-free. Original source proof is still mandatory.
CREATE TABLE pos_rewrite_import_correction_commands (
 id VARCHAR(36) COLLATE ascii_bin PRIMARY KEY,
 original_job_id VARCHAR(36) COLLATE ascii_bin NOT NULL,
 original_operation_id VARCHAR(36) COLLATE ascii_bin NOT NULL,
 manager_id VARCHAR(32) COLLATE ascii_bin NOT NULL,
 upload_hash VARCHAR(64) COLLATE ascii_bin NOT NULL,
 plan_hash VARCHAR(64) COLLATE ascii_bin NOT NULL,
 group_hash VARCHAR(64) COLLATE ascii_bin NOT NULL,
 reservation_token VARCHAR(36) COLLATE ascii_bin NOT NULL,
 state VARCHAR(16) COLLATE ascii_bin NOT NULL,
 outcome JSON NULL,proof_hash VARCHAR(64) COLLATE ascii_bin NULL,
 request_id VARCHAR(128) COLLATE ascii_bin NOT NULL,created_at_ms BIGINT NOT NULL,
 KEY ix_import_correction_command_scope(original_job_id,original_operation_id,created_at_ms,id)
) ENGINE=InnoDB;
