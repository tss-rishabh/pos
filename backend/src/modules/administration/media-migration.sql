-- Rewrite-owned tutorial revision/upload state only. Apply on the writer.
CREATE TABLE IF NOT EXISTS pos_rewrite_documentation_assets (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  object_key VARCHAR(1024) NOT NULL,
  object_digest VARCHAR(64) NOT NULL,
  actor_id VARCHAR(32) NOT NULL,
  request_id VARCHAR(128) NULL,
  document_id BIGINT UNSIGNED NULL,
  kind VARCHAR(20) NOT NULL,
  source VARCHAR(8) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  content_type VARCHAR(128) NOT NULL,
  size INT NOT NULL,
  checksum_sha256 VARCHAR(44) NULL,
  state VARCHAR(20) NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_documentation_object_digest(object_digest),
  INDEX ix_documentation_cleanup(state,expires_at,attempts),
  INDEX ix_documentation_assets_document(document_id,state),
  INDEX ix_documentation_blocked(state,id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_documentation_revisions (
  document_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  version INT NOT NULL,
  request_id VARCHAR(128) NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_documentation_mutations (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  actor_id VARCHAR(32) NOT NULL,
  request_id VARCHAR(128) NULL,
  request_hash VARCHAR(64) NOT NULL,
  document_id BIGINT UNSIGNED NOT NULL,
  version INT NOT NULL,
  created_at DATETIME(3) NOT NULL
) ENGINE=InnoDB;
INSERT IGNORE INTO pos_rewrite_administration_registries(resource) VALUES ('documentation');
