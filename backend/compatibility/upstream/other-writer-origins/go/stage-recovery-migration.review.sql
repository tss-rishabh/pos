-- Review-only, after source screening-origins/stage-recovery migration and
-- the immutable original payment journal. Never executed by runtime code.
CREATE TABLE pos_rewrite_screening_origin_stage_recovery_uses (
 recovery_id VARCHAR(36) NOT NULL PRIMARY KEY,
 command_id VARCHAR(36) NOT NULL,
 order_id BIGINT NOT NULL,
 data JSON NOT NULL,
 proof_hash VARCHAR(64) NOT NULL,
 KEY ix_screening_origin_stage_recovery_command(command_id,recovery_id)
) ENGINE=InnoDB;
