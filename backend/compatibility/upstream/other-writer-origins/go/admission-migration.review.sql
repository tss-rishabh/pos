-- Review-only additive Go dispatcher fence. This does not undo or certify
-- absence of the already-staged original source order, wallet or benefits.
CREATE TABLE pos_rewrite_screening_origin_payment_no_effects (
 command_id VARCHAR(36) NOT NULL PRIMARY KEY,
 order_id BIGINT NOT NULL UNIQUE,
 data JSON NOT NULL,
 proof_hash VARCHAR(64) NOT NULL
) ENGINE=InnoDB;
