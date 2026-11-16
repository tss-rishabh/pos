CREATE TABLE IF NOT EXISTS pos_rewrite_operator_google_identities (
  subject VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  operator_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL,
  request_id VARCHAR(128) NULL,
  UNIQUE INDEX ux_google_identity_operator(operator_id)
) ENGINE=InnoDB;
