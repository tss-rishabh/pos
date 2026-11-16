CREATE TABLE IF NOT EXISTS pos_rewrite_profile_uploads (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  owner_id VARCHAR(32) NOT NULL,
  kind VARCHAR(16) NOT NULL,
  object_key VARCHAR(254) NOT NULL,
  content_type VARCHAR(64) NOT NULL,
  size INT NOT NULL,
  checksum VARCHAR(44) NOT NULL,
  profile_revision VARCHAR(64) NOT NULL,
  state VARCHAR(16) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  attached_at DATETIME(3) NULL,
  UNIQUE KEY uq_profile_upload_key (object_key),
  KEY ix_profile_upload_pending (owner_id, state, expires_at)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_profile_media_jobs (
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
  KEY ix_profile_media_pending (state, available_at, id),
  KEY ix_profile_media_leases (state, lease_until),
  KEY ix_profile_media_upload (upload_id)
) ENGINE=InnoDB;
