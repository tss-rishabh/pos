CREATE TABLE pos_rewrite_screening_origin_legacy_effect_attempts(
 command_id VARCHAR(36) NOT NULL,ordinal INT NOT NULL,effect_id VARCHAR(64) NOT NULL UNIQUE,
 data JSON NOT NULL,proof_hash VARCHAR(64) NOT NULL,PRIMARY KEY(command_id,ordinal)
) ENGINE=InnoDB;
