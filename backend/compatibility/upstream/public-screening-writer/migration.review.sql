-- Review-only native source ledger. Never run automatically or against a reader.
-- The shared screening reservation schema is a separate prerequisite.
CREATE TABLE pos_rewrite_public_screening_orders (
 operation_id VARCHAR(36) NOT NULL PRIMARY KEY,
 checkout_id VARCHAR(36) NOT NULL,
 actor_id VARCHAR(32) NOT NULL,
 customer_id VARCHAR(32) NOT NULL,
 store_id VARCHAR(32) NOT NULL,
 counter_id VARCHAR(32) NOT NULL,
 order_id VARCHAR(32) NOT NULL,
 request_hash VARCHAR(64) NOT NULL,
 data JSON NOT NULL,
 proof_hash VARCHAR(64) NOT NULL,
 UNIQUE KEY uq_public_screening_order(order_id),
 KEY ix_public_screening_checkout(checkout_id)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_public_screening_effects (
 operation_id VARCHAR(36) NOT NULL PRIMARY KEY,
 payload MEDIUMTEXT NOT NULL,
 effects_hash VARCHAR(64) NOT NULL,
 status VARCHAR(16) NOT NULL,
 deliveries JSON NOT NULL,
 created_at_ms BIGINT NOT NULL,
 updated_at_ms BIGINT NOT NULL
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_public_screening_abandonments (
 operation_id VARCHAR(36) NOT NULL PRIMARY KEY,
 command_id VARCHAR(36) NOT NULL,
 order_id VARCHAR(32) NOT NULL,
 actor_id VARCHAR(32) NOT NULL,
 data JSON NOT NULL,
 proof_hash VARCHAR(64) NOT NULL,
 UNIQUE KEY uq_public_screening_abandoned_order(order_id),
 UNIQUE KEY uq_public_screening_abandon_command(command_id)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_public_screening_completions (
 operation_id VARCHAR(36) NOT NULL PRIMARY KEY,
 order_id VARCHAR(32) NOT NULL,
 data JSON NOT NULL,
 proof_hash VARCHAR(64) NOT NULL,
 UNIQUE KEY uq_public_screening_completion_order(order_id)
) ENGINE=InnoDB;
-- Existing installations apply the matching additive negative-migration.sql.
CREATE TABLE IF NOT EXISTS pos_rewrite_public_screening_negatives (
 operation_id VARCHAR(36) NOT NULL PRIMARY KEY,
 checkout_id VARCHAR(36) NOT NULL,
 request_hash VARCHAR(64) NOT NULL,
 data JSON NOT NULL,
 proof_hash VARCHAR(64) NOT NULL
) ENGINE=InnoDB;
