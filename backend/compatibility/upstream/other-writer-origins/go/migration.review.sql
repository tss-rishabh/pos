-- Explicit reviewed source-payments deployment only. Never runtime DDL.
-- Requires screening-origins/migration.sql, the shared screening projection
-- review migrations/qualified baseline, and ordinary gift issuance evidence.
CREATE TABLE pos_rewrite_screening_origin_payment_attempts (
 command_id VARCHAR(36) NOT NULL PRIMARY KEY,
 order_id BIGINT NOT NULL,
 customer_id BIGINT NOT NULL,
 phase VARCHAR(16) NOT NULL,
 data JSON NOT NULL,
 proof_hash VARCHAR(64) NOT NULL,
 payload MEDIUMTEXT NOT NULL,
 response MEDIUMTEXT NULL,
 UNIQUE KEY uq_screening_origin_payment_order(order_id),
 KEY ix_screening_origin_payment_customer(customer_id,command_id)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_screening_origin_payment_observations (
 id VARCHAR(64) NOT NULL PRIMARY KEY,
 command_id VARCHAR(36) NOT NULL,
 order_id BIGINT NOT NULL,
 data JSON NOT NULL,
 proof_hash VARCHAR(64) NOT NULL,
 payload MEDIUMTEXT NOT NULL,
 KEY ix_screening_origin_observation_order(order_id,id),
 KEY ix_screening_origin_observation_command(command_id,id)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_screening_origin_payment_outcomes (
 command_id VARCHAR(36) NOT NULL,
 observation_hash VARCHAR(64) NOT NULL,
 order_id BIGINT NOT NULL,
 data JSON NOT NULL,
 proof_hash VARCHAR(64) NOT NULL,
 PRIMARY KEY(command_id,observation_hash),
 KEY ix_screening_origin_outcome_order(order_id,command_id)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_screening_origin_payment_events (
 id VARCHAR(64) NOT NULL PRIMARY KEY,
 command_id VARCHAR(36) NOT NULL,
 payment_id BIGINT NOT NULL,
 UNIQUE KEY uq_screening_origin_native_payment(payment_id),
 KEY ix_screening_origin_event_command(command_id,id)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_screening_origin_funding_declarations (
 command_id VARCHAR(36) NOT NULL PRIMARY KEY,
 order_id BIGINT NOT NULL UNIQUE,
 data JSON NOT NULL,
 proof_hash VARCHAR(64) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_screening_origin_asset_activations (
 command_id VARCHAR(36) NOT NULL PRIMARY KEY,
 order_id BIGINT NOT NULL UNIQUE,
 data JSON NOT NULL,
 proof_hash VARCHAR(64) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_screening_origin_go_effects (
 id VARCHAR(64) NOT NULL PRIMARY KEY,
 command_id VARCHAR(36) NOT NULL,
 order_id BIGINT NOT NULL,
 kind VARCHAR(32) NOT NULL,
 priority TINYINT NOT NULL,
 sequence_no BIGINT NOT NULL,
 data JSON NOT NULL,
 proof_hash VARCHAR(64) NOT NULL,
 phase VARCHAR(16) NOT NULL,
 receipt JSON NULL,
 receipt_hash VARCHAR(64) NULL,
 updated_at_ms BIGINT UNSIGNED NOT NULL,
 KEY ix_screening_origin_effect_work(phase,updated_at_ms,id),
 KEY ix_screening_origin_effect_command(command_id,priority,sequence_no,id),
 UNIQUE KEY uq_screening_origin_effect_sequence(command_id,sequence_no)
) ENGINE=InnoDB;
