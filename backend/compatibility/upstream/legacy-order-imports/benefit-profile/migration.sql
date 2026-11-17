-- Rewrite-only cooperative birthday claim ledger. Never changes legacy tables.
-- NOT production-selected automatically: source Redis writers need the same
-- claim authority/cutover and retained live-key migration before activation.
CREATE TABLE IF NOT EXISTS pos_rewrite_import_birthday_guards (
  customer_id BIGINT NOT NULL PRIMARY KEY,
  operation_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at_ms BIGINT NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_import_birthday_claims (
  operation_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  claim_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  receipt JSON NOT NULL,
  proof_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
) ENGINE=InnoDB;
