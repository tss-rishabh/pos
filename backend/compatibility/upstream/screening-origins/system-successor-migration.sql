CREATE TABLE pos_rewrite_screening_origin_system_reference_heads(
 reference_hash VARCHAR(64) NOT NULL PRIMARY KEY,original_command_id VARCHAR(36) NOT NULL,
 active_command_id VARCHAR(36) NOT NULL UNIQUE,version BIGINT UNSIGNED NOT NULL,
 data JSON NOT NULL,proof_hash VARCHAR(64) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_screening_origin_system_successors(
 successor_id VARCHAR(36) NOT NULL PRIMARY KEY,parent_command_id VARCHAR(36) NOT NULL,
 reference_hash VARCHAR(64) NOT NULL,data JSON NOT NULL,proof_hash VARCHAR(64) NOT NULL,
 UNIQUE KEY uq_screening_origin_system_successor_parent(parent_command_id)
) ENGINE=InnoDB;
