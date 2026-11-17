-- Rewrite-only immutable manager review; no legacy financial/header mutation.
CREATE TABLE pos_rewrite_import_corrections (
 id VARCHAR(36) COLLATE ascii_bin PRIMARY KEY,
 original_job_id VARCHAR(36) COLLATE ascii_bin NOT NULL,
 original_operation_id VARCHAR(36) COLLATE ascii_bin NOT NULL,
 successor_job_id VARCHAR(36) COLLATE ascii_bin NOT NULL,
 successor_operation_id VARCHAR(36) COLLATE ascii_bin NOT NULL,
 manager_id VARCHAR(32) COLLATE ascii_bin NOT NULL,
 request_hash VARCHAR(64) COLLATE ascii_bin NOT NULL,
 plan_hash VARCHAR(64) COLLATE ascii_bin NOT NULL,
 body JSON NOT NULL,receipt JSON NOT NULL,
 proof_hash VARCHAR(64) COLLATE ascii_bin NOT NULL,
 request_id VARCHAR(128) COLLATE ascii_bin NOT NULL,
 created_at_ms BIGINT NOT NULL,
 UNIQUE KEY uq_import_correction_original(original_operation_id),
 UNIQUE KEY uq_import_correction_successor(successor_operation_id),
 UNIQUE KEY uq_import_correction_job(successor_job_id),
 KEY ix_import_correction_job(original_job_id,id)
) ENGINE=InnoDB;
