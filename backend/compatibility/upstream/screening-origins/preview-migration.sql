-- REVIEW: additive private cart-preview receipts; no source historical facts.
CREATE TABLE IF NOT EXISTS pos_rewrite_screening_origin_cart_previews (
 preview_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 customer_id BIGINT NOT NULL,
 data JSON NOT NULL,
 proof_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 payload MEDIUMTEXT CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 effects_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 phase VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 deliveries JSON NOT NULL,
 updated_at_ms BIGINT UNSIGNED NOT NULL,
 KEY ix_screening_origin_cart_preview_pending(phase,updated_at_ms,preview_id),
 KEY ix_screening_origin_cart_preview_customer(customer_id,preview_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS pos_rewrite_screening_origin_cart_tracking_calls (
 effect_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 command_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 data JSON NOT NULL,
 proof_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 KEY ix_screening_origin_cart_tracking_command(command_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS pos_rewrite_screening_origin_system_cart_prefixes (
 command_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 customer_id BIGINT NOT NULL,
 data JSON NOT NULL,
 proof_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 payload MEDIUMTEXT CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 KEY ix_screening_origin_system_cart_prefix_customer(customer_id,command_id)
) ENGINE=InnoDB;
