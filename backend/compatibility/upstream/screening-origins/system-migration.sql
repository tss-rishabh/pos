CREATE TABLE pos_rewrite_screening_origin_system_jobs(
 command_id VARCHAR(36) NOT NULL PRIMARY KEY,data JSON NOT NULL,proof_hash VARCHAR(64) NOT NULL,
 payload MEDIUMTEXT NOT NULL,payload_hash VARCHAR(64) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_screening_origin_system_metadata(
 command_id VARCHAR(36) NOT NULL PRIMARY KEY,order_id BIGINT NOT NULL UNIQUE,data JSON NOT NULL,proof_hash VARCHAR(64) NOT NULL
) ENGINE=InnoDB;
