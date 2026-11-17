CREATE TABLE pos_rewrite_screening_origin_system_preparations(
 command_id VARCHAR(36) NOT NULL PRIMARY KEY,customer_id BIGINT NOT NULL,
 data JSON NOT NULL,proof_hash VARCHAR(64) NOT NULL,payload MEDIUMTEXT NOT NULL,payload_hash VARCHAR(64) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_screening_origin_system_attempts(
 id VARCHAR(36) NOT NULL PRIMARY KEY,command_id VARCHAR(36) NOT NULL,
 phase VARCHAR(32) NOT NULL,data JSON NOT NULL,proof_hash VARCHAR(64) NOT NULL,
 KEY ix_screening_system_attempt(command_id,id)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_screening_origin_system_no_dispatch(
 attempt_id VARCHAR(36) NOT NULL PRIMARY KEY,command_id VARCHAR(36) NOT NULL,
 data JSON NOT NULL,proof_hash VARCHAR(64) NOT NULL,KEY ix_screening_system_closed(command_id,attempt_id)
) ENGINE=InnoDB;
ALTER TABLE pos_rewrite_screening_origin_system_jobs
 ADD state VARCHAR(32) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(data,'$.state'))) STORED,
 ADD updated_at_ms BIGINT GENERATED ALWAYS AS (CAST(JSON_UNQUOTE(JSON_EXTRACT(data,'$.updatedAt')) AS UNSIGNED)) STORED,
 ADD KEY ix_screening_system_job_queue(state,updated_at_ms,command_id);
