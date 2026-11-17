CREATE TABLE pos_rewrite_screening_origin_local_effects(
 effect_id VARCHAR(64) NOT NULL PRIMARY KEY,command_id VARCHAR(36) NOT NULL,
 data JSON NOT NULL,proof_hash VARCHAR(64) NOT NULL,KEY ix_screening_origin_local_effect_command(command_id,effect_id)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_screening_origin_task_invocations(
 effect_id VARCHAR(64) NOT NULL,ordinal INT NOT NULL,command_id VARCHAR(36) NOT NULL,
 phase VARCHAR(16) NOT NULL,data JSON NOT NULL,proof_hash VARCHAR(64) NOT NULL,
 result_payload MEDIUMTEXT NULL,result_hash VARCHAR(64) NULL,
 PRIMARY KEY(effect_id,ordinal),KEY ix_screening_origin_task_command(command_id,effect_id)
) ENGINE=InnoDB;
CREATE INDEX ix_screening_origin_effect_queue ON pos_rewrite_screening_origin_effects(phase,updated_at_ms,command_id);
