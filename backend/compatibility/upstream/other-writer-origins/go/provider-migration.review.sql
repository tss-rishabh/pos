-- Review-only, after the existing origin payment journal. A callback link is
-- evidence of actual provider identifiers, never a manufactured creation ACK.
CREATE TABLE pos_rewrite_screening_origin_gokwik_links (
 command_id VARCHAR(36) NOT NULL PRIMARY KEY,
 order_id BIGINT NOT NULL UNIQUE,
 data JSON NOT NULL,
 proof_hash VARCHAR(64) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_screening_origin_gokwik_native_events (
 command_id VARCHAR(36) NOT NULL PRIMARY KEY,
 order_id BIGINT NOT NULL UNIQUE,
 input_hash VARCHAR(64) NOT NULL,
 data JSON NOT NULL,
 proof_hash VARCHAR(64) NOT NULL
) ENGINE=InnoDB;
