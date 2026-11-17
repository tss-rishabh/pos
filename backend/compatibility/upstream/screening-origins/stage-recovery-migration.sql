-- REVIEW ONLY. Source-issued same-attempt recovery receipts; no runtime DDL.
-- Install after origin commands/creations and the Go immutable payment journal,
-- before other-writer-origins/go/stage-recovery-migration.review.sql uses.
-- Source issuer may INSERT/SELECT only. Never UPDATE/DELETE or reuse an id to
-- extend its lifetime. Go reads the sealed row and owns its separate use table.
CREATE TABLE pos_rewrite_screening_origin_stage_recoveries (
 recovery_id VARCHAR(36) NOT NULL PRIMARY KEY,
 command_id VARCHAR(36) NOT NULL,
 order_id BIGINT NOT NULL,
 data JSON NOT NULL,
 proof_hash VARCHAR(64) NOT NULL,
 KEY ix_screening_origin_stage_recovery(command_id,recovery_id)
) ENGINE=InnoDB;
