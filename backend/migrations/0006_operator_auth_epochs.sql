-- Monotonic revocation prevents old credentials becoming valid after a reversal.
CREATE TABLE pos_rewrite_operator_auth_epochs (
 operator_id VARCHAR(32) NOT NULL PRIMARY KEY,
 epoch BIGINT UNSIGNED NOT NULL DEFAULT 0
) ENGINE=InnoDB;
