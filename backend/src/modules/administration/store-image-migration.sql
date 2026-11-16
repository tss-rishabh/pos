-- Rewrite-owned store image reservations/cleanup only. Apply explicitly to the writer.
CREATE TABLE IF NOT EXISTS pos_rewrite_store_image_uploads (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  owner_id VARCHAR(80) NOT NULL,
  kind VARCHAR(16) NOT NULL,
  object_key VARCHAR(254) NOT NULL,
  content_type VARCHAR(64) NOT NULL,
  size INT NOT NULL,
  checksum VARCHAR(44) NOT NULL,
  owner_revision VARCHAR(64) NOT NULL,
  state VARCHAR(16) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  attached_at DATETIME(3) NULL,
  INDEX ix_rewrite_store_image_owner(owner_id,state,expires_at),
  UNIQUE KEY uq_rewrite_store_image_key(object_key)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_store_image_jobs (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  upload_id VARCHAR(36) NOT NULL,
  owner_id VARCHAR(32) NOT NULL,
  request_id VARCHAR(36) NULL,
  state VARCHAR(16) NOT NULL,
  attempts INT NOT NULL,
  available_at DATETIME(3) NOT NULL,
  lease_token VARCHAR(36) NULL,
  lease_until DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  INDEX ix_rewrite_store_image_due(state,available_at,id),
  INDEX ix_rewrite_store_image_upload(upload_id,state)
) ENGINE=InnoDB;
