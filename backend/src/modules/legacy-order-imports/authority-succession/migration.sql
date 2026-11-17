-- Additive rewrite-only ledger. Mandatory native fencing tables for future
-- financial stages, independent of the optional new-grant selector. No legacy
-- history, original order, request hash or actor/customer identity is rewritten.
CREATE TABLE IF NOT EXISTS pos_rewrite_import_authority_successions (
 id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 operation_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 sequence_no INT UNSIGNED NOT NULL,
 job_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 manager_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 manager_session_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 command_hash VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 data JSON NOT NULL, proof_hash VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 created_at_ms BIGINT NOT NULL,
 UNIQUE KEY uq_import_authority_sequence(operation_id,sequence_no),
 KEY ix_import_authority_job(job_id,operation_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_import_authority_heads (
 operation_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 grant_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 sequence_no INT UNSIGNED NOT NULL,
 source_hash VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 active_command_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
 proof_hash VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_import_authority_stage_claims (
 id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 operation_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 stage VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 grant_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 data JSON NOT NULL, source_hash VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 proof_hash VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 UNIQUE KEY uq_import_authority_stage(operation_id,stage,grant_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_import_authority_continuations (
 id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 operation_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 grant_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 manager_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 request_hash VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 data JSON NOT NULL, proof_hash VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 KEY ix_import_authority_continuation(operation_id,grant_id,id)
) ENGINE=InnoDB;
