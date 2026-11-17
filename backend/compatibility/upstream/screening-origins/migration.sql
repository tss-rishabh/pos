CREATE TABLE pos_rewrite_screening_origin_commands(
 id VARCHAR(36) NOT NULL PRIMARY KEY,origin VARCHAR(32) NOT NULL,customer_id BIGINT NOT NULL,
 actor_id BIGINT NULL,store_id BIGINT NULL,counter_id BIGINT NULL,phase VARCHAR(16) NOT NULL,
 order_id BIGINT NULL,data JSON NOT NULL,proof_hash VARCHAR(64) NOT NULL,
 KEY ix_screening_origin_customer(customer_id,id),UNIQUE KEY uq_screening_origin_order(order_id)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_screening_origin_creations(
 command_id VARCHAR(36) NOT NULL PRIMARY KEY,order_id BIGINT NOT NULL UNIQUE,
 data JSON NOT NULL,proof_hash VARCHAR(64) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_screening_origin_closures(
 command_id VARCHAR(36) NOT NULL PRIMARY KEY,data JSON NOT NULL,proof_hash VARCHAR(64) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_screening_origin_effects(
 command_id VARCHAR(36) NOT NULL PRIMARY KEY,payload MEDIUMTEXT NOT NULL,effects_hash VARCHAR(64) NOT NULL,
 phase VARCHAR(16) NOT NULL,deliveries JSON NOT NULL,updated_at_ms BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_screening_origin_payments(
 order_id BIGINT NOT NULL PRIMARY KEY,command_id VARCHAR(36) NOT NULL UNIQUE,
 data JSON NOT NULL,proof_hash VARCHAR(64) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_screening_origin_staff_grants(
 id VARCHAR(36) NOT NULL PRIMARY KEY,actor_id BIGINT NOT NULL,session_hash VARCHAR(64) NOT NULL,
 data JSON NOT NULL,proof_hash VARCHAR(64) NOT NULL,revoked TINYINT NOT NULL DEFAULT 0,
 KEY ix_screening_origin_staff_session(session_hash,id)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_screening_origin_histories(
 command_id VARCHAR(36) NOT NULL PRIMARY KEY,data JSON NOT NULL,proof_hash VARCHAR(64) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_screening_origin_sessions(
 id VARCHAR(36) NOT NULL PRIMARY KEY,origin VARCHAR(32) NOT NULL,actor_id BIGINT NOT NULL,
 session_hash VARCHAR(64) NOT NULL UNIQUE,data JSON NOT NULL,proof_hash VARCHAR(64) NOT NULL,revoked TINYINT NOT NULL DEFAULT 0,
 KEY ix_screening_origin_actor_session(actor_id,id)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_screening_origin_legacy_work(
 command_id VARCHAR(36) NOT NULL PRIMARY KEY,data JSON NOT NULL,proof_hash VARCHAR(64) NOT NULL,
 response_payload MEDIUMTEXT NULL
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_screening_origin_legacy_cash(
 command_id VARCHAR(36) NOT NULL PRIMARY KEY,order_id BIGINT NOT NULL UNIQUE,
 data JSON NOT NULL,proof_hash VARCHAR(64) NOT NULL,effects JSON NOT NULL,phase VARCHAR(16) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_screening_origin_services(
 id VARCHAR(32) NOT NULL PRIMARY KEY,data JSON NOT NULL,proof_hash VARCHAR(64) NOT NULL,revoked TINYINT NOT NULL DEFAULT 0
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_screening_origin_system_authorities(
 command_id VARCHAR(36) NOT NULL PRIMARY KEY,data JSON NOT NULL,proof_hash VARCHAR(64) NOT NULL
) ENGINE=InnoDB;
