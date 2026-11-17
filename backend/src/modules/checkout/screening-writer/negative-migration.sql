-- Additive review-only source nonce tombstone. Apply to the same writer as
-- source creation; never delete/replace a receipt to reopen an old command.
CREATE TABLE IF NOT EXISTS pos_rewrite_public_screening_negatives (
 operation_id VARCHAR(36) NOT NULL PRIMARY KEY,
 checkout_id VARCHAR(36) NOT NULL,
 request_hash VARCHAR(64) NOT NULL,
 data JSON NOT NULL,
 proof_hash VARCHAR(64) NOT NULL
) ENGINE=InnoDB;
